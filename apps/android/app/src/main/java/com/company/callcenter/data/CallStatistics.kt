package com.company.callcenter.data

import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

enum class CallStatisticsRange {
    TODAY,
    LAST_7_DAYS,
    ALL,
    ;

    fun sinceMillis(nowMillis: Long, zoneId: ZoneId = SHANGHAI_ZONE): Long = when (this) {
        TODAY -> Instant.ofEpochMilli(nowMillis)
            .atZone(zoneId)
            .toLocalDate()
            .atStartOfDay(zoneId)
            .toInstant()
            .toEpochMilli()
        LAST_7_DAYS -> Instant.ofEpochMilli(nowMillis)
            .atZone(zoneId)
            .toLocalDate()
            .minus(6, ChronoUnit.DAYS)
            .atStartOfDay(zoneId)
            .toInstant()
            .toEpochMilli()
        ALL -> 0L
    }

    private companion object {
        val SHANGHAI_ZONE: ZoneId = ZoneId.of("Asia/Shanghai")
    }
}

data class CallStatistics(
    val callCount: Long = 0,
    val customerCount: Long = 0,
    val connectedCount: Long = 0,
    val notConnectedCount: Long = 0,
    val unknownCount: Long = 0,
    val totalDurationSeconds: Long = 0,
    val averageDurationSeconds: Double = 0.0,
    val maximumDurationSeconds: Int = 0,
) {
    val connectionRate: Double
        get() {
            val denominator = connectedCount + notConnectedCount
            return if (denominator == 0L) 0.0 else connectedCount.toDouble() / denominator
        }
}
