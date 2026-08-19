package com.company.callcenter.data.offline

import com.company.callcenter.data.AppMode
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class OfflineCallStateCoordinator {
    private val mutex = Mutex()

    suspend fun <T> serialized(block: suspend () -> T): T = mutex.withLock { block() }
}

internal object OfflineDialAccessPolicy {
    fun canAuthorize(mode: AppMode?, unlocked: Boolean): Boolean =
        mode == AppMode.OFFLINE && unlocked
}
