package com.company.callcenter.ui

import com.company.callcenter.data.AutoDialSettingsStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AutoDialControllerTest {
    @Test
    fun `enabled controller counts down and dials once`() = runTest {
        var dialCount = 0
        val controller = AutoDialController(
            scope = backgroundScope,
            delaySeconds = MutableStateFlow(3),
            unavailableReason = { null },
            dialNext = { dialCount += 1 },
            onFailure = {},
            tickMillis = 1_000L,
        )

        controller.setHostForeground(true)
        controller.setTaskScreenVisible(true)
        controller.setEnabled(true)
        runCurrent()

        assertEquals(AutoDialPhase.WAITING, controller.state.value.phase)
        assertEquals(3, controller.state.value.remainingSeconds)
        advanceTimeBy(3_000L)
        runCurrent()

        assertEquals(1, dialCount)
        assertEquals(AutoDialPhase.DIALING, controller.state.value.phase)
    }

    @Test
    fun `leaving task screen pauses and returning restarts countdown`() = runTest {
        var dialCount = 0
        val controller = AutoDialController(
            scope = backgroundScope,
            delaySeconds = MutableStateFlow(3),
            unavailableReason = { null },
            dialNext = { dialCount += 1 },
            onFailure = {},
            tickMillis = 1_000L,
        )

        controller.setHostForeground(true)
        controller.setTaskScreenVisible(true)
        controller.setEnabled(true)
        runCurrent()
        advanceTimeBy(1_000L)
        controller.setTaskScreenVisible(false)

        assertEquals(AutoDialPhase.PAUSED, controller.state.value.phase)
        advanceTimeBy(5_000L)
        assertEquals(0, dialCount)

        controller.setTaskScreenVisible(true)
        advanceTimeBy(3_000L)
        runCurrent()
        assertEquals(1, dialCount)
    }

    @Test
    fun `unavailable task pauses until data changes`() = runTest {
        var unavailable = true
        var dialCount = 0
        val controller = AutoDialController(
            scope = backgroundScope,
            delaySeconds = MutableStateFlow(3),
            unavailableReason = { if (unavailable) "暂无可外呼任务" else null },
            dialNext = { dialCount += 1 },
            onFailure = {},
            tickMillis = 1_000L,
        )

        controller.setHostForeground(true)
        controller.setTaskScreenVisible(true)
        controller.setEnabled(true)
        assertEquals(AutoDialPhase.PAUSED, controller.state.value.phase)

        unavailable = false
        controller.onDataChanged()
        advanceTimeBy(3_000L)
        runCurrent()
        assertEquals(1, dialCount)
    }

    @Test
    fun `stopping cancels pending automatic call`() = runTest {
        var dialCount = 0
        val controller = AutoDialController(
            scope = backgroundScope,
            delaySeconds = MutableStateFlow(3),
            unavailableReason = { null },
            dialNext = { dialCount += 1 },
            onFailure = {},
            tickMillis = 1_000L,
        )

        controller.setHostForeground(true)
        controller.setTaskScreenVisible(true)
        controller.setEnabled(true)
        runCurrent()
        controller.stop()
        advanceTimeBy(5_000L)

        assertEquals(0, dialCount)
        assertFalse(controller.state.value.enabled)
        assertEquals(AutoDialPhase.OFF, controller.state.value.phase)
    }

    @Test
    fun `delay normalization stays within supported bounds`() {
        assertEquals(3, AutoDialSettingsStore.normalizeDelay(-1))
        assertEquals(10, AutoDialSettingsStore.normalizeDelay(10))
        assertEquals(60, AutoDialSettingsStore.normalizeDelay(100))
        assertTrue(AutoDialSettingsStore.DEFAULT_DELAY_SECONDS in 3..60)
    }
}
