package com.company.callcenter.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.company.callcenter.data.CallStatistics
import com.company.callcenter.data.CallStatisticsRange
import com.company.callcenter.data.DialAuthorization
import com.company.callcenter.data.offline.OfflineCallRecord
import com.company.callcenter.data.offline.OfflineCleanupResult
import com.company.callcenter.data.offline.OfflineContact
import com.company.callcenter.data.offline.OfflineContactState
import com.company.callcenter.data.offline.OfflineImportResult
import com.company.callcenter.data.offline.OfflineImportService
import com.company.callcenter.data.offline.OfflineSpreadsheetSession
import com.company.callcenter.data.offline.OfflineRepository
import com.company.callcenter.data.offline.OfflineTaskFilter
import com.company.callcenter.offline.importing.PastePhoneParseResult
import com.company.callcenter.offline.importing.SpreadsheetSheetPreview
import com.company.callcenter.telephony.SimCallManager
import com.company.callcenter.telephony.SimDialMode
import com.company.callcenter.telephony.SimDialState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

data class OfflineCleanupConfirmation(
    val days: Int,
    val contactCount: Int,
)

sealed interface OfflineImportUiState {
    data object Idle : OfflineImportUiState
    data object Loading : OfflineImportUiState
    data class Spreadsheet(
        val session: OfflineSpreadsheetSession,
        val selectedSheetId: String,
        val phoneColumnIndex: Int,
        val nameColumnIndex: Int? = null,
        val skipHeader: Boolean = true,
    ) : OfflineImportUiState {
        val selectedSheet: SpreadsheetSheetPreview
            get() = session.preview.sheets.first { it.id == selectedSheetId }
    }
    data class PastePreview(
        val source: String,
        val parsed: PastePhoneParseResult,
    ) : OfflineImportUiState
    data class Completed(val result: OfflineImportResult) : OfflineImportUiState
}

