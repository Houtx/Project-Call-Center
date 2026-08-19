package com.company.callcenter.data.offline

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.company.callcenter.data.local.CallStatisticsRow
import kotlinx.coroutines.flow.Flow

@Dao
interface OfflineDao {
    @Query(
        """
        SELECT * FROM offline_contacts
        WHERE state IN ('READY', 'RETRY')
        ORDER BY queueOrder ASC
        LIMIT :limit
        """,
    )
    fun observePendingContacts(limit: Int): Flow<List<OfflineContactEntity>>

    @Query("SELECT COUNT(*) FROM offline_contacts WHERE state IN ('READY', 'RETRY')")
    fun observePendingContactCount(): Flow<Int>

    @Query(
        """
        SELECT * FROM offline_contacts
        WHERE lastResult = 'NOT_CONNECTED'
          AND (:startMillis IS NULL OR lastAttemptAt >= :startMillis)
          AND (:endExclusiveMillis IS NULL OR lastAttemptAt < :endExclusiveMillis)
        ORDER BY queueOrder ASC
        LIMIT :limit
        """,
    )
    fun observeNotConnectedContacts(
        startMillis: Long?,
        endExclusiveMillis: Long?,
        limit: Int,
    ): Flow<List<OfflineContactEntity>>

    @Query(
        """
        SELECT COUNT(*) FROM offline_contacts
        WHERE lastResult = 'NOT_CONNECTED'
          AND (:startMillis IS NULL OR lastAttemptAt >= :startMillis)
          AND (:endExclusiveMillis IS NULL OR lastAttemptAt < :endExclusiveMillis)
        """,
    )
    fun observeNotConnectedContactCount(startMillis: Long?, endExclusiveMillis: Long?): Flow<Int>

    @Query("SELECT * FROM offline_contacts ORDER BY queueOrder ASC LIMIT :limit")
    fun observeAllContacts(limit: Int): Flow<List<OfflineContactEntity>>

    @Query("SELECT COUNT(*) FROM offline_contacts")
    fun observeAllContactCount(): Flow<Int>

    @Query("SELECT * FROM offline_contacts WHERE id = :contactId")
    suspend fun contact(contactId: String): OfflineContactEntity?

    @Query("SELECT COALESCE(MAX(queueOrder), 0) FROM offline_contacts")
    suspend fun maximumQueueOrder(): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertContacts(items: List<OfflineContactEntity>): List<Long>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertImportBatch(item: OfflineImportBatchEntity)

    @Query(
        """
        UPDATE offline_import_batches
        SET addedCount = :addedCount, duplicateCount = :duplicateCount, invalidCount = :invalidCount
        WHERE id = :batchId
        """,
    )
    suspend fun finishImportBatch(batchId: String, addedCount: Int, duplicateCount: Int, invalidCount: Int)

    @Query("SELECT * FROM offline_import_batches ORDER BY createdAt DESC")
    fun observeImportBatches(): Flow<List<OfflineImportBatchEntity>>

    @Query("SELECT COUNT(*) FROM offline_contacts WHERE importBatchId = :batchId")
    suspend fun countContactsForImportBatch(batchId: String): Int

    @Query(
        """
        SELECT EXISTS(
            SELECT 1 FROM offline_pending_calls pending
            INNER JOIN offline_contacts contact ON contact.id = pending.contactId
            WHERE contact.importBatchId = :batchId
        )
        """,
    )
    suspend fun hasPendingCallForImportBatch(batchId: String): Boolean

    @Query("DELETE FROM offline_contacts WHERE importBatchId = :batchId")
    suspend fun deleteContactsForImportBatch(batchId: String): Int

    @Query("DELETE FROM offline_import_batches WHERE id = :batchId")
    suspend fun deleteImportBatch(batchId: String): Int

    @Query("SELECT * FROM offline_pending_calls ORDER BY initiatedAt ASC")
    suspend fun pendingCalls(): List<OfflinePendingCallEntity>

