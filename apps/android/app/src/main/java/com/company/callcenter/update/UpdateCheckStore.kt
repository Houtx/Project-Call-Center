package com.company.callcenter.update

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal class UpdateCheckStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    suspend fun recordSuccessfulCheck(
        releaseVersionCode: Long,
    ): Long = withContext(Dispatchers.IO) {
        synchronized(STORE_LOCK) {
            val highestSeenVersionCode = UpdatePolicy.highestSeenVersion(
                previousVersionCode = preferences.getLong(HIGHEST_SEEN_VERSION_KEY, 0L).coerceAtLeast(0L),
                releaseVersionCode = releaseVersionCode,
            )
            check(
                preferences.edit()
                    .putLong(HIGHEST_SEEN_VERSION_KEY, highestSeenVersionCode)
                    .remove(LEGACY_LAST_SUCCESSFUL_CHECK_KEY)
                    .commit(),
            ) { "Unable to persist update check state" }
            highestSeenVersionCode
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "update_check_policy"
        const val LEGACY_LAST_SUCCESSFUL_CHECK_KEY = "last_successful_check_at"
        const val HIGHEST_SEEN_VERSION_KEY = "highest_seen_version_code"
        val STORE_LOCK = Any()
    }
}
