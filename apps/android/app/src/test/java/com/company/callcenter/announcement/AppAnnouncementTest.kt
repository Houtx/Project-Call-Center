package com.company.callcenter.announcement

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

class AppAnnouncementTest {
    @Test
    fun `derives announcement endpoint from trusted telemetry origin`() {
        assertEquals(
            "https://call.example.com/api/app/v1/announcement/latest",
            AnnouncementEndpointPolicy.fromTelemetryEndpoint("https://call.example.com/api/telemetry/v1/daily"),
        )
        assertEquals(
            "https://call.example.com:8443/api/app/v1/announcement/latest",
            AnnouncementEndpointPolicy.fromTelemetryEndpoint("https://call.example.com:8443/custom/path"),
        )
        assertNull(AnnouncementEndpointPolicy.fromTelemetryEndpoint("http://call.example.com/api/telemetry/v1/daily"))
        assertNull(AnnouncementEndpointPolicy.fromTelemetryEndpoint(""))
    }

    @Test
    fun `parses a valid announcement and rejects unsafe metadata`() {
        val parsed = AppAnnouncementParser.parse(
            """{"id":7,"title":"系统维护","content":"今晚进行维护。","publishedAt":"2026-09-06T02:00:00Z","revision":2}""",
        )
        assertEquals(7L, parsed.id)
        assertEquals("系统维护", parsed.title)
        assertEquals(2L, parsed.revision)

        val legacy = AppAnnouncementParser.parse(
            """{"id":7,"title":"系统维护","content":"今晚进行维护。","publishedAt":"2026-09-06T02:00:00Z"}""",
        )
        assertEquals(1L, legacy.revision)

        assertThrows(IOException::class.java) {
            AppAnnouncementParser.parse(
                """{"id":0,"title":"系统维护","content":"内容","publishedAt":"2026-09-06T02:00:00Z"}""",
            )
        }
        assertThrows(IOException::class.java) {
            AppAnnouncementParser.parse(
                """{"id":8,"title":"系统维护","content":"内容","publishedAt":"not-a-time"}""",
            )
        }
        assertThrows(IOException::class.java) {
            AppAnnouncementParser.parse(
                """{"id":8,"title":"系统维护","content":"内容","publishedAt":"2026-09-06T02:00:00Z","revision":0}""",
            )
        }
    }

    @Test
    fun `read state includes revision and remains compatible with legacy revision one`() {
        val firstRevision = AppAnnouncement(7, "系统维护", "内容", "2026-09-06T02:00:00Z")
        val secondRevision = firstRevision.copy(revision = 2)

        assertEquals(true, AnnouncementReadPolicy.isRead(firstRevision, storedId = 7, storedRevision = 1))
        assertEquals(false, AnnouncementReadPolicy.isRead(secondRevision, storedId = 7, storedRevision = 1))
        assertEquals(false, AnnouncementReadPolicy.isRead(firstRevision, storedId = 8, storedRevision = 1))
    }
}