    @Query("SELECT * FROM offline_pending_calls WHERE attemptId = :attemptId")
    suspend fun pendingCall(attemptId: String): OfflinePendingCallEntity?

    @Query("SELECT EXISTS(SELECT 1 FROM offline_pending_calls)")
    fun observeHasPendingCall(): Flow<Boolean>

    @Query("SELECT EXISTS(SELECT 1 FROM offline_pending_calls)")
    suspend fun hasPendingCall(): Boolean

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertPendingCall(item: OfflinePendingCallEntity)

    @Query(
        """
        UPDATE offline_contacts
        SET state = 'COLLECTING', attemptCount = attemptCount + 1,
            lastAttemptAt = :initiatedAt, completedAt = NULL, queueOrder = :queueOrder
        WHERE id = :contactId AND state != 'COLLECTING' AND state != 'CONNECTED'
          AND attemptCount < :maxAttempts
        """,
    )
    suspend fun markCollecting(
        contactId: String,
        initiatedAt: Long,
        queueOrder: Long,
        maxAttempts: Int,
    ): Int

    @Transaction
    suspend fun beginAttempt(item: OfflinePendingCallEntity, queueOrder: Long, maxAttempts: Int): Boolean {
        if (hasPendingCall()) return false
        val updated = markCollecting(item.contactId, item.initiatedAt, queueOrder, maxAttempts)
        if (updated != 1) return false
        insertPendingCall(item)
        return true
    }

    @Query("DELETE FROM offline_pending_calls WHERE attemptId = :attemptId")
    suspend fun deletePendingCall(attemptId: String)

    @Query(
        """
        UPDATE offline_contacts
        SET state = :state, completedAt = :completedAt, queueOrder = :queueOrder,
            attemptCount = CASE WHEN attemptCount > 0 THEN attemptCount - 1 ELSE 0 END
        WHERE id = :contactId
        """,
    )
    suspend fun restoreContactAfterLaunchFailure(
        contactId: String,
        state: String,
        completedAt: Long?,
        queueOrder: Long,
    )

    @Transaction
    suspend fun cancelAttempt(item: OfflinePendingCallEntity) {
        restoreContactAfterLaunchFailure(
            contactId = item.contactId,
            state = item.previousState,
            completedAt = item.previousCompletedAt,
            queueOrder = item.previousQueueOrder,
        )
        deletePendingCall(item.attemptId)
    }

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertHistory(item: OfflineCallHistoryEntity): Long

    @Query(
        """
        UPDATE offline_contacts
        SET state = :state, lastResult = :result, lastAttemptAt = :attemptAt,
            completedAt = :completedAt, queueOrder = :queueOrder
        WHERE id = :contactId
        """,
    )
    suspend fun settleContact(
        contactId: String,
        state: String,
        result: String,
        attemptAt: Long,
        completedAt: Long?,
        queueOrder: Long,
    )

    @Transaction
    suspend fun settleAttempt(
        pending: OfflinePendingCallEntity,
        history: OfflineCallHistoryEntity,
        state: String,
        result: String,
        completedAt: Long?,
        queueOrder: Long,
    ): Boolean {
        if (insertHistory(history) == -1L) {
            deletePendingCall(pending.attemptId)
            return false
        }
        settleContact(
            contactId = pending.contactId,
            state = state,
            result = result,
            attemptAt = history.startedAt,
            completedAt = completedAt,
            queueOrder = queueOrder,
        )
        deletePendingCall(pending.attemptId)
        return true
    }

    @Query(
        """
        UPDATE offline_contacts
        SET state = 'EXHAUSTED', completedAt = :completedAt
        WHERE state IN ('READY', 'RETRY') AND attemptCount >= :maxAttempts
          AND NOT EXISTS (
            SELECT 1 FROM offline_pending_calls WHERE contactId = offline_contacts.id
          )
        """,
    )
    suspend fun exhaustContactsAtLimit(maxAttempts: Int, completedAt: Long): Int

