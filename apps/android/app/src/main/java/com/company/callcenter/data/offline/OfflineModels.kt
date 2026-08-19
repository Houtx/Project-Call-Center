package com.company.callcenter.data.offline

enum class OfflineContactState {
    READY,
    COLLECTING,
    RETRY,
    CONNECTED,
    EXHAUSTED,
}

enum class OfflineCallResult {
    CONNECTED,
    NOT_CONNECTED,
    UNKNOWN,
}

enum class OfflineTaskFilter {
    PENDING,
    NOT_CONNECTED,
    ALL,
}

data class OfflineContact(
    val id: String,
    val name: String,
    val phoneMasked: String,
    val state: OfflineContactState,
    val attemptCount: Int,
    val lastResult: OfflineCallResult?,
    val importedAt: Long,
    val lastAttemptAt: Long?,
    val completedAt: Long?,
)

data class OfflineCallRecord(
    val attemptId: String,
    val contactId: String,
    val customerName: String,
    val phoneMasked: String,
    val result: OfflineCallResult,
    val startedAt: Long,
    val durationSeconds: Int?,
)

data class OfflineImportContact(
    val phone: String,
    val name: String? = null,
)

data class OfflineImportResult(
    val addedCount: Int,
    val duplicateCount: Int,
    val invalidCount: Int,
)

data class OfflineCleanupResult(
    val deletedContacts: Int,
)

data class OfflineUnlockResult(
    val unlocked: Boolean,
    val retryAfterSeconds: Long = 0,
)
