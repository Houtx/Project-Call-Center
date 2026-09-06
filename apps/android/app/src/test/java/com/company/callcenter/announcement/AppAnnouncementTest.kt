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
            """{"id":7,"title":"系统维护","content":"今晚进行维护。","publishedAt":"2026-09-06T02:00:00Z"}""",
        )
        assertEquals(7L, parsed.id)
        assertEquals("系统维护", parsed.title)

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
    }
}
