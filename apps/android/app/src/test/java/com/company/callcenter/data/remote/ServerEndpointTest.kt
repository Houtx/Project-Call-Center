package com.company.callcenter.data.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ServerEndpointTest {
    @Test
    fun `adds https and api path to a host address`() {
        assertEquals(
            "https://crm.example.com/api/v1/",
            ServerEndpoint.normalize("crm.example.com", allowCleartext = false),
        )
    }

    @Test
    fun `preserves an existing api path and normalizes trailing slash`() {
        assertEquals(
            "https://crm.example.com/api/v1/",
            ServerEndpoint.normalize(" https://crm.example.com/api/v1 ", allowCleartext = false),
        )
    }

    @Test
    fun `supports a reverse proxy path prefix`() {
        assertEquals(
            "https://example.com/call-center/api/v1/",
            ServerEndpoint.normalize("https://example.com/call-center", allowCleartext = false),
        )
    }

    @Test
    fun `allows cleartext only when explicitly enabled`() {
        assertEquals(
            "http://10.0.2.2:8800/api/v1/",
            ServerEndpoint.normalize("http://10.0.2.2:8800", allowCleartext = true),
        )
        assertThrows(IllegalArgumentException::class.java) {
            ServerEndpoint.normalize("http://10.0.2.2:8800", allowCleartext = false)
        }
    }

    @Test
    fun `rejects blank addresses credentials queries and fragments`() {
        listOf(
            " ",
            "https://user:password@example.com",
            "https://example.com?tenant=one",
            "https://example.com#settings",
        ).forEach { address ->
            assertThrows(IllegalArgumentException::class.java) {
                ServerEndpoint.normalize(address, allowCleartext = false)
            }
        }
    }
}
