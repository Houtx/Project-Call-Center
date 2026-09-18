package com.company.callcenter.telemetry

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.company.callcenter.BuildConfig
import com.company.callcenter.data.AppMode
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal data class UsageTelemetryPayload(
    @SerializedName("anonymousId") val anonymousId: String,
    @SerializedName("date") val date: String,
    @SerializedName("appVersion") val appVersion: String,
    @SerializedName("androidApi") val androidApi: Int,
    @SerializedName("mode") val mode: String,
    @SerializedName("locale") val locale: String,
    @SerializedName("timezone") val timezone: String,
    @SerializedName("dailyMetrics") val dailyMetrics: List<UsageTelemetryDailyMetric>,
    @SerializedName("locations") val locations: List<UsageTelemetryDailyLocation> = emptyList(),
)

private data class UsageTelemetryUploadSnapshot(
    val payload: UsageTelemetryPayload,
    val metrics: List<UsageTelemetryMetricSnapshot>,
    val locations: List<UsageTelemetryLocationSnapshot>,
)

fun interface CallMetricsRecorder {
    fun record(eventId: String, mode: AppMode, result: String, durationSeconds: Int?, startedAtMillis: Long)

    companion object {
        val NOOP = CallMetricsRecorder { _, _, _, _, _ -> }
    }
}

internal object UsageTelemetryPolicy {
    fun isValidEndpoint(endpoint: String): Boolean {
        val uri = runCatching { URI(endpoint.trim()) }.getOrNull() ?: return false
        return uri.scheme.equals("https", ignoreCase = true) &&
            !uri.host.isNullOrBlank() &&
            (uri.port == -1 || uri.port in 1..65_535) &&
            uri.userInfo == null &&
            uri.fragment == null
    }

    fun shouldAttempt(
        endpoint: String,
        enabled: Boolean,
        mode: AppMode?,
        utcDate: String,
        lastAttemptDate: String?,
    ): Boolean = isValidEndpoint(endpoint) &&
        enabled &&
        mode != null &&
        utcDate.isNotBlank() &&
        utcDate != lastAttemptDate

    fun initialEnabled(
        endpointAvailable: Boolean,
        hasStoredPreference: Boolean,
        storedEnabled: Boolean,
        endpointMatches: Boolean,
        storedPolicyVersion: Int = CURRENT_POLICY_VERSION,
        currentPolicyVersion: Int = CURRENT_POLICY_VERSION,
    ): Boolean = endpointAvailable &&
        (
            storedPolicyVersion < currentPolicyVersion ||
                !hasStoredPreference ||
                storedEnabled && endpointMatches
        )

    const val CURRENT_POLICY_VERSION = 1
}

internal object UsageTelemetryDisablePolicy {
    fun isValid(password: String, date: LocalDate = LocalDate.now()): Boolean =
        password == date.format(DateTimeFormatter.BASIC_ISO_DATE)
}

internal object UsageTelemetryLocationPolicy {
    fun shouldAttempt(
        localDate: String,
        capturedDate: String?,
        attemptDate: String?,
        attemptCount: Int,
        lastAttemptMillis: Long,
        nowMillis: Long,
        maxAttempts: Int = 3,
        retryIntervalMillis: Long = 5 * 60 * 1_000L,
    ): Boolean {
        if (localDate.isBlank() || capturedDate == localDate) return false
        if (attemptDate != localDate) return true
        return attemptCount < maxAttempts && nowMillis - lastAttemptMillis >= retryIntervalMillis
    }
}

