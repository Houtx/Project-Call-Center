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

enum class OfflineMissedDatePreset {
    ALL,
    THIS_WEEK,
    CUSTOM,
}

enum class OfflineAllCallStatus {
    ALL,
    NOT_CALLED,
    PENDING,
    CONNECTED,
    NOT_CONNECTED,
    UNKNOWN,
    COLLECTING,
}

data class OfflineAllTaskFilter(
    val phoneQuery: String = "",
    val callStatus: OfflineAllCallStatus = OfflineAllCallStatus.ALL,
    val createdDateFilter: OfflineMissedDateFilter = OfflineMissedDateFilter(),
    val importBatchId: String? = null,
)

data class OfflineMissedDateFilter(
    val preset: OfflineMissedDatePreset = OfflineMissedDatePreset.ALL,
    val startMillis: Long? = null,
    val endExclusiveMillis: Long? = null,
)

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

data class OfflineTaskPage(
    val contacts: List<OfflineContact> = emptyList(),
    val totalCount: Int = 0,
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

enum class OfflineImportSource {
    SPREADSHEET,
    PASTE,
}

data class OfflineImportMetadata(
    val displayName: String,
    val source: OfflineImportSource,
    val sheetName: String? = null,
    val columnLetter: String? = null,
    val requestedStartRow: Int? = null,
    val requestedEndRow: Int? = null,
    val skipHeader: Boolean = false,
)

data class OfflineImportBatch(
    val id: String,
    val displayName: String,
    val source: OfflineImportSource,
    val sheetName: String?,
    val columnLetter: String?,
    val requestedStartRow: Int?,
    val requestedEndRow: Int?,
    val skipHeader: Boolean,
    val createdAt: Long,
    val addedCount: Int,
    val duplicateCount: Int,
    val invalidCount: Int,
)

data class OfflineImportDeleteResult(
    val deletedContacts: Int,
)

data class OfflineCleanupResult(
    val deletedContacts: Int,
)

data class OfflineUnlockResult(
    val unlocked: Boolean,
    val retryAfterSeconds: Long = 0,
)
