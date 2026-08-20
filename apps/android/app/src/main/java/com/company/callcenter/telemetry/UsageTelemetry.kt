package com.company.callcenter.telemetry

import android.content.Context
import android.os.Build
import com.company.callcenter.BuildConfig
import com.company.callcenter.data.AppMode
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
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
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.URI
import java.time.LocalDate
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
        consent: Boolean,
        mode: AppMode?,
        utcDate: String,
        lastAttemptDate: String?,
    ): Boolean = isValidEndpoint(endpoint) &&
        consent &&
        mode != null &&
        utcDate.isNotBlank() &&
        utcDate != lastAttemptDate
}

class UsageTelemetry(
    context: Context,
    endpoint: String = BuildConfig.TELEMETRY_URL,
) {
    private val normalizedEndpoint = endpoint.trim()
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val store = UsageTelemetryStore(context)
    val isAvailable: Boolean = UsageTelemetryPolicy.isValidEndpoint(normalizedEndpoint)
    private val client by lazy {
        OkHttpClient.Builder()
            .retryOnConnectionFailure(false)
            .callTimeout(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }
    private val gson by lazy { Gson() }
    private val mutableEnabled = MutableStateFlow(
        isAvailable &&
            preferences.getBoolean(CONSENT_KEY, false) &&
            preferences.getString(CONSENT_ENDPOINT_KEY, null) == normalizedEndpoint,
    )
    private val mutableConsentRequired = MutableStateFlow(
        isAvailable && !preferences.contains(CONSENT_KEY),
    )

    val enabled: StateFlow<Boolean> = mutableEnabled.asStateFlow()
    val consentRequired: StateFlow<Boolean> = mutableConsentRequired.asStateFlow()

    fun setEnabled(enabled: Boolean) {
        val accepted = isAvailable && enabled
        if (!accepted) mutableEnabled.value = false
        val persisted = preferences.edit()
            .putBoolean(CONSENT_KEY, accepted)
            .apply {
                if (accepted) putString(CONSENT_ENDPOINT_KEY, normalizedEndpoint)
                else remove(CONSENT_ENDPOINT_KEY)
            }
            .commit()
        if (persisted) mutableConsentRequired.value = false
        if (accepted) mutableEnabled.value = persisted
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

    private suspend fun uploadIfDue(mode: AppMode) {
        val utcDate = LocalDate.now(ZoneOffset.UTC).toString()
        val snapshot = synchronized(STORE_LOCK) {
            val lastAttemptDate = preferences.getString(LAST_UPLOAD_DATE_KEY, null)
            if (
                !UsageTelemetryPolicy.shouldAttempt(
                    endpoint = normalizedEndpoint,
                    consent = mutableEnabled.value,
                    mode = mode,
                    utcDate = utcDate,
                    lastAttemptDate = lastAttemptDate,
                )
            ) {
                return
            }
            val anonymousId = preferences.getString(ANONYMOUS_ID_KEY, null)
                ?.takeIf(String::isNotBlank)
                ?: UUID.randomUUID().toString()
            val persisted = preferences.edit().putString(ANONYMOUS_ID_KEY, anonymousId).commit()
            if (!persisted) return
            val metrics = store.pendingMetrics()
            UsageTelemetryPayload(
                anonymousId = anonymousId,
                date = utcDate,
                appVersion = BuildConfig.VERSION_NAME,
                androidApi = Build.VERSION.SDK_INT,
                mode = mode.name.lowercase(),
                locale = Locale.getDefault().toLanguageTag().ifBlank { "unknown" },
                timezone = ZoneId.systemDefault().id,
                dailyMetrics = metrics.map(UsageTelemetryMetricSnapshot::payload),
            ) to metrics
        }

        try {
            val request = Request.Builder()
                .url(normalizedEndpoint)
                .post(gson.toJson(snapshot.first).toRequestBody(JSON_MEDIA_TYPE))
                .build()
            client.newCall(request).awaitResponse().use { response ->
                if (!response.isSuccessful) throw IOException("Telemetry endpoint returned HTTP ${response.code}")
            }
            store.markUploaded(snapshot.second)
            preferences.edit().putString(LAST_UPLOAD_DATE_KEY, utcDate).commit()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Anonymous telemetry is best-effort and must never affect app workflows.
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
        const val CONSENT_KEY = "consent"
        const val CONSENT_ENDPOINT_KEY = "consent_endpoint"
        const val ANONYMOUS_ID_KEY = "anonymous_installation_id"
        const val LAST_UPLOAD_DATE_KEY = "last_upload_utc_date"
        const val REQUEST_TIMEOUT_SECONDS = 8L
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val STORE_LOCK = Any()
    }
}
