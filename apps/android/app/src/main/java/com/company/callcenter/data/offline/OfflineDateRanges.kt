package com.company.callcenter.data.offline

import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.temporal.TemporalAdjusters

object OfflineDateRanges {
    private val shanghaiZone = ZoneId.of("Asia/Shanghai")

    fun thisWeek(nowMillis: Long): OfflineMissedDateFilter {
        val today = Instant.ofEpochMilli(nowMillis).atZone(shanghaiZone).toLocalDate()
        val monday = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        return OfflineMissedDateFilter(
            preset = OfflineMissedDatePreset.THIS_WEEK,
            startMillis = monday.atStartOfDay(shanghaiZone).toInstant().toEpochMilli(),
            endExclusiveMillis = today.plusDays(1).atStartOfDay(shanghaiZone).toInstant().toEpochMilli(),
        )
    }

    fun custom(startUtcMillis: Long, endUtcMillis: Long): OfflineMissedDateFilter {
        val startDate = Instant.ofEpochMilli(startUtcMillis).atZone(ZoneOffset.UTC).toLocalDate()
        val endDate = Instant.ofEpochMilli(endUtcMillis).atZone(ZoneOffset.UTC).toLocalDate()
        require(!endDate.isBefore(startDate)) { "结束日期不能早于开始日期" }
        return OfflineMissedDateFilter(
            preset = OfflineMissedDatePreset.CUSTOM,
            startMillis = startDate.atStartOfDay(shanghaiZone).toInstant().toEpochMilli(),
            endExclusiveMillis = endDate.plusDays(1).atStartOfDay(shanghaiZone).toInstant().toEpochMilli(),
        )
    }
}