data class OfflineUiState(
    val configured: Boolean = false,
    val unlocked: Boolean = false,
    val contacts: List<OfflineContact> = emptyList(),
    val filteredContacts: List<OfflineContact> = emptyList(),
    val history: List<OfflineCallRecord> = emptyList(),
    val taskFilter: OfflineTaskFilter = OfflineTaskFilter.PENDING,
    val statistics: CallStatistics = CallStatistics(),
    val statisticsRange: CallStatisticsRange = CallStatisticsRange.TODAY,
    val maximumAttempts: Int = 2,
    val hasPendingCall: Boolean = false,
    val simDial: SimDialState = SimDialState(),
    val loading: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val revealedPhone: String? = null,
    val unlockRetryAfterSeconds: Long = 0,
    val cleanupConfirmation: OfflineCleanupConfirmation? = null,
    val importState: OfflineImportUiState = OfflineImportUiState.Idle,
)

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineViewModel(
    private val repository: OfflineRepository,
    private val simCallManager: SimCallManager,
    private val importService: OfflineImportService,
) : ViewModel() {
    private val transient = MutableStateFlow(OfflineUiState(simDial = simCallManager.state.value))
    private val taskFilter = MutableStateFlow(OfflineTaskFilter.PENDING)
    private val statisticsRange = MutableStateFlow(CallStatisticsRange.TODAY)
    private val statistics = statisticsRange.flatMapLatest(repository::statistics)
    private val dialChannel = Channel<DialAuthorization>(capacity = Channel.BUFFERED)
    val dialEvents = dialChannel.receiveAsFlow()
    private var unlockCountdownJob: Job? = null

    private data class OfflineData(
        val contacts: List<OfflineContact>,
        val history: List<OfflineCallRecord>,
        val pending: Boolean,
    )

    private val offlineData = combine(
        repository.contacts,
        repository.history,
        repository.hasPendingCall,
    ) { contacts, history, pending -> OfflineData(contacts, history, pending) }

    private data class OfflineSettings(
        val configured: Boolean,
        val unlocked: Boolean,
        val maximumAttempts: Int,
    )

    private val settings = combine(
        repository.configured,
        repository.unlocked,
        repository.maximumAttempts,
    ) { configured, unlocked, maximumAttempts ->
        OfflineSettings(configured, unlocked, maximumAttempts)
    }

    private data class ViewOptions(
        val filter: OfflineTaskFilter,
        val range: CallStatisticsRange,
        val statistics: CallStatistics,
    )

    private val options = combine(taskFilter, statisticsRange, statistics) { filter, range, stats ->
        ViewOptions(filter, range, stats)
    }

    val state: StateFlow<OfflineUiState> = combine(
        transient,
        offlineData,
        settings,
        options,
    ) { current, data, settings, options ->
        current.copy(
            configured = settings.configured,
            unlocked = settings.unlocked,
            contacts = data.contacts,
            filteredContacts = data.contacts.filterFor(options.filter),
            history = data.history,
            hasPendingCall = data.pending,
            maximumAttempts = settings.maximumAttempts,
            taskFilter = options.filter,
            statisticsRange = options.range,
            statistics = options.statistics,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), transient.value)

    init {
        viewModelScope.launch {
            simCallManager.state.collect { simDial ->
                transient.value = transient.value.copy(simDial = simDial)
            }
        }
        viewModelScope.launch {
            repository.hasPendingCall.distinctUntilChanged().collect { pending ->
                while (pending && coroutineContext.isActive) {
                    runCatching { repository.reconcilePending() }
                    delay(PENDING_RECONCILE_INTERVAL_MS)
                }
            }
        }
    }

    fun createPassword(password: String, confirmation: String) {
        launchBusy {
            require(password == confirmation) { "两次输入的离线密码不一致" }
            repository.createPassword(password)
        }
    }

    fun unlock(password: String) {
        launchBusy {
            val result = repository.unlock(password)
            if (!result.unlocked) {
                transient.value = transient.value.copy(
                    unlockRetryAfterSeconds = result.retryAfterSeconds,
                )
                if (result.retryAfterSeconds > 0) startUnlockCountdown(result.retryAfterSeconds)
                error(
                    if (result.retryAfterSeconds > 0) {
                        "密码错误，请 ${result.retryAfterSeconds} 秒后重试"
                    } else {
                        "离线密码错误"
                    },
                )
            }
            unlockCountdownJob?.cancel()
            transient.value = transient.value.copy(unlockRetryAfterSeconds = 0)
            refreshData()
        }
    }

    fun lock() {
        unlockCountdownJob?.cancel()
        closeImportSession()
        repository.lock()
        transient.value = transient.value.copy(
            revealedPhone = null,
            importState = OfflineImportUiState.Idle,
            unlockRetryAfterSeconds = 0,
        )
    }

    fun changePassword(currentPassword: String, newPassword: String, confirmation: String) {
        launchBusy {
            require(newPassword == confirmation) { "两次输入的新密码不一致" }
            check(repository.changePassword(currentPassword, newPassword)) { "当前密码不正确" }
            transient.value = transient.value.copy(message = "离线密码已修改")
        }
    }

    fun eraseData(password: String) {
        launchBusy {
            check(repository.eraseOfflineData(password)) { "密码不正确，未清除任何数据" }
        }
    }

    fun openSpreadsheet(uri: Uri) {
        launchBusy {
            closeImportSession()
            transient.value = transient.value.copy(importState = OfflineImportUiState.Loading)
            val session = try {
                importService.openDocument(uri)
            } catch (failure: Throwable) {
                transient.value = transient.value.copy(importState = OfflineImportUiState.Idle)
                throw failure
            }
            if (!repository.unlocked.value) {
                importService.close(session)
                transient.value = transient.value.copy(importState = OfflineImportUiState.Idle)
                return@launchBusy
            }
            val sheet = session.preview.sheets.firstOrNull { it.columns.isNotEmpty() }
                ?: run {
                    importService.close(session)
                    transient.value = transient.value.copy(importState = OfflineImportUiState.Idle)
                    error("所选文件没有可导入的列")
                }
            val suggestedPhone = sheet.columns.maxWithOrNull(
                compareBy<com.company.callcenter.offline.importing.SpreadsheetColumnPreview> { it.validPhoneCount }
                    .thenBy { it.validRate },
            ) ?: error("所选工作表没有可导入的列")
            val suggestedName = sheet.columns.firstOrNull { column ->
                column.index != suggestedPhone.index && column.header.orEmpty().containsNameKeyword()
            }?.index
            transient.value = transient.value.copy(
                importState = OfflineImportUiState.Spreadsheet(
                    session = session,
                    selectedSheetId = sheet.id,
                    phoneColumnIndex = suggestedPhone.index,
                    nameColumnIndex = suggestedName,
                ),
            )
        }
    }

    fun selectImportSheet(sheetId: String) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        val sheet = current.session.preview.sheets.firstOrNull { it.id == sheetId } ?: return
        val phoneColumn = sheet.columns.maxWithOrNull(
            compareBy<com.company.callcenter.offline.importing.SpreadsheetColumnPreview> { it.validPhoneCount }
                .thenBy { it.validRate },
        ) ?: return
        transient.value = transient.value.copy(
            importState = current.copy(
                selectedSheetId = sheetId,
                phoneColumnIndex = phoneColumn.index,
                nameColumnIndex = sheet.columns.firstOrNull { column ->
                    column.index != phoneColumn.index && column.header.orEmpty().containsNameKeyword()
                }?.index,
            ),
        )
    }

    fun selectPhoneColumn(columnIndex: Int) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        if (current.selectedSheet.columns.none { it.index == columnIndex }) return
        transient.value = transient.value.copy(
            importState = current.copy(
                phoneColumnIndex = columnIndex,
                nameColumnIndex = current.nameColumnIndex?.takeIf { it != columnIndex },
            ),
        )
    }

    fun selectNameColumn(columnIndex: Int?) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        if (columnIndex != null && (
                columnIndex == current.phoneColumnIndex || current.selectedSheet.columns.none { it.index == columnIndex }
            )
        ) return
        transient.value = transient.value.copy(importState = current.copy(nameColumnIndex = columnIndex))
    }

    fun setImportSkipsHeader(skip: Boolean) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        transient.value = transient.value.copy(importState = current.copy(skipHeader = skip))
    }

    fun confirmSpreadsheetImport() {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        launchBusy {
            try {
                val draft = importService.readSpreadsheet(
                    session = current.session,
                    sheetId = current.selectedSheetId,
                    phoneColumnIndex = current.phoneColumnIndex,
                    nameColumnIndex = current.nameColumnIndex,
                    skipHeader = current.skipHeader,
                )
                val result = repository.importContacts(draft.records, draft.invalidCount)
                transient.value = transient.value.copy(importState = OfflineImportUiState.Completed(result))
            } catch (failure: Throwable) {
                transient.value = transient.value.copy(importState = OfflineImportUiState.Idle)
                throw failure
            } finally {
                importService.close(current.session)
            }
        }
    }

    fun previewPaste(value: String) {
        launchBusy {
            closeImportSession()
            transient.value = transient.value.copy(
                importState = OfflineImportUiState.PastePreview(value, importService.parsePaste(value)),
            )
        }
    }

    fun confirmPasteImport() {
        val current = transient.value.importState as? OfflineImportUiState.PastePreview ?: return
        launchBusy {
            val imported = repository.importContacts(
                records = current.parsed.numbers.map { phone ->
                    com.company.callcenter.data.offline.OfflineImportContact(phone)
                },
                invalidCount = current.parsed.invalidCount + current.parsed.blankCount,
            )
            transient.value = transient.value.copy(
                importState = OfflineImportUiState.Completed(
                    imported.copy(duplicateCount = imported.duplicateCount + current.parsed.duplicateCount),
                ),
            )
        }
    }

    fun resetImport() {
        closeImportSession()
        transient.value = transient.value.copy(importState = OfflineImportUiState.Idle)
    }

    fun refresh() = launchBusy(clearError = false) { refreshData() }

    fun onReturnedToForeground() {
        viewModelScope.launch {
            simCallManager.refresh()
            runCatching { repository.reconcilePending() }
        }
    }

    private suspend fun refreshData() {
        simCallManager.refresh()
        repository.reconcilePending()
    }

    fun setTaskFilter(filter: OfflineTaskFilter) {
        taskFilter.value = filter
    }

    fun setStatisticsRange(range: CallStatisticsRange) {
        statisticsRange.value = range
    }

    fun setMaximumAttempts(value: Int) {
        launchBusy { repository.setMaximumAttempts(value) }
    }

    fun setSimDialMode(mode: SimDialMode) {
        simCallManager.setMode(mode)
    }

    fun refreshSimConfiguration() {
        simCallManager.refresh()
    }

    fun revealPhone(contactId: String) = launchBusy {
        transient.value = transient.value.copy(revealedPhone = repository.revealPhone(contactId))
    }

    fun revealHistoryPhone(attemptId: String) = launchBusy {
        transient.value = transient.value.copy(revealedPhone = repository.revealHistoryPhone(attemptId))
    }

    fun dismissPhone() {
        transient.value = transient.value.copy(revealedPhone = null)
    }

    fun call(contactId: String) = launchBusy {
        simCallManager.requireAvailableSim()
        dialChannel.send(repository.authorizeCall(contactId))
    }

    fun reportDialLaunchFailure(attemptId: String, failure: Throwable) {
        viewModelScope.launch {
            repository.cancelFailedCallAttempt(attemptId)
            transient.value = transient.value.copy(
                error = failure.message ?: "无法通过所选 SIM 卡发起外呼，本次尝试已撤销",
            )
        }
    }

    fun requestCleanup(days: Int) {
        launchBusy {
            transient.value = transient.value.copy(
                cleanupConfirmation = OfflineCleanupConfirmation(days, repository.countCompletedBefore(days)),
            )
        }
    }

    fun cancelCleanup() {
        transient.value = transient.value.copy(cleanupConfirmation = null)
    }

    fun confirmCleanup() {
        val confirmation = state.value.cleanupConfirmation ?: return
        launchBusy {
            val result: OfflineCleanupResult = repository.deleteCompletedBefore(confirmation.days)
            transient.value = transient.value.copy(
                cleanupConfirmation = null,
                message = "已清除 ${result.deletedContacts} 条已完成数据及关联记录",
            )
        }
    }

    fun clearError() {
        transient.value = transient.value.copy(error = null)
    }

    fun clearMessage() {
        transient.value = transient.value.copy(message = null)
    }

    private fun launchBusy(clearError: Boolean = true, block: suspend () -> Unit) {
        viewModelScope.launch {
            transient.value = transient.value.copy(
                loading = true,
                error = if (clearError) null else transient.value.error,
            )
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

    private fun closeImportSession() {
        val session = (transient.value.importState as? OfflineImportUiState.Spreadsheet)?.session
        importService.close(session)
    }

    private fun startUnlockCountdown(seconds: Long) {
        unlockCountdownJob?.cancel()
        unlockCountdownJob = viewModelScope.launch {
            var remaining = seconds
            while (remaining > 0) {
                transient.value = transient.value.copy(unlockRetryAfterSeconds = remaining)
                delay(1_000L)
                remaining -= 1
            }
            transient.value = transient.value.copy(unlockRetryAfterSeconds = 0, error = null)
        }
    }

    override fun onCleared() {
        unlockCountdownJob?.cancel()
        closeImportSession()
        repository.lock()
        super.onCleared()
    }

    private fun String.containsNameKeyword(): Boolean =
        listOf("姓名", "名称", "客户", "联系人", "name").any { keyword -> contains(keyword, ignoreCase = true) }

    private fun List<OfflineContact>.filterFor(filter: OfflineTaskFilter): List<OfflineContact> = when (filter) {
        OfflineTaskFilter.PENDING -> filter { contact ->
            contact.state == OfflineContactState.READY || contact.state == OfflineContactState.RETRY
        }
        OfflineTaskFilter.NOT_CONNECTED -> filter { contact ->
            contact.lastResult == com.company.callcenter.data.offline.OfflineCallResult.NOT_CONNECTED
        }
        OfflineTaskFilter.ALL -> this
    }

    private companion object {
        const val PENDING_RECONCILE_INTERVAL_MS = 5_000L
    }
}

class OfflineViewModelFactory(
    private val repository: OfflineRepository,
    private val simCallManager: SimCallManager,
    private val importService: OfflineImportService,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        OfflineViewModel(repository, simCallManager, importService) as T
}