    @Query(
        """
        UPDATE offline_contacts
        SET state = 'RETRY', completedAt = NULL, queueOrder = queueOrder + :queueOffset
        WHERE state = 'EXHAUSTED' AND attemptCount < :maxAttempts
          AND lastResult IN ('NOT_CONNECTED', 'UNKNOWN')
          AND NOT EXISTS (
            SELECT 1 FROM offline_pending_calls WHERE contactId = offline_contacts.id
          )
        """,
    )
    suspend fun reopenContactsBelowLimit(maxAttempts: Int, queueOffset: Long): Int

    @Transaction
    suspend fun reconcileMaximumAttempts(maxAttempts: Int, changedAt: Long) {
        require(maxAttempts > 0)
        val queueOffset = maximumQueueOrder()
        exhaustContactsAtLimit(maxAttempts, changedAt)
        reopenContactsBelowLimit(maxAttempts, queueOffset)
    }

    @Query("SELECT * FROM offline_call_history ORDER BY startedAt DESC LIMIT 500")
    fun observeHistory(): Flow<List<OfflineCallHistoryEntity>>

    @Query("SELECT * FROM offline_call_history WHERE attemptId = :attemptId")
    suspend fun history(attemptId: String): OfflineCallHistoryEntity?

    @Query(
        """
        SELECT
          COUNT(*) AS callCount,
          COUNT(DISTINCT contactId) AS customerCount,
          COALESCE(SUM(CASE WHEN result = 'CONNECTED' THEN 1 ELSE 0 END), 0) AS connectedCount,
          COALESCE(SUM(CASE WHEN result = 'NOT_CONNECTED' THEN 1 ELSE 0 END), 0) AS notConnectedCount,
          COALESCE(SUM(CASE WHEN result = 'UNKNOWN' THEN 1 ELSE 0 END), 0) AS unknownCount,
          COALESCE(SUM(CASE WHEN result = 'CONNECTED' THEN durationSeconds ELSE 0 END), 0) AS totalDurationSeconds,
          COALESCE(AVG(CASE WHEN result = 'CONNECTED' THEN durationSeconds END), 0) AS averageDurationSeconds,
          COALESCE(MAX(CASE WHEN result = 'CONNECTED' THEN durationSeconds ELSE 0 END), 0) AS maximumDurationSeconds
        FROM offline_call_history
        WHERE startedAt >= :sinceMillis
        """,
    )
    fun observeStatistics(sinceMillis: Long): Flow<CallStatisticsRow>

    @Query(
        """
        SELECT COUNT(*) FROM offline_contacts
        WHERE completedAt IS NOT NULL AND completedAt < :cutoffMillis
          AND NOT EXISTS (
            SELECT 1 FROM offline_pending_calls WHERE contactId = offline_contacts.id
          )
        """,
    )
    suspend fun countCompletedBefore(cutoffMillis: Long): Int

    @Query(
        """
        DELETE FROM offline_contacts
        WHERE completedAt IS NOT NULL AND completedAt < :cutoffMillis
          AND NOT EXISTS (
            SELECT 1 FROM offline_pending_calls WHERE contactId = offline_contacts.id
          )
        """,
    )
    suspend fun deleteCompletedBefore(cutoffMillis: Long): Int

    @Query("DELETE FROM offline_contacts")
    suspend fun clearContacts()

    @Query("DELETE FROM offline_pending_calls")
    suspend fun clearPendingCalls()

    @Query("DELETE FROM offline_call_history")
    suspend fun clearHistory()

    @Query("DELETE FROM offline_import_batches")
    suspend fun clearImportBatches()

    @Transaction
    suspend fun clearAll() {
        clearPendingCalls()
        clearHistory()
        clearContacts()
        clearImportBatches()
    }
}
