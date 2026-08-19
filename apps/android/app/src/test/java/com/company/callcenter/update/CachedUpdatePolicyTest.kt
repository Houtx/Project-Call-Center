package com.company.callcenter.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CachedUpdatePolicyTest {
    @Test
    fun `successful checks advance time without lowering the highest seen version`() {
        val previous = CachedUpdateCheck(
            lastSuccessfulCheckAtEpochMillis = 1_000L,
            highestSeenVersionCode = 8L,
        )

        val updated = CachedUpdatePolicy.afterSuccessfulCheck(
            previous = previous,
            releaseVersionCode = 7L,
            checkedAtEpochMillis = 2_000L,
        )

        assertEquals(2_000L, updated.lastSuccessfulCheckAtEpochMillis)
        assertEquals(8L, updated.highestSeenVersionCode)
    }

    @Test
    fun `network failure can use a recent check when the installed version is current`() {
        val now = 1_000_000_000L
        val cached = CachedUpdateCheck(
            lastSuccessfulCheckAtEpochMillis = now - CachedUpdatePolicy.MAX_OFFLINE_GRACE_MILLIS,
            highestSeenVersionCode = 12L,
        )

        assertTrue(
            CachedUpdatePolicy.canUseCachedPolicy(
                cached = cached,
                failureReason = UpdateFailureReason.NETWORK,
                currentVersionCode = 12L,
                nowEpochMillis = now,
            ),
        )
    }

    @Test
    fun `a check older than the grace window cannot unlock the app`() {
        val now = 1_000_000_000L
        val cached = CachedUpdateCheck(
            lastSuccessfulCheckAtEpochMillis = now - CachedUpdatePolicy.MAX_OFFLINE_GRACE_MILLIS - 1L,
            highestSeenVersionCode = 12L,
        )

        assertFalse(
            CachedUpdatePolicy.canUseCachedPolicy(
                cached = cached,
                failureReason = UpdateFailureReason.NETWORK,
                currentVersionCode = 12L,
                nowEpochMillis = now,
            ),
        )
    }

    @Test
    fun `a previously discovered higher version always blocks the older app`() {
        val now = 1_000_000_000L
        val cached = CachedUpdateCheck(
            lastSuccessfulCheckAtEpochMillis = now,
            highestSeenVersionCode = 13L,
        )

        assertFalse(
            CachedUpdatePolicy.canUseCachedPolicy(
                cached = cached,
                failureReason = UpdateFailureReason.NETWORK,
                currentVersionCode = 12L,
                nowEpochMillis = now,
            ),
        )
    }

    @Test
    fun `only network failures are eligible for cached policy`() {
        val now = 1_000_000_000L
        val cached = CachedUpdateCheck(
            lastSuccessfulCheckAtEpochMillis = now,
            highestSeenVersionCode = 12L,
        )

        listOf(
            null,
            UpdateFailureReason.INVALID_METADATA,
            UpdateFailureReason.DOWNLOAD_FAILED,
            UpdateFailureReason.INTEGRITY_FAILED,
            UpdateFailureReason.INVALID_APK,
            UpdateFailureReason.INSTALLER_UNAVAILABLE,
        ).forEach { reason ->
            assertFalse(
                CachedUpdatePolicy.canUseCachedPolicy(
                    cached = cached,
                    failureReason = reason,
                    currentVersionCode = 12L,
                    nowEpochMillis = now,
                ),
            )
        }
    }

    @Test
    fun `missing state and clock rollback fail closed`() {
        assertFalse(
            CachedUpdatePolicy.canUseCachedPolicy(
                cached = CachedUpdatePolicy.Empty,
                failureReason = UpdateFailureReason.NETWORK,
                currentVersionCode = 12L,
                nowEpochMillis = 1_000_000_000L,
            ),
        )
        assertFalse(
            CachedUpdatePolicy.canUseCachedPolicy(
                cached = CachedUpdateCheck(
                    lastSuccessfulCheckAtEpochMillis = 1_000_000_001L,
                    highestSeenVersionCode = 12L,
                ),
                failureReason = UpdateFailureReason.NETWORK,
                currentVersionCode = 12L,
                nowEpochMillis = 1_000_000_000L,
            ),
        )
    }
}
