package com.company.callcenter.ui

import com.company.callcenter.data.AutoDialSettingsStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class AutoDialPhase {
    OFF,
    READY,
    WAITING,
    DIALING,
    PAUSED,
}

data class AutoDialUiState(
    val enabled: Boolean = false,
    val phase: AutoDialPhase = AutoDialPhase.OFF,
    val delaySeconds: Int = AutoDialSettingsStore.DEFAULT_DELAY_SECONDS,
    val remainingSeconds: Int? = null,
    val message: String = "自动拨号已关闭",
)

internal class AutoDialController(
    private val scope: CoroutineScope,
    delaySeconds: StateFlow<Int>,
    private val unavailableReason: () -> String?,
    private val dialNext: suspend () -> Unit,
    private val onFailure: (Throwable) -> Unit,
    private val tickMillis: Long = 1_000L,
) {
    private val mutableState = MutableStateFlow(
        AutoDialUiState(delaySeconds = AutoDialSettingsStore.normalizeDelay(delaySeconds.value)),
    )
    val state: StateFlow<AutoDialUiState> = mutableState.asStateFlow()

    private var countdownJob: Job? = null
    private var countdownGeneration = 0L
    private var hostForeground = false
    private var taskScreenVisible = false

    init {
        scope.launch {
            delaySeconds.collect { value ->
                val normalized = AutoDialSettingsStore.normalizeDelay(value)
                val wasWaiting = mutableState.value.phase == AutoDialPhase.WAITING
                mutableState.value = mutableState.value.copy(delaySeconds = normalized)
                if (wasWaiting) {
                    cancelCountdown()
                    markReadyAndReconsider()
                }
            }
        }
    }

    fun setEnabled(enabled: Boolean) {
        if (!enabled) {
            stop("自动拨号已关闭")
            return
        }
        if (mutableState.value.enabled) return
        mutableState.value = mutableState.value.copy(
            enabled = true,
            phase = AutoDialPhase.READY,
            remainingSeconds = null,
            message = "自动拨号已开启，正在检查下一条任务",
        )
        reconsider()
    }

    fun stop(message: String = "自动拨号已关闭") {
        cancelCountdown()
        mutableState.value = mutableState.value.copy(
            enabled = false,
            phase = AutoDialPhase.OFF,
            remainingSeconds = null,
            message = message,
        )
    }

    fun setHostForeground(foreground: Boolean) {
        hostForeground = foreground
        if (!foreground) pause("自动拨号已暂停，返回 APP 后继续")
    }

    fun setTaskScreenVisible(visible: Boolean) {
        taskScreenVisible = visible
        if (visible) reconsider() else pause("自动拨号已暂停，返回任务页后继续")
    }

    fun onForegroundReconciled() {
        hostForeground = true
        if (mutableState.value.enabled && mutableState.value.phase == AutoDialPhase.DIALING) {
            mutableState.value = mutableState.value.copy(
                phase = AutoDialPhase.READY,
                remainingSeconds = null,
                message = "上一通已结束，正在核验通话结果",
            )
        }
        reconsider()
    }

    fun onDataChanged() {
        if (mutableState.value.enabled && mutableState.value.phase != AutoDialPhase.DIALING) {
            reconsider()
        }
    }

    fun onDialLaunchFailed(failure: Throwable) {
        stop("自动拨号已停止：${failure.message ?: "无法发起外呼"}")
    }

    fun reconsider() {
        val current = mutableState.value
        if (!current.enabled || current.phase == AutoDialPhase.DIALING) return
        val reason = pauseReason()
        if (reason != null) {
            pause(reason)
            return
        }
        if (countdownJob?.isActive == true) return
        startCountdown()
    }

    private fun markReadyAndReconsider() {
        if (!mutableState.value.enabled) return
        mutableState.value = mutableState.value.copy(
            phase = AutoDialPhase.READY,
            remainingSeconds = null,
            message = "自动拨号已开启，正在准备下一条任务",
        )
        reconsider()
    }

    private fun startCountdown() {
        cancelCountdown()
        val generation = ++countdownGeneration
        countdownJob = scope.launch {
            val totalSeconds = mutableState.value.delaySeconds
            try {
                for (remaining in totalSeconds downTo 1) {
                    pauseReason()?.let { reason ->
                        pause(reason)
                        return@launch
                    }
                    mutableState.value = mutableState.value.copy(
                        phase = AutoDialPhase.WAITING,
                        remainingSeconds = remaining,
                        message = "$remaining 秒后自动拨打下一条",
                    )
                    delay(tickMillis)
                }
                pauseReason()?.let { reason ->
                    pause(reason)
                    return@launch
                }
                mutableState.value = mutableState.value.copy(
                    phase = AutoDialPhase.DIALING,
                    remainingSeconds = null,
                    message = "正在发起自动外呼",
                )
                dialNext()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                stop("自动拨号已停止：${failure.message ?: "无法发起外呼"}")
                onFailure(failure)
            } finally {
                if (countdownGeneration == generation) countdownJob = null
            }
        }
    }

    private fun pauseReason(): String? = when {
        !hostForeground -> "自动拨号已暂停，返回 APP 后继续"
        !taskScreenVisible -> "自动拨号已暂停，返回任务页后继续"
        else -> unavailableReason()
    }

    private fun pause(reason: String) {
        if (!mutableState.value.enabled) return
        cancelCountdown()
        mutableState.value = mutableState.value.copy(
            phase = AutoDialPhase.PAUSED,
            remainingSeconds = null,
            message = reason,
        )
    }

    private fun cancelCountdown() {
        countdownGeneration += 1
        countdownJob?.cancel()
        countdownJob = null
    }
}
