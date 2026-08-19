package com.company.callcenter.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface CallCenterDao {
    @Query("SELECT * FROM assigned_customers ORDER BY updatedAt DESC")
    fun observeAssignments(): Flow<List<AssignedCustomerEntity>>

    @Query("SELECT * FROM assigned_customers WHERE assignmentId = :assignmentId")
    suspend fun assignment(assignmentId: String): AssignedCustomerEntity?

    @Query("UPDATE assigned_customers SET lastCalledAt = :at WHERE assignmentId = :assignmentId")
    suspend fun moveAssignmentToQueueEnd(assignmentId: String, at: Long)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAssignments(items: List<AssignedCustomerEntity>)

    @Query("DELETE FROM assigned_customers WHERE assignmentId IN (:ids)")
    suspend fun deleteAssignments(ids: List<String>)

    @Transaction
    suspend fun applySync(upserts: List<AssignedCustomerEntity>, removals: List<String>) {
        if (upserts.isNotEmpty()) upsertAssignments(upserts)
        if (removals.isNotEmpty()) deleteAssignments(removals)
    }

    @Query("SELECT * FROM pending_call_attempts ORDER BY initiatedAt")
    suspend fun pendingCalls(): List<PendingCallEntity>

    @Query("SELECT * FROM pending_call_attempts WHERE attemptId = :attemptId")
    suspend fun pendingCall(attemptId: String): PendingCallEntity?

    @Query("SELECT EXISTS(SELECT 1 FROM pending_call_attempts WHERE state IN ('COLLECTING', 'RESULT_SYNCED'))")
    fun observeHasPendingCall(): Flow<Boolean>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPendingCall(item: PendingCallEntity)

    @Query("UPDATE pending_call_attempts SET recordingPath = :path, recordingStartedAt = :startedAt WHERE attemptId = :attemptId")
    suspend fun setRecordingPath(attemptId: String, path: String, startedAt: Long)

    @Query("UPDATE pending_call_attempts SET recordingPath = NULL, recordingStartedAt = NULL WHERE attemptId = :attemptId")
    suspend fun clearRecordingPath(attemptId: String)

    @Query("UPDATE pending_call_attempts SET state = 'RESULT_SYNCED' WHERE attemptId = :attemptId")
    suspend fun markCallResultSynced(attemptId: String)

    @Query("UPDATE pending_call_attempts SET recordingRequested = 0, recordingPath = NULL, recordingStartedAt = NULL WHERE attemptId = :attemptId")
    suspend fun markRecordingSettled(attemptId: String)

    @Query("UPDATE pending_call_attempts SET retryCount = retryCount + 1, lastTriedAt = :at WHERE attemptId = :attemptId")
    suspend fun markPendingTried(attemptId: String, at: Long)

    @Query("DELETE FROM pending_call_attempts WHERE attemptId = :attemptId")
    suspend fun deletePendingCall(attemptId: String)

    @Query("SELECT * FROM call_history ORDER BY startedAt DESC LIMIT 200")
    fun observeHistory(): Flow<List<CallHistoryEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertHistory(item: CallHistoryEntity)

    @Query(
        """
        SELECT
          COUNT(*) AS callCount,
          COUNT(DISTINCT assignmentId) AS customerCount,
          COALESCE(SUM(CASE WHEN status = 'CONNECTED' THEN 1 ELSE 0 END), 0) AS connectedCount,
          COALESCE(SUM(CASE WHEN status = 'NOT_CONNECTED' THEN 1 ELSE 0 END), 0) AS notConnectedCount,
          COALESCE(SUM(CASE WHEN status = 'UNKNOWN' THEN 1 ELSE 0 END), 0) AS unknownCount,
          COALESCE(SUM(CASE WHEN status = 'CONNECTED' THEN durationSeconds ELSE 0 END), 0) AS totalDurationSeconds,
          COALESCE(AVG(CASE WHEN status = 'CONNECTED' THEN durationSeconds END), 0) AS averageDurationSeconds,
          COALESCE(MAX(CASE WHEN status = 'CONNECTED' THEN durationSeconds ELSE 0 END), 0) AS maximumDurationSeconds
        FROM call_history
        WHERE startedAt >= :sinceMillis
        """,
    )
    fun observeStatistics(sinceMillis: Long): Flow<CallStatisticsRow>

    @Query("DELETE FROM assigned_customers")
    suspend fun clearAssignments()

    @Query("DELETE FROM pending_call_attempts")
    suspend fun clearPendingCalls()

    @Query("DELETE FROM call_history")
    suspend fun clearHistory()

    @Transaction
    suspend fun clearAll() {
        clearAssignments()
        clearPendingCalls()
        clearHistory()
    }
}
