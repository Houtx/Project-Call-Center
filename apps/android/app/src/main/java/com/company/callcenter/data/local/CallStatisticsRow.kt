package com.company.callcenter.data.local

data class CallStatisticsRow(
    val callCount: Long,
    val customerCount: Long,
    val connectedCount: Long,
    val notConnectedCount: Long,
    val unknownCount: Long,
    val totalDurationSeconds: Long,
    val averageDurationSeconds: Double,
    val maximumDurationSeconds: Int,
)
