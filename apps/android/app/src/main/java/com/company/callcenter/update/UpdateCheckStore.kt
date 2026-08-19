package com.company.callcenter.update

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal data class CachedUpdateCheck(
    val lastSuccessfulCheckAtEpochMillis: Long,
    val highestSeenVersionCode: Long,
)

internal object CachedUpdatePolicy {
    const val MAX_OFFLINE_GRACE_MILLIS = 72L * 60L * 60L * 1_000L

    fun afterSuccessfulCheck(
        previous: CachedUpdateCheck,
        releaseVersionCode: Long,
        checkedAtEpochMillis: Long,
    ): CachedUpdateCheck {
        require(releaseVersionCode > 0) { "Release version code must be positive" }
        require(checkedAtEpochMillis > 0) { "Check time must be positive" }
        return CachedUpdateCheck(
            lastSuccessfulCheckAtEpochMillis = checkedAtEpochMillis,
            highestSeenVersionCode = maxOf(previous.highestSeenVersionCode, releaseVersionCode),
        )
    }

    fun canUseCachedPolicy(
        cached: CachedUpdateCheck,
        failureReason: UpdateFailureReason?,
        currentVersionCode: Long,
        nowEpochMillis: Long,
    ): Boolean {
        if (failureReason != UpdateFailureReason.NETWORK) return false
        if (currentVersionCode <= 0 || cached.highestSeenVersionCode <= 0) return false
        if (currentVersionCode < cached.highestSeenVersionCode) return false
        val ageMillis = nowEpochMillis - cached.lastSuccessfulCheckAtEpochMillis
        return ageMillis in 0..MAX_OFFLINE_GRACE_MILLIS
    }

    val Empty = CachedUpdateCheck(
        lastSuccessfulCheckAtEpochMillis = 0L,
        highestSeenVersionCode = 0L,
    )
}

internal class UpdateCheckStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun read(): CachedUpdateCheck = synchronized(STORE_LOCK) {
        CachedUpdateCheck(
            lastSuccessfulCheckAtEpochMillis = preferences.getLong(LAST_SUCCESSFUL_CHECK_KEY, 0L)
                .coerceAtLeast(0L),
            highestSeenVersionCode = preferences.getLong(HIGHEST_SEEN_VERSION_KEY, 0L)
                .coerceAtLeast(0L),
        )
    }

    suspend fun recordSuccessfulCheck(
        releaseVersionCode: Long,
        checkedAtEpochMillis: Long = System.currentTimeMillis(),
    ): CachedUpdateCheck = withContext(Dispatchers.IO) {
        synchronized(STORE_LOCK) {
            val updated = CachedUpdatePolicy.afterSuccessfulCheck(
                previous = CachedUpdateCheck(
                    lastSuccessfulCheckAtEpochMillis = preferences.getLong(LAST_SUCCESSFUL_CHECK_KEY, 0L)
                        .coerceAtLeast(0L),
                    highestSeenVersionCode = preferences.getLong(HIGHEST_SEEN_VERSION_KEY, 0L)
                        .coerceAtLeast(0L),
                ),
                releaseVersionCode = releaseVersionCode,
                checkedAtEpochMillis = checkedAtEpochMillis,
            )
            check(
                preferences.edit()
                    .putLong(LAST_SUCCESSFUL_CHECK_KEY, updated.lastSuccessfulCheckAtEpochMillis)
                    .putLong(HIGHEST_SEEN_VERSION_KEY, updated.highestSeenVersionCode)
                    .commit(),
            ) { "Unable to persist update check state" }
            updated
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "update_check_policy"
        const val LAST_SUCCESSFUL_CHECK_KEY = "last_successful_check_at"
        const val HIGHEST_SEEN_VERSION_KEY = "highest_seen_version_code"
        val STORE_LOCK = Any()
    }
}
