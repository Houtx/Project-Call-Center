package com.company.callcenter.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class AppMode {
    ONLINE,
    OFFLINE,
}

class AppModeStore(
    context: Context,
    legacyDefault: AppMode? = null,
) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val mutableMode = MutableStateFlow(
        preferences.getString(MODE_KEY, null)?.let { stored ->
            AppMode.entries.firstOrNull { it.name == stored }
        } ?: legacyDefault,
    )

    val mode: StateFlow<AppMode?> = mutableMode.asStateFlow()

    fun select(mode: AppMode) {
        preferences.edit().putString(MODE_KEY, mode.name).apply()
        mutableMode.value = mode
    }

    private companion object {
        const val PREFERENCES_NAME = "app_mode"
        const val MODE_KEY = "selected_mode"
    }
}
