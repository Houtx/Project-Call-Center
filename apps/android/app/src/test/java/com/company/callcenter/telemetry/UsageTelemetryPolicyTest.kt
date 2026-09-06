package com.company.callcenter.telemetry

import com.company.callcenter.data.AppMode
import com.google.gson.Gson
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class UsageTelemetryPolicyTest {
    @Test
    fun `disable password matches the local calendar date`() {
        val date = LocalDate.of(2026, 9, 6)

        assertTrue(UsageTelemetryDisablePolicy.isValid("20260906", date))
        assertFalse(UsageTelemetryDisablePolicy.isValid("20260905", date))
        assertFalse(UsageTelemetryDisablePolicy.isValid("2026-09-06", date))
    }

    @Test
    fun `accepts only well formed HTTPS endpoints without credentials or fragments`() {
        assertTrue(UsageTelemetryPolicy.isValidEndpoint("https://metrics.example.com/v1/events"))
        assertFalse(UsageTelemetryPolicy.isValidEndpoint(""))
        assertFalse(UsageTelemetryPolicy.isValidEndpoint("http://metrics.example.com/v1/events"))
        assertFalse(UsageTelemetryPolicy.isValidEndpoint("https://user:pass@metrics.example.com/events"))
        assertFalse(UsageTelemetryPolicy.isValidEndpoint("https://metrics.example.com/events#secret"))
        assertFalse(UsageTelemetryPolicy.isValidEndpoint("https://metrics.example.com:99999/events"))
        assertFalse(UsageTelemetryPolicy.isValidEndpoint("https://"))
    }

    @Test
    fun `requires telemetry to be enabled and a mode to be selected`() {
        assertFalse(
            UsageTelemetryPolicy.shouldAttempt(ENDPOINT, false, AppMode.ONLINE, TODAY, null),
        )
        assertFalse(
            UsageTelemetryPolicy.shouldAttempt(ENDPOINT, true, null, TODAY, null),
        )
        assertTrue(
            UsageTelemetryPolicy.shouldAttempt(ENDPOINT, true, AppMode.OFFLINE, TODAY, null),
        )
    }

    @Test
    fun `defaults to enabled only when an endpoint is available and no preference exists`() {
        assertTrue(UsageTelemetryPolicy.initialEnabled(true, false, false, false))
        assertFalse(UsageTelemetryPolicy.initialEnabled(false, false, false, false))
    }

    @Test
    fun `preserves stored opt out and receiver boundary`() {
        assertFalse(UsageTelemetryPolicy.initialEnabled(true, true, false, false))
        assertTrue(UsageTelemetryPolicy.initialEnabled(true, true, true, true))
        assertFalse(UsageTelemetryPolicy.initialEnabled(true, true, true, false))
    }

    @Test
    fun `new policy re-enables telemetry once for existing installations`() {
        assertTrue(
            UsageTelemetryPolicy.initialEnabled(
                endpointAvailable = true,
                hasStoredPreference = true,
                storedEnabled = false,
                endpointMatches = false,
                storedPolicyVersion = 0,
                currentPolicyVersion = 1,
            ),
        )
        assertFalse(
            UsageTelemetryPolicy.initialEnabled(
                endpointAvailable = true,
                hasStoredPreference = true,
                storedEnabled = false,
                endpointMatches = false,
                storedPolicyVersion = 1,
                currentPolicyVersion = 1,
            ),
        )
        assertFalse(
            UsageTelemetryPolicy.initialEnabled(
                endpointAvailable = false,
                hasStoredPreference = true,
                storedEnabled = false,
                endpointMatches = false,
                storedPolicyVersion = 0,
                currentPolicyVersion = 1,
            ),
        )
    }

    @Test
    fun `allows at most one attempt per UTC date`() {
        assertFalse(
            UsageTelemetryPolicy.shouldAttempt(ENDPOINT, true, AppMode.ONLINE, TODAY, TODAY),
        )
        assertTrue(
            UsageTelemetryPolicy.shouldAttempt(ENDPOINT, true, AppMode.ONLINE, "2026-08-20", TODAY),
        )
    }

    @Test
    fun `disabled endpoint never schedules an attempt`() {
        assertFalse(
            UsageTelemetryPolicy.shouldAttempt("", true, AppMode.ONLINE, TODAY, null),
        )
    }

    @Test
    fun `payload contains only the approved aggregate fields`() {
        val payload = UsageTelemetryPayload(
            anonymousId = "anonymous-id",
            date = TODAY,
            appVersion = "1.0.0",
            androidApi = 35,
            mode = "offline",
            locale = "zh-CN",
            timezone = "Asia/Shanghai",
            dailyMetrics = listOf(
                UsageTelemetryDailyMetric(
                    date = TODAY,
                    mode = "offline",
                    callCount = 3,
                    connectedCount = 1,
                    notConnectedCount = 1,
                    unknownCount = 1,
                    totalDurationSeconds = 60,
                ),
            ),
        )

        val keys = JsonParser.parseString(Gson().toJson(payload)).asJsonObject.keySet()

        assertEquals(
            setOf(
                "anonymousId",
                "date",
                "appVersion",
                "androidApi",
                "mode",
                "locale",
                "timezone",
                "dailyMetrics",
            ),
            keys,
        )
    }

    private companion object {
        const val ENDPOINT = "https://metrics.example.com/v1/events"
        const val TODAY = "2026-08-19"
    }
}
