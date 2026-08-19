package com.company.callcenter.data.offline

import com.company.callcenter.data.AppMode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineCallPolicyTest {
    @Test
    fun `first missed call remains available for the default second attempt`() {
        val settlement = OfflineCallPolicy.settle(
            result = OfflineCallResult.NOT_CONNECTED,
            attemptCount = 1,
            maximumAttempts = 2,
            observedAt = 5_000L,
        )

        assertEquals(OfflineContactState.RETRY, settlement.state)
        assertNull(settlement.completedAt)
        assertTrue(OfflineCallPolicy.canCall(settlement.state, 1, 2))
    }

    @Test
    fun `second missed call exhausts the contact`() {
        val settlement = OfflineCallPolicy.settle(
            result = OfflineCallResult.NOT_CONNECTED,
            attemptCount = 2,
            maximumAttempts = 2,
            observedAt = 5_000L,
        )

        assertEquals(OfflineContactState.EXHAUSTED, settlement.state)
        assertEquals(5_000L, settlement.completedAt)
        assertFalse(OfflineCallPolicy.canCall(settlement.state, 2, 2))
    }

    @Test
    fun `connected calls complete immediately and unknown follows retry limit`() {
        assertEquals(
            OfflineContactState.CONNECTED,
            OfflineCallPolicy.settle(OfflineCallResult.CONNECTED, 1, 2, 1_000L).state,
        )
        assertEquals(
            OfflineContactState.RETRY,
            OfflineCallPolicy.settle(OfflineCallResult.UNKNOWN, 1, 2, 1_000L).state,
        )
    }

    @Test
    fun `offline dialing requires both offline mode and an unlocked store`() {
        assertTrue(OfflineDialAccessPolicy.canAuthorize(AppMode.OFFLINE, unlocked = true))
        assertFalse(OfflineDialAccessPolicy.canAuthorize(AppMode.OFFLINE, unlocked = false))
        assertFalse(OfflineDialAccessPolicy.canAuthorize(AppMode.ONLINE, unlocked = true))
        assertFalse(OfflineDialAccessPolicy.canAuthorize(null, unlocked = true))
    }

    @Test
    fun `retry limit changes wait for an in-flight settlement`() = runTest {
        val coordinator = OfflineCallStateCoordinator()
        val releaseSettlement = CompletableDeferred<Unit>()
        val events = mutableListOf<String>()

        launch {
            coordinator.serialized {
                events += "settlement-start"
                releaseSettlement.await()
                events += "settlement-end"
            }
        }
        runCurrent()
        launch {
            coordinator.serialized { events += "limit-change" }
        }
        runCurrent()

        assertEquals(listOf("settlement-start"), events)
        releaseSettlement.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf("settlement-start", "settlement-end", "limit-change"), events)
    }
}
