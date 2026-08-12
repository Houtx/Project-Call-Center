package com.company.callcenter.data.remote

data class LoginRequest(val username: String, val password: String, val device: LoginDevice)
data class LoginDevice(
    val installId: String,
    val manufacturer: String,
    val model: String,
    val androidVersion: String,
    val androidSdk: Int,
    val appVersion: String,
    val appVersionCode: Int,
)
data class LoginResponse(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long,
    val deviceId: String,
    val user: MobileUser,
)
data class MobileUser(val id: String, val username: String, val name: String, val role: String)
data class RefreshTokenRequest(val refreshToken: String)
data class RefreshTokenResponse(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long,
)

data class BootstrapResponse(
    val serverTime: String,
    val minimumVersionCode: Int,
    val latestVersionCode: Int,
    val forceUpgrade: Boolean,
    val downloadUrl: String?,
    val maxCallAttempts: Int,
    val device: DevicePolicy,
)
data class DevicePolicy(val id: String, val status: String, val compatible: Boolean, val reason: String?)

data class SyncResponse(
    val cursor: String,
    val maxCallAttempts: Int,
    val changes: List<SyncChange>,
)
data class SyncChange(
    val operation: String,
    val entityType: String,
    val entityId: String,
    val assignment: MobileAssignment?,
)
data class MobileAssignment(
    val assignmentId: String,
    val customerId: String,
    val name: String?,
    val phoneMasked: String,
    val batchName: String?,
    val province: String?,
    val city: String?,
    val carrier: String?,
    val notes: String?,
    val tags: List<String> = emptyList(),
    val attemptCount: Int,
    val nextCallAllowedAt: String?,
    val lastCalledAt: String?,
    val state: String,
    val updatedAt: String,
)

data class PhoneRevealResponse(val phone: String, val expiresAt: String)
data class CallAttemptRequest(
    val assignmentId: String,
    val clientAttemptId: String,
    val callLogBaselineId: String,
    val callLogBaselineAt: String,
)
data class CallAttemptResponse(
    val attemptId: String,
    val phone: String,
    val expiresAt: String,
    val collectionDeadlineAt: String,
    val attemptNumber: Int,
    val recordingRequested: Boolean = false,
)

data class RecordingUploadResponse(
    val id: String,
    val status: String,
    val sizeBytes: Int? = null,
)
data class RecordingUnsupportedResponse(val marked: Boolean)
data class CancelCallAttemptResponse(val cancelled: Boolean)

data class CallObservationBatch(val results: List<CallObservation>)
data class CallObservation(
    val eventId: String,
    val attemptId: String,
    val systemCallLogId: String,
    val systemCallStartedAt: String,
    val systemCallEndedAt: String,
    val durationSeconds: Int,
    val clientObservedAt: String,
)
data class CallObservationResult(val accepted: Int, val duplicates: Int = 0)

data class HeartbeatRequest(
    val appVersion: String,
    val appVersionCode: Int,
    val callPhonePermission: String,
    val callLogPermission: String,
    val recordAudioPermission: String,
)
