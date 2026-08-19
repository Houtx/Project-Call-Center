package com.company.callcenter.data.offline

data class OfflineCallSettlement(
    val state: OfflineContactState,
    val completedAt: Long?,
)

object OfflineCallPolicy {
    fun canCall(state: OfflineContactState, attemptCount: Int, maximumAttempts: Int): Boolean {
        require(attemptCount >= 0)
        require(maximumAttempts > 0)
        return state != OfflineContactState.CONNECTED &&
            state != OfflineContactState.COLLECTING &&
            attemptCount < maximumAttempts
    }

    fun settle(
        result: OfflineCallResult,
        attemptCount: Int,
        maximumAttempts: Int,
        observedAt: Long,
    ): OfflineCallSettlement {
        require(attemptCount > 0)
        require(maximumAttempts > 0)
        require(observedAt > 0)
        return when {
            result == OfflineCallResult.CONNECTED -> OfflineCallSettlement(
                state = OfflineContactState.CONNECTED,
                completedAt = observedAt,
            )
            attemptCount >= maximumAttempts -> OfflineCallSettlement(
                state = OfflineContactState.EXHAUSTED,
                completedAt = observedAt,
            )
            else -> OfflineCallSettlement(
                state = OfflineContactState.RETRY,
                completedAt = null,
            )
        }
    }
}
