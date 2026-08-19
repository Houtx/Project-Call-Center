package com.company.callcenter.data.offline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.Instant

class OfflineDateRangesTest {
    @Test
    fun `this week uses Monday and Shanghai day boundaries`() {
        val range = OfflineDateRanges.thisWeek(Instant.parse("2026-08-19T10:00:00Z").toEpochMilli())

        assertEquals(OfflineMissedDatePreset.THIS_WEEK, range.preset)
        assertEquals(Instant.parse("2026-08-16T16:00:00Z").toEpochMilli(), range.startMillis)
        assertEquals(Instant.parse("2026-08-19T16:00:00Z").toEpochMilli(), range.endExclusiveMillis)
    }

    @Test
    fun `custom range is inclusive by local date and exclusive at next Shanghai midnight`() {
        val range = OfflineDateRanges.custom(
            Instant.parse("2026-08-01T00:00:00Z").toEpochMilli(),
            Instant.parse("2026-08-03T00:00:00Z").toEpochMilli(),
        )

        assertEquals(Instant.parse("2026-07-31T16:00:00Z").toEpochMilli(), range.startMillis)
        assertEquals(Instant.parse("2026-08-03T16:00:00Z").toEpochMilli(), range.endExclusiveMillis)
    }

    @Test
    fun `custom range rejects a reversed selection`() {
        assertThrows(IllegalArgumentException::class.java) {
            OfflineDateRanges.custom(
                Instant.parse("2026-08-03T00:00:00Z").toEpochMilli(),
                Instant.parse("2026-08-01T00:00:00Z").toEpochMilli(),
            )
        }
    }
}