class UsageTelemetry(
    context: Context,
    endpoint: String = BuildConfig.TELEMETRY_URL,
) {
    private val appContext = context.applicationContext
    private val normalizedEndpoint = endpoint.trim()
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val store = UsageTelemetryStore(appContext)
    private val locationManager by lazy { appContext.getSystemService(LocationManager::class.java) }
    private val uploadMutex = Mutex()
    private val locationCaptureMutex = Mutex()
    private var telemetryScope: CoroutineScope? = null
    private var appMode: StateFlow<AppMode?>? = null
    val isAvailable: Boolean = UsageTelemetryPolicy.isValidEndpoint(normalizedEndpoint)
    private val client by lazy {
        OkHttpClient.Builder()
            .retryOnConnectionFailure(false)
            .callTimeout(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }
    private val gson by lazy { Gson() }
    private val mutableEnabled = MutableStateFlow(loadInitialEnabled())

    val enabled: StateFlow<Boolean> = mutableEnabled.asStateFlow()

    private fun loadInitialEnabled(): Boolean {
        val hasStoredPreference = preferences.contains(ENABLED_KEY)
        val enabled = UsageTelemetryPolicy.initialEnabled(
            endpointAvailable = isAvailable,
            hasStoredPreference = hasStoredPreference,
            storedEnabled = preferences.getBoolean(ENABLED_KEY, false),
            endpointMatches = preferences.getString(ENABLED_ENDPOINT_KEY, null) == normalizedEndpoint,
            storedPolicyVersion = preferences.getInt(POLICY_VERSION_KEY, 0),
        )
        if (!isAvailable) return false
        val storedPolicyVersion = preferences.getInt(POLICY_VERSION_KEY, 0)
        if (hasStoredPreference && storedPolicyVersion >= UsageTelemetryPolicy.CURRENT_POLICY_VERSION) {
            return enabled
        }
        val persisted = preferences.edit()
            .putBoolean(ENABLED_KEY, enabled)
            .putString(ENABLED_ENDPOINT_KEY, normalizedEndpoint)
            .putInt(POLICY_VERSION_KEY, UsageTelemetryPolicy.CURRENT_POLICY_VERSION)
            .commit()
        return enabled && persisted
    }

    fun setEnabled(enabled: Boolean) {
        val accepted = isAvailable && enabled
        if (!accepted) mutableEnabled.value = false
        val persisted = preferences.edit()
            .putBoolean(ENABLED_KEY, accepted)
            .putInt(POLICY_VERSION_KEY, UsageTelemetryPolicy.CURRENT_POLICY_VERSION)
            .apply {
                if (accepted) putString(ENABLED_ENDPOINT_KEY, normalizedEndpoint)
                else remove(ENABLED_ENDPOINT_KEY)
            }
            .commit()
        if (accepted) mutableEnabled.value = persisted
    }

    fun shouldRequestLocationPermission(): Boolean = isAvailable &&
        mutableEnabled.value &&
        !preferences.getBoolean(LOCATION_PERMISSION_REQUESTED_KEY, false) &&
        !hasLocationPermission()

    fun markLocationPermissionRequested() {
        preferences.edit().putBoolean(LOCATION_PERMISSION_REQUESTED_KEY, true).apply()
    }

    fun captureLocationOnFirstCall() {
        val scope = telemetryScope ?: return
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            locationCaptureMutex.withLock { captureLocationIfDue() }
        }
    }

    fun recordCall(
        eventId: String,
        mode: AppMode,
        result: String,
        durationSeconds: Int?,
        startedAtMillis: Long,
    ) {
        if (!mutableEnabled.value) return
        try {
            store.recordCall(eventId, mode, result, durationSeconds, startedAtMillis)
        } catch (_: Exception) {
            // Statistics must never interrupt call settlement or queue progression.
        }
    }

    fun start(scope: CoroutineScope, mode: StateFlow<AppMode?>): Job? {
        if (!isAvailable) return null
        telemetryScope = scope
        appMode = mode
        return scope.launchTelemetry(mode)
    }

    private fun CoroutineScope.launchTelemetry(mode: StateFlow<AppMode?>): Job =
        launch {
            combine(enabled, mode) { consent, selectedMode -> consent to selectedMode }
                .distinctUntilChanged()
                .collectLatest { (consent, selectedMode) ->
                    if (consent && selectedMode != null) uploadIfDue(selectedMode)
                }
        }

    private suspend fun uploadIfDue(mode: AppMode) = uploadMutex.withLock {
        val utcDate = LocalDate.now(ZoneOffset.UTC).toString()
        val snapshot = synchronized(STORE_LOCK) {
            val lastAttemptDate = preferences.getString(LAST_UPLOAD_DATE_KEY, null)
            val metrics = store.pendingMetrics()
            val locations = store.pendingLocations()
            if (
                !UsageTelemetryPolicy.shouldAttempt(
                    endpoint = normalizedEndpoint,
                    enabled = mutableEnabled.value,
                    mode = mode,
                    utcDate = utcDate,
                    lastAttemptDate = lastAttemptDate,
                ) && metrics.isEmpty() && locations.isEmpty()
            ) {
                return@withLock
            }
            val anonymousId = preferences.getString(ANONYMOUS_ID_KEY, null)
                ?.takeIf(String::isNotBlank)
                ?: UUID.randomUUID().toString()
            val persisted = preferences.edit().putString(ANONYMOUS_ID_KEY, anonymousId).commit()
            if (!persisted) return
            UsageTelemetryUploadSnapshot(
                payload = UsageTelemetryPayload(
                    anonymousId = anonymousId,
                    date = utcDate,
                    appVersion = BuildConfig.VERSION_NAME,
                    androidApi = Build.VERSION.SDK_INT,
                    mode = mode.name.lowercase(),
                    locale = Locale.getDefault().toLanguageTag().ifBlank { "unknown" },
                    timezone = ZoneId.systemDefault().id,
                    dailyMetrics = metrics.map(UsageTelemetryMetricSnapshot::payload),
                    locations = locations.map(UsageTelemetryLocationSnapshot::payload),
                ),
                metrics = metrics,
                locations = locations,
            )
        }

        try {
            val request = Request.Builder()
                .url(normalizedEndpoint)
                .post(gson.toJson(snapshot.payload).toRequestBody(JSON_MEDIA_TYPE))
                .build()
            client.newCall(request).awaitResponse().use { response ->
                if (!response.isSuccessful) throw IOException("Telemetry endpoint returned HTTP ${response.code}")
            }
            store.markUploaded(snapshot.metrics)
            store.markLocationsUploaded(snapshot.locations)
            preferences.edit().putString(LAST_UPLOAD_DATE_KEY, utcDate).commit()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Anonymous telemetry is best-effort and must never affect app workflows.
        }
    }

    private suspend fun captureLocationIfDue() {
        if (!mutableEnabled.value || !hasLocationPermission()) return
        val localDate = LocalDate.now().toString()
        val nowMillis = System.currentTimeMillis()
        val attemptDate = preferences.getString(LOCATION_ATTEMPT_DATE_KEY, null)
        val attemptCount = if (attemptDate == localDate) {
            preferences.getInt(LOCATION_ATTEMPT_COUNT_KEY, 0)
        } else {
            0
        }
        if (
            !UsageTelemetryLocationPolicy.shouldAttempt(
                localDate = localDate,
                capturedDate = preferences.getString(LOCATION_CAPTURED_DATE_KEY, null),
                attemptDate = attemptDate,
                attemptCount = attemptCount,
                lastAttemptMillis = preferences.getLong(LOCATION_LAST_ATTEMPT_KEY, 0L),
                nowMillis = nowMillis,
            )
        ) {
            return
        }
        preferences.edit()
            .putString(LOCATION_ATTEMPT_DATE_KEY, localDate)
            .putInt(LOCATION_ATTEMPT_COUNT_KEY, attemptCount + 1)
            .putLong(LOCATION_LAST_ATTEMPT_KEY, nowMillis)
            .apply()

        val location = runCatching { acquireBestLocation() }.getOrNull() ?: return
        val latitudeE7 = (location.latitude * E7_SCALE).toLong()
        val longitudeE7 = (location.longitude * E7_SCALE).toLong()
        if (latitudeE7 !in -900_000_000L..900_000_000L || longitudeE7 !in -1_800_000_000L..1_800_000_000L) {
            return
        }
        store.recordLocation(
            UsageTelemetryDailyLocation(
                date = localDate,
                latitudeE7 = latitudeE7,
                longitudeE7 = longitudeE7,
                accuracyMeters = location.accuracy.coerceIn(0f, MAX_ACCURACY_METERS),
                capturedAt = Instant.ofEpochMilli(location.time).toString(),
            ),
        )
        preferences.edit().putString(LOCATION_CAPTURED_DATE_KEY, localDate).apply()
        appMode?.value?.let { uploadIfDue(it) }
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    private suspend fun acquireBestLocation(): Location? = suspendCancellableCoroutine { continuation ->
        // The caller verifies location permission; each provider call also catches revocation races.
        val handler = Handler(Looper.getMainLooper())
        val listeners = mutableListOf<LocationListener>()
        var currentBest: Location? = null
        var completed = false
        val nowMillis = System.currentTimeMillis()
        var lastKnownBest: Location? = null

        fun better(candidate: Location, current: Location?): Location {
            if (current == null) return candidate
            val candidateNewer = candidate.time - current.time
            return when {
                candidateNewer > LOCATION_RECENCY_TOLERANCE_MILLIS -> candidate
                candidateNewer < -LOCATION_RECENCY_TOLERANCE_MILLIS -> current
                candidate.accuracy < current.accuracy -> candidate
                else -> current
            }
        }

        fun usable(location: Location, maximumAgeMillis: Long): Boolean =
            location.latitude.isFinite() &&
                location.longitude.isFinite() &&
                location.latitude in -90.0..90.0 &&
                location.longitude in -180.0..180.0 &&
                location.hasAccuracy() &&
                location.accuracy in 0f..MAX_ACCURACY_METERS &&
                nowMillis - location.time in 0..maximumAgeMillis

        lateinit var timeout: Runnable
        fun finish(result: Location?) {
            if (completed) return
            completed = true
            handler.removeCallbacks(timeout)
            listeners.forEach { listener -> runCatching { locationManager.removeUpdates(listener) } }
            if (continuation.isActive) continuation.resume(result)
        }

        timeout = Runnable { finish(currentBest ?: lastKnownBest) }
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { provider -> runCatching { locationManager.isProviderEnabled(provider) }.getOrDefault(false) }
        providers.forEach { provider ->
            runCatching { locationManager.getLastKnownLocation(provider) }
                .getOrNull()
                ?.takeIf { usable(it, LAST_KNOWN_MAX_AGE_MILLIS) }
                ?.let { lastKnownBest = better(it, lastKnownBest) }
            val listener = LocationListener { location ->
                if (!usable(location, CURRENT_LOCATION_MAX_AGE_MILLIS)) return@LocationListener
                currentBest = better(location, currentBest)
                if (location.accuracy <= PREFERRED_ACCURACY_METERS) finish(currentBest)
            }
            runCatching {
                locationManager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
                listeners.add(listener)
            }
        }
        continuation.invokeOnCancellation {
            handler.post {
                if (!completed) {
                    completed = true
                    handler.removeCallbacks(timeout)
                    listeners.forEach { listener -> runCatching { locationManager.removeUpdates(listener) } }
                }
            }
        }
        if (listeners.isEmpty()) {
            finish(lastKnownBest)
        } else {
            handler.postDelayed(timeout, LOCATION_TIMEOUT_MILLIS)
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun Call.awaitResponse(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                if (continuation.isActive) {
                    continuation.resume(response) { response.close() }
                } else {
                    response.close()
                }
            }
        })
    }

    private companion object {
        const val PREFERENCES_NAME = "usage_telemetry"
        const val ENABLED_KEY = "consent"
        const val ENABLED_ENDPOINT_KEY = "consent_endpoint"
        const val POLICY_VERSION_KEY = "policy_version"
        const val ANONYMOUS_ID_KEY = "anonymous_installation_id"
        const val LAST_UPLOAD_DATE_KEY = "last_upload_utc_date"
        const val LOCATION_PERMISSION_REQUESTED_KEY = "location_permission_requested"
        const val LOCATION_CAPTURED_DATE_KEY = "location_captured_local_date"
        const val LOCATION_ATTEMPT_DATE_KEY = "location_attempt_local_date"
        const val LOCATION_ATTEMPT_COUNT_KEY = "location_attempt_count"
        const val LOCATION_LAST_ATTEMPT_KEY = "location_last_attempt_millis"
        const val REQUEST_TIMEOUT_SECONDS = 8L
        const val LOCATION_TIMEOUT_MILLIS = 10_000L
        const val CURRENT_LOCATION_MAX_AGE_MILLIS = 2 * 60 * 1_000L
        const val LAST_KNOWN_MAX_AGE_MILLIS = 12 * 60 * 60 * 1_000L
        const val LOCATION_RECENCY_TOLERANCE_MILLIS = 2 * 60 * 1_000L
        const val PREFERRED_ACCURACY_METERS = 50f
        const val MAX_ACCURACY_METERS = 50_000f
        const val E7_SCALE = 10_000_000.0
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val STORE_LOCK = Any()
    }
}
