package com.company.callcenter.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.company.callcenter.BuildConfig
import com.company.callcenter.data.local.AssignedCustomerEntity
import com.company.callcenter.data.local.CallCenterDao
import com.company.callcenter.data.local.CallHistoryEntity
import com.company.callcenter.data.local.PendingCallEntity
import com.company.callcenter.data.remote.CallAttemptRequest
import com.company.callcenter.data.remote.CallCenterApi
import com.company.callcenter.data.remote.CallObservation
import com.company.callcenter.data.remote.CallObservationBatch
import com.company.callcenter.data.remote.HeartbeatRequest
import com.company.callcenter.data.remote.LoginRequest
import com.company.callcenter.data.remote.LoginDevice
import com.company.callcenter.data.remote.RefreshTokenRequest
import com.company.callcenter.data.remote.ApiFactory
import com.company.callcenter.data.remote.ApiProblemParser
import com.company.callcenter.data.remote.ServerEndpoint
import com.company.callcenter.telephony.CallObservationPolicy
import com.company.callcenter.telephony.CallLogReader
import com.company.callcenter.telephony.CallRecorder
import com.company.callcenter.telephony.CallRecordingService
import com.company.callcenter.telemetry.CallMetricsRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import retrofit2.HttpException
import java.io.IOException
import java.time.Instant
import java.util.UUID

enum class DialSource {
    ONLINE,
    OFFLINE,
}

data class DialAuthorization(
    val attemptId: String,
    val phone: String,
    val recordingRequested: Boolean,
    val source: DialSource = DialSource.ONLINE,
    val systemManagedRouting: Boolean = false,
)

data class PendingCallRecoveryResult(
    val recoveredCount: Int,
    val abandonedRecordingCount: Int = 0,
    val remainingCount: Int = 0,
)

