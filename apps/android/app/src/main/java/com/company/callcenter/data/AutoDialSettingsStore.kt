package com.company.callcenter.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AutoDialSettingsStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val mutableDelaySeconds = MutableStateFlow(
        normalizeDelay(preferences.getInt(DELAY_SECONDS_KEY, DEFAULT_DELAY_SECONDS)),
    )

    val delaySeconds: StateFlow<Int> = mutableDelaySeconds.asStateFlow()

    fun setDelaySeconds(value: Int) {
        val normalized = normalizeDelay(value)
        preferences.edit().putInt(DELAY_SECONDS_KEY, normalized).apply()
        mutableDelaySeconds.value = normalized
    }

    companion object {
        const val DEFAULT_DELAY_SECONDS = 10
        const val MIN_DELAY_SECONDS = 3
        const val MAX_DELAY_SECONDS = 60

        fun normalizeDelay(value: Int): Int = value.coerceIn(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS)

        private const val PREFERENCES_NAME = "auto_dial_settings"
        private const val DELAY_SECONDS_KEY = "delay_seconds"
    }
}
