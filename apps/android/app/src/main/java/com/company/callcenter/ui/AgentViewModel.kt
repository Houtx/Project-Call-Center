package com.company.callcenter.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.company.callcenter.data.CallCenterRepository
import com.company.callcenter.data.DialAuthorization
import com.company.callcenter.data.ServerConnectionState
import com.company.callcenter.data.ServerConnectionStatus
import com.company.callcenter.data.local.AssignedCustomerEntity
import com.company.callcenter.data.local.CallHistoryEntity
import com.company.callcenter.telephony.SimCallManager
import com.company.callcenter.telephony.SimDialMode
import com.company.callcenter.telephony.SimDialState
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

data class AgentUiState(
    val loggedIn: Boolean = false,
    val displayName: String = "",
    val assignments: List<AssignedCustomerEntity> = emptyList(),
    val maxCallAttempts: Int = 2,
    val history: List<CallHistoryEntity> = emptyList(),
    val hasPendingCall: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val revealedPhone: String? = null,
    val simDial: SimDialState = SimDialState(),
    val serverConnection: ServerConnectionState = ServerConnectionState(
        status = ServerConnectionStatus.NOT_CONFIGURED,
    ),
)

class AgentViewModel(
    private val repository: CallCenterRepository,
    private val simCallManager: SimCallManager,
) : ViewModel() {
    private val transient = MutableStateFlow(
        AgentUiState(
            loggedIn = repository.isLoggedIn,
            displayName = repository.displayName.orEmpty(),
            simDial = simCallManager.state.value,
        ),
    )

    val dialEvents = MutableSharedFlow<DialAuthorization>(extraBufferCapacity = 1)
    private val assignmentsWithPolicy = combine(
        repository.assignments,
        repository.maxCallAttempts,
    ) { assignments, maxCallAttempts -> assignments to maxCallAttempts }

    val state: StateFlow<AgentUiState> = combine(
        transient,
        repository.serverConnection,
        assignmentsWithPolicy,
        repository.history,
        repository.hasPendingCall,
    ) { current, serverConnection, assignmentPolicy, history, pending ->
        current.copy(
            // A server that has not been verified is not usable, even if an old
            // token remains in secure storage. This sends the agent back to the
            // startup form as soon as the configured endpoint becomes invalid.
            loggedIn = current.loggedIn && repository.isLoggedIn &&
                serverConnection.status == ServerConnectionStatus.READY,
            serverConnection = serverConnection,
            assignments = assignmentPolicy.first,
            maxCallAttempts = assignmentPolicy.second,
            history = history,
            hasPendingCall = pending,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), transient.value)

    init {
        viewModelScope.launch {
            simCallManager.state.collectLatest { simDial ->
                transient.value = transient.value.copy(simDial = simDial)
            }
        }
        if (repository.serverConnection.value.status != ServerConnectionStatus.NOT_CONFIGURED) {
            viewModelScope.launch {
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
            repository.hasPendingCall.distinctUntilChanged().collectLatest { pending ->
                while (pending && coroutineContext.isActive) {
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
                if (!repository.isLoggedIn) continue
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
        simCallManager.refresh()
        if (validateServer) repository.validateServerConfiguration()
        repository.refreshSession()
        repository.heartbeat()
        repository.validateCompatibility()
        repository.reconcilePending()
        repository.sync()
    }

    fun onReturnedToForeground() {
        if (!repository.isLoggedIn) return
        viewModelScope.launch {
            try {
                repository.validateServerConfiguration()
                repository.refreshSession()
                repository.reconcilePending()
                repository.sync()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                transient.value = transient.value.copy(error = failure.message ?: "同步失败，请稍后重试")
            }
        }
    }

    fun revealPhone(assignmentId: String) = launchBusy {
        transient.value = transient.value.copy(revealedPhone = repository.revealPhone(assignmentId))
    }

    fun revealHistoryPhone(attemptId: String) = launchBusy {
        transient.value = transient.value.copy(revealedPhone = repository.revealHistoryPhone(attemptId))
    }

    fun dismissPhone() {
        transient.value = transient.value.copy(revealedPhone = null)
    }

    fun call(assignmentId: String) = launchBusy {
        simCallManager.requireAvailableSim()
        val authorization = repository.authorizeCall(assignmentId)
        dialEvents.emit(authorization)
    }

    fun setSimDialMode(mode: SimDialMode) {
        simCallManager.setMode(mode)
    }

    fun refreshSimConfiguration() {
        simCallManager.refresh()
    }

    fun reportDialLaunchFailure(failure: Throwable) {
        transient.value = transient.value.copy(
            error = failure.message ?: "无法通过所选 SIM 卡发起外呼",
        )
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
        viewModelScope.launch {
            transient.value = transient.value.copy(loading = true, error = if (clearError) null else transient.value.error)
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                transient.value = transient.value.copy(error = failure.message ?: "操作失败，请稍后重试")
            } finally {
                transient.value = transient.value.copy(loading = false)
            }
        }
    }

    private companion object {
        const val SESSION_CHECK_INTERVAL_MS = 15_000L
    }
}

class AgentViewModelFactory(
    private val repository: CallCenterRepository,
    private val simCallManager: SimCallManager,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AgentViewModel(repository, simCallManager) as T
}