class CallCenterRepository(
    private val context: Context,
    private val dao: CallCenterDao,
    private val apiFactory: ApiFactory,
    private val session: SessionStore,
    private val callLogReader: CallLogReader,
    private val callRecorder: CallRecorder,
    private val callMetricsRecorder: CallMetricsRecorder = CallMetricsRecorder.NOOP,
) {
    private val tokenRefreshMutex = Mutex()
    private val serverConfigurationMutex = Mutex()
    private val defaultServerSuggestion = session.lastServerUrl
        ?: BuildConfig.DEFAULT_API_URL.trim().takeIf(String::isNotBlank)
    private val _serverConnection = MutableStateFlow(
        session.configuredServerUrl?.let {
            ServerConnectionState(
                status = ServerConnectionStatus.UNVERIFIED,
                configuredUrl = it,
                suggestedUrl = it,
            )
        } ?: ServerConnectionState(
            status = ServerConnectionStatus.NOT_CONFIGURED,
            suggestedUrl = defaultServerSuggestion,
        ),
    )
    private val _maxCallAttempts = MutableStateFlow(DEFAULT_MAX_CALL_ATTEMPTS)

    val assignments: Flow<List<AssignedCustomerEntity>> = dao.observeAssignments()
        .map(AssignmentQueuePolicy::order)
    val history: Flow<List<CallHistoryEntity>> = dao.observeHistory()
    val hasPendingCall: Flow<Boolean> = dao.observeHasPendingCall()
    val serverConnection: StateFlow<ServerConnectionState> = _serverConnection.asStateFlow()
    val maxCallAttempts: StateFlow<Int> = _maxCallAttempts.asStateFlow()

    fun statistics(range: CallStatisticsRange): Flow<CallStatistics> =
        dao.observeStatistics(range.sinceMillis(System.currentTimeMillis())).map { row ->
            CallStatistics(
                callCount = row.callCount,
                customerCount = row.customerCount,
                connectedCount = row.connectedCount,
                notConnectedCount = row.notConnectedCount,
                unknownCount = row.unknownCount,
                totalDurationSeconds = row.totalDurationSeconds,
                averageDurationSeconds = row.averageDurationSeconds,
                maximumDurationSeconds = row.maximumDurationSeconds,
            )
        }

    val isLoggedIn: Boolean
        get() = session.configuredServerUrl != null && session.accessToken != null && session.deviceId != null
    val displayName: String? get() = session.displayName

    suspend fun configureServer(rawAddress: String): String = withContext(Dispatchers.IO) {
        serverConfigurationMutex.withLock {
            val previousState = _serverConnection.value
            val candidate = runCatching {
                ServerEndpoint.normalize(rawAddress, allowCleartext = BuildConfig.DEBUG)
            }.getOrNull()
            _serverConnection.value = ServerConnectionState(
                status = ServerConnectionStatus.VERIFYING,
                configuredUrl = session.configuredServerUrl,
                suggestedUrl = candidate ?: rawAddress.trim().takeIf(String::isNotBlank),
            )

            val normalized = try {
                apiFactory.verifyServer(rawAddress)
            } catch (cancelled: CancellationException) {
                _serverConnection.value = previousState
                throw cancelled
            } catch (error: Throwable) {
                val currentUrl = session.configuredServerUrl
                if (currentUrl != null) {
                    _serverConnection.value = previousState
                } else {
                    invalidateServerConfiguration(
                        candidate ?: rawAddress.trim().takeIf(String::isNotBlank),
                        error,
                    )
                }
                throw error.asServerVerificationException()
            }

            val previousServerUrl = session.configuredServerUrl ?: session.lastServerUrl
            if (previousServerUrl != null && previousServerUrl != normalized) {
                val pendingCount = dao.pendingCalls().size
                if (pendingCount > 0) {
                    _serverConnection.value = previousState
                    throw PendingCallsBlockServerChangeException(pendingCount, previousServerUrl)
                }
                session.clearForServerChange()
                dao.clearAll()
                _maxCallAttempts.value = DEFAULT_MAX_CALL_ATTEMPTS
            }

            session.saveServerConfiguration(normalized)
            apiFactory.invalidateCache()
            _serverConnection.value = ServerConnectionState(
                status = ServerConnectionStatus.READY,
                configuredUrl = normalized,
                suggestedUrl = normalized,
            )
            normalized
        }
    }

    suspend fun validateServerConfiguration(): String = withContext(Dispatchers.IO) {
        serverConfigurationMutex.withLock { validateConfiguredServerLocked() }
    }

    suspend fun login(username: String, password: String) = withContext(Dispatchers.IO) {
        serverCall { api ->
            val response = api.login(
                LoginRequest(
                    username = username.trim(),
                    password = password,
                    device = LoginDevice(
                        installId = session.installId,
                        manufacturer = Build.MANUFACTURER,
                        model = Build.MODEL,
                        androidVersion = Build.VERSION.RELEASE,
                        androidSdk = Build.VERSION.SDK_INT,
                        appVersion = BuildConfig.VERSION_NAME,
                        appVersionCode = BuildConfig.VERSION_CODE,
                    ),
                ),
            )
            session.accessToken = response.accessToken
            session.refreshToken = response.refreshToken
            session.accessExpiresAt = System.currentTimeMillis() + response.expiresIn * 1_000L
            session.deviceId = response.deviceId
            session.displayName = response.user.name
            try {
                val serverUrl = checkNotNull(session.configuredServerUrl)
                val policy = apiFactory.api(serverUrl, response.accessToken).bootstrap()
                validateCompatibilityPolicy(policy)
                response
            } catch (cancelled: CancellationException) {
                session.clearAuthentication()
                throw cancelled
            } catch (error: Throwable) {
                session.clearAuthentication()
                throw error
            }
        }
    }

    suspend fun logout() {
        serverConfigurationMutex.withLock {
            try {
                val serverUrl = session.configuredServerUrl
                val refreshToken = session.refreshToken
                if (serverUrl != null && refreshToken != null) {
                    try {
                        apiFactory.api(serverUrl, session.accessToken)
                            .logout(RefreshTokenRequest(refreshToken))
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Throwable) {
                        // Local logout still proceeds when revocation cannot reach the server.
                    }
                }
            } finally {
                session.clear()
                apiFactory.invalidateCache()
                dao.clearAll()
                _maxCallAttempts.value = DEFAULT_MAX_CALL_ATTEMPTS
            }
        }
    }

    suspend fun refreshSession() = withContext(Dispatchers.IO) {
        tokenRefreshMutex.withLock {
            if (session.accessToken != null && session.accessExpiresAt > System.currentTimeMillis() + 5 * 60_000L) {
                return@withLock
            }
            val refreshToken = session.refreshToken ?: return@withLock
            serverCall { api ->
                api.refresh(RefreshTokenRequest(refreshToken)).also { response ->
                    session.accessToken = response.accessToken
                    session.refreshToken = response.refreshToken
                    session.accessExpiresAt = System.currentTimeMillis() + response.expiresIn * 1_000L
                    apiFactory.invalidateCache()
                }
            }
        }
    }

    suspend fun sync() = withContext(Dispatchers.IO) {
        serverCall { api ->
            api.sync(session.syncCursor).also { response ->
                _maxCallAttempts.value = response.maxCallAttempts.coerceIn(1, MAX_CALL_ATTEMPTS)
                val upserts = response.changes.mapNotNull { change ->
                    if (change.operation != "UPSERT") return@mapNotNull null
                    val item = change.assignment ?: return@mapNotNull null
                    AssignedCustomerEntity(
                        assignmentId = item.assignmentId,
                        customerId = item.customerId,
                        name = item.name?.takeIf(String::isNotBlank) ?: "未命名客户",
                        phoneMasked = item.phoneMasked,
                        batchName = item.batchName,
                        province = item.province,
                        city = item.city,
                        carrier = item.carrier,
                        notes = item.notes,
                        tags = item.tags.joinToString("|"),
                        attemptCount = item.attemptCount,
                        nextCallAllowedAt = item.nextCallAllowedAt?.toEpochMillis(),
                        lastCalledAt = item.lastCalledAt?.toEpochMillis(),
                        state = item.state,
                        updatedAt = item.updatedAt.toEpochMillis(),
                    )
                }
                val removals = response.changes
                    .filter { it.operation == "REMOVE" && it.entityType == "ASSIGNMENT" }
                    .map { it.entityId }
                dao.applySync(upserts, removals)
                session.syncCursor = response.cursor
            }
        }
    }

    suspend fun validateCompatibility() = withContext(Dispatchers.IO) {
        serverCall { api -> validateCompatibilityPolicy(api.bootstrap()) }
    }

    private fun validateCompatibilityPolicy(policy: com.company.callcenter.data.remote.BootstrapResponse) {
        _maxCallAttempts.value = policy.maxCallAttempts.coerceIn(1, MAX_CALL_ATTEMPTS)
        check(policy.device.compatible) {
            when (policy.device.reason) {
                "DEVICE_NOT_ALLOWLISTED" -> "当前机型未通过兼容性验证"
                "APP_UPDATE_REQUIRED" -> "当前 APP 版本过低，请升级后继续"
                else -> "当前设备未启用外呼"
            }
        }
        check(!policy.forceUpgrade) {
            "当前版本已停用，请升级 APP${policy.downloadUrl?.let { "：$it" }.orEmpty()}"
        }
    }

    suspend fun revealPhone(assignmentId: String): String = withContext(Dispatchers.IO) {
        serverCall { api -> api.revealPhone(assignmentId) }.phone
    }

    suspend fun revealHistoryPhone(attemptId: String): String = withContext(Dispatchers.IO) {
        serverCall { api -> api.revealHistoryPhone(attemptId) }.phone
    }

    suspend fun authorizeCall(
        assignmentId: String,
        systemManagedRouting: Boolean = false,
    ): DialAuthorization = withContext(Dispatchers.IO) {
        checkRequiredPermissions()
        val baselineId = callLogReader.latestOutgoingId()
        val initiatedAt = System.currentTimeMillis()
        serverCall { api ->
            val response = api.createCallAttempt(
                CallAttemptRequest(
                    assignmentId = assignmentId,
                    clientAttemptId = UUID.randomUUID().toString(),
                    callLogBaselineId = baselineId.toString(),
                    callLogBaselineAt = Instant.ofEpochMilli(initiatedAt).toString(),
                    systemManagedRouting = systemManagedRouting,
                ),
            )
            dao.upsertPendingCall(
                PendingCallEntity(
                    attemptId = response.attemptId,
                    assignmentId = assignmentId,
                    encryptedPhone = session.encryptPhone(response.phone),
                    callLogBaselineId = baselineId,
                    initiatedAt = initiatedAt,
                    deadlineAt = response.collectionDeadlineAt.toEpochMillis(),
                    recordingRequested = response.recordingRequested,
                ),
            )
            DialAuthorization(
                response.attemptId,
                response.phone,
                response.recordingRequested,
                systemManagedRouting = systemManagedRouting,
            )
        }
    }

    suspend fun cancelFailedCallAttempt(attemptId: String) = withContext(Dispatchers.IO) {
        val cancelled = serverCall { api -> api.cancelCallAttempt(attemptId).cancelled }
        check(cancelled) { "服务器未能撤销外呼尝试" }
        dao.deletePendingCall(attemptId)
    }

    suspend fun settleUnobservedCallAttempt(attemptId: String): Boolean = withContext(Dispatchers.IO) {
        val completed = serverConfigurationMutex.withLock {
            if (session.accessToken == null) return@withLock false
            val response = runCatching {
                serverCallLocked { api -> api.settleUnobservedCallAttempt(attemptId) }
            }.getOrNull() ?: return@withLock false
            val terminalStatus = response.status.takeIf {
                it == "CONNECTED" || it == "NOT_CONNECTED" || it == "UNKNOWN"
            }
            if (!response.settled && terminalStatus == null) return@withLock false
            val pending = dao.pendingCall(attemptId) ?: return@withLock true
            if (pending.state == "RESULT_SYNCED") {
                val recordingSettled = !pending.recordingRequested || finishRecordingLocked(pending.attemptId)
                if (recordingSettled) dao.deletePendingCall(pending.attemptId)
                return@withLock true
            }
            val assignment = dao.assignment(pending.assignmentId)
            val observedAt = System.currentTimeMillis()
            dao.upsertHistory(
                CallHistoryEntity(
                    attemptId = pending.attemptId,
                    assignmentId = pending.assignmentId,
                    customerName = assignment?.name ?: "客户",
                    phoneMasked = assignment?.phoneMasked ?: "***",
                    status = terminalStatus ?: "UNKNOWN",
                    startedAt = pending.initiatedAt,
                    durationSeconds = if (terminalStatus == "NOT_CONNECTED") 0 else null,
                    syncedAt = observedAt,
                ),
            )
            callMetricsRecorder.record(
                pending.attemptId,
                AppMode.ONLINE,
                terminalStatus ?: "UNKNOWN",
                if (terminalStatus == "NOT_CONNECTED") 0 else null,
                pending.initiatedAt,
            )
            dao.markCallResultSynced(pending.attemptId)
            val recordingSettled = !pending.recordingRequested || finishRecordingLocked(pending.attemptId)
            if (recordingSettled) dao.deletePendingCall(pending.attemptId)
            true
        }
        if (completed) {
            runCatching { sync() }
        }
        completed
    }

    suspend fun forceRecoverPendingCalls(): PendingCallRecoveryResult = withContext(Dispatchers.IO) {
        val initialCount = dao.pendingCalls().size
        reconcilePending()

        dao.pendingCalls()
            .filter { it.state == "COLLECTING" }
            .forEach { pending -> settleUnobservedCallAttempt(pending.attemptId) }

        val recordingPending = dao.pendingCalls().filter { it.state == "RESULT_SYNCED" }
        if (recordingPending.isNotEmpty()) {
            discardRecording()
            recordingPending.forEach { pending ->
                pending.recordingPath?.let { path -> runCatching { java.io.File(path).delete() } }
                if (pending.recordingRequested) {
                    try {
                        markRecordingUnsupported(pending.attemptId, "USER_FORCED_RECOVERY")
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Throwable) {
                        // The result is already settled. Local recovery must not stay blocked by recording upload.
                    }
                }
                dao.deletePendingCall(pending.attemptId)
            }
        }

        try {
            sync()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // The next foreground refresh will retry assignment synchronization.
        }
        val remainingCount = dao.pendingCalls().count { it.state == "COLLECTING" || it.state == "RESULT_SYNCED" }
        PendingCallRecoveryResult(
            recoveredCount = (initialCount - remainingCount).coerceAtLeast(0),
            abandonedRecordingCount = recordingPending.count { it.recordingRequested },
            remainingCount = remainingCount,
        )
    }

    suspend fun startRecording(attemptId: String): Boolean = withContext(Dispatchers.IO) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return@withContext false
        }
        runCatching {
            val started = callRecorder.start(attemptId)
            dao.setRecordingPath(attemptId, started.file.absolutePath, started.startedAt)
            CallRecordingService.start(context, attemptId)
        }.onFailure {
            callRecorder.discard()
            dao.clearRecordingPath(attemptId)
        }.isSuccess
    }

    fun stopRecording(): com.company.callcenter.telephony.RecordingFile? = callRecorder.stop()

    fun discardRecording() {
        callRecorder.discard()
        CallRecordingService.stop(context)
    }

    suspend fun markRecordingUnsupported(attemptId: String, reason: String): Boolean = withContext(Dispatchers.IO) {
        try {
            serverCall { api ->
                api.markRecordingUnsupported(attemptId, mapOf("reason" to reason))
            }
            dao.markRecordingSettled(attemptId)
            true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            false
        }
    }

    private suspend fun finishRecordingLocked(attemptId: String): Boolean {
        callRecorder.stop()?.let { stopped ->
            dao.setRecordingPath(attemptId, stopped.file.absolutePath, stopped.startedAt)
        }
        CallRecordingService.stop(context)
        val pending = dao.pendingCall(attemptId)
        val path = pending?.recordingPath?.let { java.io.File(it) }
        if (path == null || !path.exists()) {
            return try {
                serverCallLocked { api ->
                    api.markRecordingUnsupported(attemptId, mapOf("reason" to "RECORDER_STOP_EMPTY"))
                }
                dao.markRecordingSettled(attemptId)
                true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                false
            }
        }
        return try {
            serverCallLocked { api ->
                val body = path.asRequestBody("audio/mp4".toMediaType())
                api.uploadRecording(attemptId, MultipartBody.Part.createFormData("file", path.name, body))
            }
            path.delete()
            dao.markRecordingSettled(attemptId)
            true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // Keep the private file and retry it on the next CallLog reconciliation pass.
            false
        }
    }

    suspend fun reconcilePending(): Int = withContext(Dispatchers.IO) {
        val synced = serverConfigurationMutex.withLock {
            if (session.accessToken == null) return@withLock 0
            val canReadCallLog = callLogReader.hasPermission()
            var completed = 0
            dao.pendingCalls().forEach { pending ->
                dao.markPendingTried(pending.attemptId, System.currentTimeMillis())
                if (pending.state == "RESULT_SYNCED") {
                    val recordingSettled = !pending.recordingRequested || finishRecordingLocked(pending.attemptId)
                    if (recordingSettled) dao.deletePendingCall(pending.attemptId)
                    return@forEach
                }
                if (!canReadCallLog) return@forEach
                val phone = runCatching { session.decryptPhone(pending.encryptedPhone) }.getOrNull()
                    ?: return@forEach
                val matched = callLogReader.findOutgoing(phone, pending.callLogBaselineId, pending.initiatedAt)
                if (matched == null) {
                    if (CallObservationPolicy.isCollectionExpired(System.currentTimeMillis(), pending.deadlineAt)) {
                        val assignment = dao.assignment(pending.assignmentId)
                        dao.upsertHistory(
                            CallHistoryEntity(
                                attemptId = pending.attemptId,
                                assignmentId = pending.assignmentId,
                                customerName = assignment?.name ?: "客户",
                                phoneMasked = assignment?.phoneMasked ?: "***",
                                status = "UNKNOWN",
                                startedAt = pending.initiatedAt,
                                durationSeconds = null,
                                syncedAt = System.currentTimeMillis(),
                            ),
                        )
                        callMetricsRecorder.record(
                            pending.attemptId,
                            AppMode.ONLINE,
                            "UNKNOWN",
                            null,
                            pending.initiatedAt,
                        )
                        dao.markCallResultSynced(pending.attemptId)
                        val recordingSettled = !pending.recordingRequested || finishRecordingLocked(pending.attemptId)
                        if (recordingSettled) dao.deletePendingCall(pending.attemptId)
                    }
                    return@forEach
                }
                val eventId = "${pending.attemptId}:${matched.id}"
                serverCallLocked { api ->
                    api.uploadCallResults(
                        CallObservationBatch(
                            listOf(
                                CallObservation(
                                    eventId = eventId,
                                    attemptId = pending.attemptId,
                                    systemCallLogId = matched.id.toString(),
                                    systemCallStartedAt = Instant.ofEpochMilli(matched.startedAt).toString(),
                                    systemCallEndedAt = Instant.ofEpochMilli(matched.endedAt).toString(),
                                    durationSeconds = matched.durationSeconds,
                                    clientObservedAt = Instant.now().toString(),
                                ),
                            ),
                        ),
                    )
                    if (matched.durationSeconds == 0) {
                        dao.moveAssignmentToQueueEnd(pending.assignmentId, matched.startedAt)
                    }
                    val assignment = dao.assignment(pending.assignmentId)
                    dao.upsertHistory(
                        CallHistoryEntity(
                            attemptId = pending.attemptId,
                            assignmentId = pending.assignmentId,
                            customerName = assignment?.name ?: "客户",
                            phoneMasked = assignment?.phoneMasked ?: "***",
                            status = CallObservationPolicy.classify(matched.durationSeconds),
                            startedAt = matched.startedAt,
                            durationSeconds = matched.durationSeconds,
                            syncedAt = System.currentTimeMillis(),
                        ),
                    )
                    callMetricsRecorder.record(
                        pending.attemptId,
                        AppMode.ONLINE,
                        CallObservationPolicy.classify(matched.durationSeconds),
                        matched.durationSeconds,
                        matched.startedAt,
                    )
                    dao.markCallResultSynced(pending.attemptId)
                }
                val recordingSettled = !pending.recordingRequested || finishRecordingLocked(pending.attemptId)
                if (recordingSettled) dao.deletePendingCall(pending.attemptId)
                completed += 1
            }
            completed
        }
        if (synced > 0) {
            try {
                sync()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // The observation is already accepted. A later foreground sync
                // will refresh the assignment list if this follow-up fails.
            }
        }
        synced
    }

    suspend fun heartbeat() = withContext(Dispatchers.IO) {
        serverCall { api -> api.heartbeat(
            HeartbeatRequest(
                appVersion = BuildConfig.VERSION_NAME,
                appVersionCode = BuildConfig.VERSION_CODE,
                callPhonePermission = permissionState(Manifest.permission.CALL_PHONE),
                callLogPermission = permissionState(Manifest.permission.READ_CALL_LOG),
                recordAudioPermission = permissionState(Manifest.permission.RECORD_AUDIO),
            ),
        ) }
    }

    private suspend fun validateConfiguredServerLocked(): String {
        val serverUrl = session.configuredServerUrl ?: throw ServerConfigurationRequiredException()
        val previousState = _serverConnection.value
        _serverConnection.value = ServerConnectionState(
            status = ServerConnectionStatus.VERIFYING,
            configuredUrl = serverUrl,
            suggestedUrl = serverUrl,
        )
        return try {
            val normalized = apiFactory.verifyServer(serverUrl)
            session.saveServerConfiguration(normalized)
            _serverConnection.value = ServerConnectionState(
                status = ServerConnectionStatus.READY,
                configuredUrl = normalized,
                suggestedUrl = normalized,
            )
            normalized
        } catch (cancelled: CancellationException) {
            _serverConnection.value = previousState
            throw cancelled
        } catch (error: Throwable) {
            invalidateServerConfiguration(serverUrl, error)
            throw error.asServerVerificationException()
        }
    }

    private suspend fun <T> serverCall(block: suspend (CallCenterApi) -> T): T {
        return serverConfigurationMutex.withLock { serverCallLocked(block) }
    }

    private suspend fun <T> serverCallLocked(block: suspend (CallCenterApi) -> T): T {
        if (
            _serverConnection.value.status != ServerConnectionStatus.READY ||
            session.configuredServerUrl == null
        ) {
            validateConfiguredServerLocked()
        }
        val serverUrl = session.configuredServerUrl ?: throw ServerConfigurationRequiredException()
        val accessToken = session.accessToken
        return try {
            block(apiFactory.api(serverUrl, accessToken))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            when {
                error is IOException -> {
                    throw ServerVerificationException("服务器暂时不可达，请检查网络后重试", error)
                }
                error is HttpException -> {
                    if (error.code() == 401) {
                        session.clearAuthentication()
                        apiFactory.invalidateCache()
                    }
                    throw ApiProblemParser.from(error)
                }
                else -> throw error
            }
        }
    }

    private fun invalidateServerConfiguration(failedUrl: String?, error: Throwable) {
        val suggestion = failedUrl ?: session.lastServerUrl
        session.invalidateServerConfiguration(suggestion)
        apiFactory.invalidateCache()
        _serverConnection.value = ServerConnectionState(
            status = ServerConnectionStatus.INVALID,
            configuredUrl = session.configuredServerUrl,
            suggestedUrl = suggestion,
            error = error.asServerVerificationException().message,
        )
    }

    private fun checkRequiredPermissions() {
        check(permissionState(Manifest.permission.CALL_PHONE) == "GRANTED") {
            "未授予拨打电话权限"
        }
        check(permissionState(Manifest.permission.READ_CALL_LOG) == "GRANTED") {
            "未授予读取通话记录权限"
        }
    }

    private fun permissionState(permission: String): String =
        if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) {
            "GRANTED"
        } else {
            "DENIED"
        }

    private companion object {
        const val DEFAULT_MAX_CALL_ATTEMPTS = 2
        const val MAX_CALL_ATTEMPTS = 10
    }
}

private fun String.toEpochMillis(): Long = Instant.parse(this).toEpochMilli()

private fun Throwable.asServerVerificationException(): ServerVerificationException = when (this) {
    is ServerVerificationException -> this
    is IllegalArgumentException -> ServerVerificationException(message ?: "服务器地址格式不正确", this)
    is HttpException -> ServerVerificationException("无法验证服务器（HTTP ${code()}）", this)
    is IOException -> ServerVerificationException("无法连接服务器，请检查地址和网络", this)
    else -> ServerVerificationException("服务器响应无法验证", this)
}
