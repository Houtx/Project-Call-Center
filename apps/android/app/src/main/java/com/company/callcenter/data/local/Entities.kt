package com.company.callcenter.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "assigned_customers")
data class AssignedCustomerEntity(
    @PrimaryKey val assignmentId: String,
    val customerId: String,
    val name: String,
    val phoneMasked: String,
    val batchName: String?,
    val province: String?,
    val city: String?,
    val carrier: String?,
    val notes: String?,
    val tags: String,
    val attemptCount: Int,
    val nextCallAllowedAt: Long?,
    val lastCalledAt: Long?,
    val state: String,
    val updatedAt: Long,
)

@Entity(tableName = "pending_call_attempts")
data class PendingCallEntity(
    @PrimaryKey val attemptId: String,
    val assignmentId: String,
    val encryptedPhone: String,
    val callLogBaselineId: Long,
    val initiatedAt: Long,
    val deadlineAt: Long,
    val state: String = "COLLECTING",
    val retryCount: Int = 0,
    val lastTriedAt: Long? = null,
)

@Entity(tableName = "call_history")
data class CallHistoryEntity(
    @PrimaryKey val attemptId: String,
    val assignmentId: String,
    val customerName: String,
    val phoneMasked: String,
    val status: String,
    val startedAt: Long,
    val durationSeconds: Int?,
    val syncedAt: Long,
)
