package com.company.callcenter.data

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class CallStatisticsRangeTest {
    @Test
    fun `today starts at the Shanghai calendar boundary`() {
        val now = Instant.parse("2026-08-19T08:30:00Z").toEpochMilli()

        assertEquals(
            Instant.parse("2026-08-18T16:00:00Z").toEpochMilli(),
            CallStatisticsRange.TODAY.sinceMillis(now, ZoneId.of("Asia/Shanghai")),
        )
    }

    @Test
    fun `seven day range includes today and six preceding calendar days`() {
        val now = Instant.parse("2026-08-19T08:30:00Z").toEpochMilli()

        assertEquals(
            Instant.parse("2026-08-12T16:00:00Z").toEpochMilli(),
            CallStatisticsRange.LAST_7_DAYS.sinceMillis(now, ZoneId.of("Asia/Shanghai")),
        )
    }
}
