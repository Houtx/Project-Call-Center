package com.company.callcenter.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.company.callcenter.data.AppMode
import com.company.callcenter.data.AppModeStore
import com.company.callcenter.data.AutoDialSettingsStore
import com.company.callcenter.data.CallCenterRepository
import com.company.callcenter.data.CallStatistics
import com.company.callcenter.data.CallStatisticsRange
import com.company.callcenter.data.DialAuthorization
import com.company.callcenter.data.ServerConnectionState
import com.company.callcenter.data.ServerConnectionStatus
import com.company.callcenter.data.local.AssignedCustomerEntity
import com.company.callcenter.data.local.CallHistoryEntity
import com.company.callcenter.telephony.SimCallManager
import com.company.callcenter.telephony.SimDialMode
import com.company.callcenter.telephony.SimDialState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext
import java.util.concurrent.atomic.AtomicBoolean

data class AgentUiState(
    val loggedIn: Boolean = false,
    val displayName: String = "",
    val assignments: List<AssignedCustomerEntity> = emptyList(),
    val maxCallAttempts: Int = 2,
    val history: List<CallHistoryEntity> = emptyList(),
    val statistics: CallStatistics = CallStatistics(),
    val statisticsRange: CallStatisticsRange = CallStatisticsRange.TODAY,
    val hasPendingCall: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val revealedPhone: String? = null,
    val simDial: SimDialState = SimDialState(),
    val serverConnection: ServerConnectionState = ServerConnectionState(
        status = ServerConnectionStatus.NOT_CONFIGURED,
    ),
    val autoDial: AutoDialUiState = AutoDialUiState(),
)

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AgentViewModel(
    private val repository: CallCenterRepository,
    private val simCallManager: SimCallManager,
    private val appModeStore: AppModeStore,
    private val autoDialSettings: AutoDialSettingsStore,
) : ViewModel() {
    private val transient = MutableStateFlow(
        AgentUiState(
            loggedIn = repository.isLoggedIn,
            displayName = repository.displayName.orEmpty(),
            simDial = simCallManager.state.value,
        ),
    )

    private val dialChannel = Channel<DialAuthorization>(capacity = Channel.BUFFERED)
    val dialEvents = dialChannel.receiveAsFlow()
    private val statisticsRange = MutableStateFlow(CallStatisticsRange.TODAY)
    private val operationInProgress = AtomicBoolean(false)
    @Volatile private var latestAssignments: List<AssignedCustomerEntity> = emptyList()
    @Volatile private var latestHasPendingCall = false
    @Volatile private var latestMaxCallAttempts = 2
    private val autoDialController = AutoDialController(
        scope = viewModelScope,
        delaySeconds = autoDialSettings.delaySeconds,
        unavailableReason = ::autoDialUnavailableReason,
        dialNext = ::authorizeNextAutomaticCall,
        onFailure = { failure ->
            transient.value = transient.value.copy(error = failure.message ?: "自动拨号失败，请稍后重试")
        },
    )
    private val statistics = statisticsRange.flatMapLatest(repository::statistics)
    private val assignmentsWithPolicy = combine(
        repository.assignments,
        repository.maxCallAttempts,
    ) { assignments, maxCallAttempts -> assignments to maxCallAttempts }

    private data class ActivityData(
        val history: List<CallHistoryEntity>,
        val pending: Boolean,
        val statistics: CallStatistics,
        val autoDial: AutoDialUiState,
    )

    private val activityData = combine(
        repository.history,
        repository.hasPendingCall,
        statistics,
        autoDialController.state,
        ::ActivityData,
    )

    val state: StateFlow<AgentUiState> = combine(
        transient,
        repository.serverConnection,
        assignmentsWithPolicy,
        activityData,
    ) { current, serverConnection, assignmentPolicy, activity ->
        current.copy(
            // A server that has not been verified is not usable, even if an old
            // token remains in secure storage. This sends the agent back to the
            // startup form as soon as the configured endpoint becomes invalid.
            loggedIn = current.loggedIn && repository.isLoggedIn &&
                serverConnection.status == ServerConnectionStatus.READY,
            serverConnection = serverConnection,
            assignments = assignmentPolicy.first,
            maxCallAttempts = assignmentPolicy.second,
            history = activity.history,
            hasPendingCall = activity.pending,
            statistics = activity.statistics,
            statisticsRange = statisticsRange.value,
            autoDial = activity.autoDial,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), transient.value)

    init {
        viewModelScope.launch {
            simCallManager.state.collectLatest { simDial ->
                transient.value = transient.value.copy(simDial = simDial)
                autoDialController.onDataChanged()
            }
        }
        viewModelScope.launch {
            combine(
                repository.assignments,
                repository.hasPendingCall,
                repository.maxCallAttempts,
            ) { assignments, pending, maximumAttempts -> Triple(assignments, pending, maximumAttempts) }
                .collect { (assignments, pending, maximumAttempts) ->
                latestAssignments = assignments
                latestHasPendingCall = pending
                latestMaxCallAttempts = maximumAttempts
                autoDialController.onDataChanged()
            }
        }
        viewModelScope.launch {
            appModeStore.mode.collectLatest { mode ->
                if (mode != AppMode.ONLINE) {
                    autoDialController.stop("已切换模式，自动拨号已关闭")
                }
                if (mode != AppMode.ONLINE ||
                    repository.serverConnection.value.status == ServerConnectionStatus.NOT_CONFIGURED
                ) {
                    return@collectLatest
                }
                transient.value = transient.value.copy(loading = true, error = null)
                try {
                    repository.validateServerConfiguration()
                    if (repository.isLoggedIn) refreshData(validateServer = false)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    transient.value = transient.value.copy(
                        loggedIn = false,
                        loading = false,
                        error = failure.message ?: "无法连接服务器，请重新配置",
                    )
                } finally {
                    if (transient.value.loading) {
                        transient.value = transient.value.copy(loading = false)
                    }
                }
            }
        }
        viewModelScope.launch {
            combine(appModeStore.mode, repository.hasPendingCall) { mode, pending ->
                mode == AppMode.ONLINE && pending
            }.distinctUntilChanged().collectLatest { shouldReconcile ->
                while (shouldReconcile && coroutineContext.isActive) {
                    try {
                        repository.refreshSession()
                        repository.reconcilePending()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Throwable) {
                        // WorkManager and the next foreground pass will retry.
                    }
                    delay(5_000)
                }
            }
        }
        viewModelScope.launch {
            while (coroutineContext.isActive) {
                delay(SESSION_CHECK_INTERVAL_MS)
                if (appModeStore.mode.value != AppMode.ONLINE || !repository.isLoggedIn) continue
                try {
                    repository.validateCompatibility()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    if (!repository.isLoggedIn) {
                        transient.value = transient.value.copy(
                            loggedIn = false,
                            error = failure.message ?: "登录已失效，请重新登录",
                        )
                    }
                }
            }
        }
    }

    fun signIn(serverAddress: String, username: String, password: String) {
        launchBusy {
            checkOnlineMode()
            repository.configureServer(serverAddress)
            val response = repository.login(username, password)
            transient.value = transient.value.copy(
                loggedIn = true,
                displayName = response.user.name,
            )
            repository.heartbeat()
            repository.sync()
        }
    }

    fun refresh() = launchBusy(clearError = false) { refreshData() }

    private suspend fun refreshData(validateServer: Boolean = true) {
        checkOnlineMode()
        simCallManager.refresh()
        if (validateServer) repository.validateServerConfiguration()
        checkOnlineMode()
        repository.refreshSession()
        checkOnlineMode()
        repository.heartbeat()
        checkOnlineMode()
        repository.validateCompatibility()
        checkOnlineMode()
        repository.reconcilePending()
        checkOnlineMode()
        repository.sync()
    }

    fun onReturnedToForeground() {
        if (appModeStore.mode.value != AppMode.ONLINE || !repository.isLoggedIn) return
        viewModelScope.launch {
            try {
                repository.validateServerConfiguration()
                checkOnlineMode()
                repository.refreshSession()
                checkOnlineMode()
                repository.reconcilePending()
                checkOnlineMode()
                repository.sync()
                autoDialController.onForegroundReconciled()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                transient.value = transient.value.copy(error = failure.message ?: "同步失败，请稍后重试")
            }
        }
    }

    fun revealPhone(assignmentId: String) = launchBusy {
        checkOnlineMode()
        transient.value = transient.value.copy(revealedPhone = repository.revealPhone(assignmentId))
    }

    fun revealHistoryPhone(attemptId: String) = launchBusy {
        checkOnlineMode()
        transient.value = transient.value.copy(revealedPhone = repository.revealHistoryPhone(attemptId))
    }

    fun dismissPhone() {
        transient.value = transient.value.copy(revealedPhone = null)
    }

    fun call(assignmentId: String) = launchBusy {
        checkOnlineMode()
        simCallManager.requireAvailableSim()
        val authorization = repository.authorizeCall(assignmentId)
        dialChannel.send(authorization)
    }

    fun setAutoDialEnabled(enabled: Boolean) {
        autoDialController.setEnabled(enabled)
    }

    fun setAutoDialTaskScreenVisible(visible: Boolean) {
        autoDialController.setTaskScreenVisible(visible)
    }

    fun onMovedToBackground() {
        autoDialController.setHostForeground(false)
    }

    fun setAutoDialDelaySeconds(value: Int) {
        autoDialSettings.setDelaySeconds(value)
    }

    fun setSimDialMode(mode: SimDialMode) {
        simCallManager.setMode(mode)
    }

    fun setStatisticsRange(range: CallStatisticsRange) {
        statisticsRange.value = range
    }

    fun refreshSimConfiguration() {
        simCallManager.refresh()
    }

    fun reportDialLaunchFailure(attemptId: String, failure: Throwable) {
        autoDialController.onDialLaunchFailed(failure)
        viewModelScope.launch {
            val cancelled = runCatching { repository.cancelFailedCallAttempt(attemptId) }
            transient.value = transient.value.copy(
                error = if (cancelled.isSuccess) {
                    failure.message ?: "无法通过所选 SIM 卡发起外呼，本次尝试已撤销"
                } else {
                    "${failure.message ?: "无法发起外呼"}；服务器撤销失败，请保持网络连接并稍后重试"
                },
            )
        }
    }

    fun logout() {
        if (state.value.hasPendingCall) {
            transient.value = transient.value.copy(error = "通话记录仍在采集中，完成采集后才能退出")
            return
        }
        autoDialController.stop("已退出登录，自动拨号已关闭")
        viewModelScope.launch {
            repository.logout()
            transient.value = AgentUiState(
                simDial = simCallManager.state.value,
            )
        }
    }

    fun changeServer() {
        if (state.value.hasPendingCall) {
            transient.value = transient.value.copy(error = "通话记录仍在采集中，完成采集后才能切换服务器")
            return
        }
        autoDialController.stop("正在切换服务器，自动拨号已关闭")
        viewModelScope.launch {
            repository.logout()
            transient.value = AgentUiState(
                simDial = simCallManager.state.value,
            )
        }
    }

    fun clearError() {
        transient.value = transient.value.copy(error = null)
    }

    private fun launchBusy(clearError: Boolean = true, block: suspend () -> Unit) {
        if (!operationInProgress.compareAndSet(false, true)) return
        viewModelScope.launch {
            transient.value = transient.value.copy(loading = true, error = if (clearError) null else transient.value.error)
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                transient.value = transient.value.copy(error = failure.message ?: "操作失败，请稍后重试")
            } finally {
                operationInProgress.set(false)
                transient.value = transient.value.copy(loading = false)
                autoDialController.onDataChanged()
            }
        }
    }

    private fun checkOnlineMode() {
        check(appModeStore.mode.value == AppMode.ONLINE) { "当前不是在线模式" }
    }

    private fun autoDialUnavailableReason(): String? {
        val now = System.currentTimeMillis()
        return when {
            appModeStore.mode.value != AppMode.ONLINE -> "当前不是在线模式"
            !repository.isLoggedIn -> "登录已失效，自动拨号已暂停"
            operationInProgress.get() -> "正在处理其他操作，自动拨号已暂停"
            latestHasPendingCall -> "正在等待上一通结束并采集结果"
            !simCallManager.state.value.canDial -> "未检测到可用的 SIM 卡或系统电话服务"
            latestAssignments.none { assignment ->
                assignment.attemptCount < latestMaxCallAttempts &&
                    (assignment.nextCallAllowedAt == null || assignment.nextCallAllowedAt <= now)
            } -> "暂无当前可外呼的任务"
            else -> null
        }
    }

    private suspend fun authorizeNextAutomaticCall() {
        checkOnlineMode()
        val now = System.currentTimeMillis()
        val next = latestAssignments.firstOrNull { assignment ->
            assignment.attemptCount < latestMaxCallAttempts &&
                (assignment.nextCallAllowedAt == null || assignment.nextCallAllowedAt <= now)
        } ?: error("暂无当前可外呼的任务")
        simCallManager.requireAvailableSim()
        dialChannel.send(repository.authorizeCall(next.assignmentId))
    }

    private companion object {
        const val SESSION_CHECK_INTERVAL_MS = 15_000L
    }
}

class AgentViewModelFactory(
    private val repository: CallCenterRepository,
    private val simCallManager: SimCallManager,
    private val appModeStore: AppModeStore,
    private val autoDialSettings: AutoDialSettingsStore,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AgentViewModel(repository, simCallManager, appModeStore, autoDialSettings) as T
}
