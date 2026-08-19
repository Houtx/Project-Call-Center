package com.company.callcenter.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.company.callcenter.data.AppMode
import com.company.callcenter.data.AppModeStore
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
)

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AgentViewModel(
    private val repository: CallCenterRepository,
    private val simCallManager: SimCallManager,
    private val appModeStore: AppModeStore,
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
    private val statistics = statisticsRange.flatMapLatest(repository::statistics)
    private val assignmentsWithPolicy = combine(
        repository.assignments,
        repository.maxCallAttempts,
    ) { assignments, maxCallAttempts -> assignments to maxCallAttempts }

    private val activityData = combine(
        repository.history,
        repository.hasPendingCall,
        statistics,
    ) { history, pending, stats -> Triple(history, pending, stats) }

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
            history = activity.first,
            hasPendingCall = activity.second,
            statistics = activity.third,
            statisticsRange = statisticsRange.value,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), transient.value)

    init {
        viewModelScope.launch {
            simCallManager.state.collectLatest { simDial ->
                transient.value = transient.value.copy(simDial = simDial)
            }
        }
        viewModelScope.launch {
            appModeStore.mode.collectLatest { mode ->
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
            }
        }
    }

    private fun checkOnlineMode() {
        check(appModeStore.mode.value == AppMode.ONLINE) { "当前不是在线模式" }
    }

    private companion object {
        const val SESSION_CHECK_INTERVAL_MS = 15_000L
    }
}

class AgentViewModelFactory(
    private val repository: CallCenterRepository,
    private val simCallManager: SimCallManager,
    private val appModeStore: AppModeStore,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AgentViewModel(repository, simCallManager, appModeStore) as T
}
