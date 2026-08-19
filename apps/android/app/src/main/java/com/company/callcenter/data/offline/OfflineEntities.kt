package com.company.callcenter.data.offline

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "offline_contacts",
    indices = [
        Index(value = ["phoneHash"], unique = true),
        Index(value = ["state", "queueOrder"]),
        Index(value = ["lastResult", "lastAttemptAt"]),
        Index(value = ["completedAt"]),
    ],
)
data class OfflineContactEntity(
    @PrimaryKey val id: String,
    val encryptedPhone: String,
    val phoneHash: String,
    val phoneMasked: String,
    val encryptedName: String?,
    val importedAt: Long,
    val state: String,
    val attemptCount: Int,
    val lastResult: String?,
    val lastAttemptAt: Long?,
    val completedAt: Long?,
    val queueOrder: Long,
)

@Entity(
    tableName = "offline_pending_calls",
    foreignKeys = [
        ForeignKey(
            entity = OfflineContactEntity::class,
            parentColumns = ["id"],
            childColumns = ["contactId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["contactId"], unique = true), Index(value = ["deadlineAt"])],
)
data class OfflinePendingCallEntity(
    @PrimaryKey val attemptId: String,
    val contactId: String,
    val encryptedPhone: String,
    val callLogBaselineId: Long,
    val initiatedAt: Long,
    val deadlineAt: Long,
    val previousState: String,
    val previousCompletedAt: Long?,
    val previousQueueOrder: Long,
)

@Entity(
    tableName = "offline_call_history",
    foreignKeys = [
        ForeignKey(
            entity = OfflineContactEntity::class,
            parentColumns = ["id"],
            childColumns = ["contactId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["contactId", "startedAt"]), Index(value = ["result", "startedAt"])],
)
data class OfflineCallHistoryEntity(
    @PrimaryKey val attemptId: String,
    val contactId: String,
    val encryptedPhone: String,
    val encryptedName: String?,
    val phoneMasked: String,
    val result: String,
    val startedAt: Long,
    val durationSeconds: Int?,
    val observedAt: Long,
    val systemCallLogId: Long?,
)
