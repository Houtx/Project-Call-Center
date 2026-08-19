package com.company.callcenter.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.company.callcenter.data.CallStatistics
import com.company.callcenter.data.CallStatisticsRange
import com.company.callcenter.data.DialAuthorization
import com.company.callcenter.data.offline.OfflineCallRecord
import com.company.callcenter.data.offline.OfflineAllCallStatus
import com.company.callcenter.data.offline.OfflineAllTaskFilter
import com.company.callcenter.data.offline.OfflineCleanupResult
import com.company.callcenter.data.offline.OfflineContact
import com.company.callcenter.data.offline.OfflineDateRanges
import com.company.callcenter.data.offline.OfflineImportBatch
import com.company.callcenter.data.offline.OfflineImportMetadata
import com.company.callcenter.data.offline.OfflineImportResult
import com.company.callcenter.data.offline.OfflineImportService
import com.company.callcenter.data.offline.OfflineImportSource
import com.company.callcenter.data.offline.OfflineMissedDateFilter
import com.company.callcenter.data.offline.OfflineMissedDatePreset
import com.company.callcenter.data.offline.OfflineSpreadsheetSession
import com.company.callcenter.data.offline.OfflineSpreadsheetRowRange
import com.company.callcenter.data.offline.OfflineRepository
import com.company.callcenter.data.offline.OfflineTaskFilter
import com.company.callcenter.data.offline.OfflineTaskPage
import com.company.callcenter.offline.importing.PastePhoneParseResult
import com.company.callcenter.offline.importing.SpreadsheetCellPreview
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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext
import java.util.concurrent.atomic.AtomicBoolean

data class OfflineCleanupConfirmation(
    val days: Int,
    val contactCount: Int,
)

data class OfflineImportDeleteConfirmation(
    val batchId: String,
    val displayName: String,
    val contactCount: Int,
)

enum class OfflineImportRangeMode {
    ALL,
    CUSTOM,
}

sealed interface OfflineImportUiState {
    data object Idle : OfflineImportUiState
    data object Loading : OfflineImportUiState
    data class Spreadsheet(
        val session: OfflineSpreadsheetSession,
        val selectedSheetId: String,
        val phoneColumnIndex: Int,
        val skipHeader: Boolean = false,
        val rangeMode: OfflineImportRangeMode = OfflineImportRangeMode.ALL,
        val startRowText: String = "1",
        val endRowText: String,
        val previewRows: List<SpreadsheetCellPreview>,
        val previewLoading: Boolean = false,
        val rangeError: String? = null,
    ) : OfflineImportUiState {
        val selectedSheet: SpreadsheetSheetPreview
            get() = session.preview.sheets.first { it.id == selectedSheetId }

        fun selectedRange(): OfflineSpreadsheetRowRange? {
            return when (rangeMode) {
                OfflineImportRangeMode.ALL -> OfflineSpreadsheetRowRange()
                OfflineImportRangeMode.CUSTOM -> {
                    val start = startRowText.toIntOrNull() ?: return null
                    val end = endRowText.toIntOrNull() ?: return null
                    if (start < 1 || end < start || end > selectedSheet.lastRowNumber) null
                    else OfflineSpreadsheetRowRange(start, end)
                }
            }
        }
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
    val taskContacts: List<OfflineContact> = emptyList(),
    val taskTotalCount: Int = 0,
    val history: List<OfflineCallRecord> = emptyList(),
    val taskFilter: OfflineTaskFilter = OfflineTaskFilter.PENDING,
    val missedDateFilter: OfflineMissedDateFilter = OfflineMissedDateFilter(),
    val allTaskFilter: OfflineAllTaskFilter = OfflineAllTaskFilter(),
    val statistics: CallStatistics = CallStatistics(),
    val statisticsRange: CallStatisticsRange = CallStatisticsRange.TODAY,
    val maximumAttempts: Int = 2,
    val hasPendingCall: Boolean = false,
    val simDial: SimDialState = SimDialState(),
    val loading: Boolean = false,
    val loadingMessage: String = "正在处理，请稍候…",
    val loadingProgress: Float? = null,
    val error: String? = null,
    val message: String? = null,
    val revealedPhone: String? = null,
    val unlockRetryAfterSeconds: Long = 0,
    val cleanupConfirmation: OfflineCleanupConfirmation? = null,
    val importState: OfflineImportUiState = OfflineImportUiState.Idle,
    val importBatches: List<OfflineImportBatch> = emptyList(),
    val importDeleteConfirmation: OfflineImportDeleteConfirmation? = null,
)

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineViewModel(
    private val repository: OfflineRepository,
    private val simCallManager: SimCallManager,
    private val importService: OfflineImportService,
) : ViewModel() {
    private val transient = MutableStateFlow(OfflineUiState(simDial = simCallManager.state.value))
    private val taskFilter = MutableStateFlow(OfflineTaskFilter.PENDING)
    private val missedDateFilter = MutableStateFlow(OfflineMissedDateFilter())
    private val allTaskFilter = MutableStateFlow(OfflineAllTaskFilter())
    private val statisticsRange = MutableStateFlow(CallStatisticsRange.TODAY)
    private val statistics = statisticsRange.flatMapLatest(repository::statistics)
    private val dialChannel = Channel<DialAuthorization>(capacity = Channel.BUFFERED)
    val dialEvents = dialChannel.receiveAsFlow()
    private var unlockCountdownJob: Job? = null
    private var importPreviewJob: Job? = null
    private val operationInProgress = AtomicBoolean(false)

    private data class TaskSelection(
        val filter: OfflineTaskFilter,
        val dateFilter: OfflineMissedDateFilter,
        val allFilter: OfflineAllTaskFilter,
    )

    private data class TaskData(
        val selection: TaskSelection,
        val page: OfflineTaskPage,
    )

    private val taskSelection = combine(taskFilter, missedDateFilter, allTaskFilter, ::TaskSelection)
    private val taskData = taskSelection.flatMapLatest { selection ->
        repository.taskPage(selection.filter, selection.dateFilter, selection.allFilter)
            .map { page -> TaskData(selection, page) }
    }

    private data class OfflineData(
        val tasks: TaskData,
        val history: List<OfflineCallRecord>,
        val pending: Boolean,
        val importBatches: List<OfflineImportBatch>,
    )

    private val offlineData = combine(
        taskData,
        repository.history,
        repository.hasPendingCall,
        repository.importBatches,
    ) { tasks, history, pending, batches -> OfflineData(tasks, history, pending, batches) }

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
        val range: CallStatisticsRange,
        val statistics: CallStatistics,
    )

    private val options = combine(statisticsRange, statistics) { range, stats ->
        ViewOptions(range, stats)
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
            taskContacts = data.tasks.page.contacts,
            taskTotalCount = data.tasks.page.totalCount,
            history = data.history,
            hasPendingCall = data.pending,
            maximumAttempts = settings.maximumAttempts,
            taskFilter = data.tasks.selection.filter,
            missedDateFilter = data.tasks.selection.dateFilter,
            allTaskFilter = data.tasks.selection.allFilter,
            statisticsRange = options.range,
            statistics = options.statistics,
            importBatches = data.importBatches,
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
        launchBusy(message = "正在创建离线数据密码…") {
            require(password == confirmation) { "两次输入的离线密码不一致" }
            repository.createPassword(password)
        }
    }

    fun unlock(password: String) {
        launchBusy(message = "正在解锁离线数据…") {
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
        launchBusy(message = "正在修改离线密码…") {
            require(newPassword == confirmation) { "两次输入的新密码不一致" }
            check(repository.changePassword(currentPassword, newPassword)) { "当前密码不正确" }
            transient.value = transient.value.copy(message = "离线密码已修改")
        }
    }

    fun eraseData(password: String) {
        launchBusy(message = "正在安全清除离线数据…") {
            check(repository.eraseOfflineData(password)) { "密码不正确，未清除任何数据" }
        }
    }

    fun openSpreadsheet(uri: Uri) {
        launchBusy(message = "正在读取文件并生成预览…") {
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
            transient.value = transient.value.copy(
                importState = OfflineImportUiState.Spreadsheet(
                    session = session,
                    selectedSheetId = sheet.id,
                    phoneColumnIndex = suggestedPhone.index,
                    skipHeader = suggestedPhone.suggestsHeader,
                    endRowText = sheet.lastRowNumber.toString(),
                    previewRows = suggestedPhone.previewRows,
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
        updateSpreadsheetState(
            current.copy(
                selectedSheetId = sheetId,
                phoneColumnIndex = phoneColumn.index,
                skipHeader = phoneColumn.suggestsHeader,
                startRowText = "1",
                endRowText = sheet.lastRowNumber.toString(),
                previewRows = phoneColumn.previewRows,
                previewLoading = false,
                rangeError = null,
            ),
            refreshCustomPreview = current.rangeMode == OfflineImportRangeMode.CUSTOM,
        )
    }

    fun selectPhoneColumn(columnIndex: Int) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        if (current.selectedSheet.columns.none { it.index == columnIndex }) return
        val column = current.selectedSheet.columns.first { it.index == columnIndex }
        updateSpreadsheetState(
            current.copy(
                phoneColumnIndex = columnIndex,
                skipHeader = column.suggestsHeader,
                previewRows = column.previewRows,
                rangeError = null,
            ),
            refreshCustomPreview = true,
        )
    }

    fun setImportSkipsHeader(skip: Boolean) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        updateSpreadsheetState(current.copy(skipHeader = skip), refreshCustomPreview = true)
    }

    fun setImportRangeMode(mode: OfflineImportRangeMode) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        val selectedColumn = current.selectedSheet.columns.first { it.index == current.phoneColumnIndex }
        val updated = current.copy(
            rangeMode = mode,
            startRowText = if (mode == OfflineImportRangeMode.CUSTOM) current.startRowText else "1",
            endRowText = current.selectedSheet.lastRowNumber.toString(),
            previewRows = selectedColumn.previewRows,
            rangeError = null,
        )
        updateSpreadsheetState(updated, refreshCustomPreview = mode == OfflineImportRangeMode.CUSTOM)
    }

    fun setImportStartRow(value: String) {
        updateImportRangeText(start = value.filter(Char::isDigit).take(MAX_ROW_INPUT_CHARS), end = null)
    }

    fun setImportEndRow(value: String) {
        updateImportRangeText(start = null, end = value.filter(Char::isDigit).take(MAX_ROW_INPUT_CHARS))
    }

    fun confirmSpreadsheetImport() {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        launchBusy(message = "正在导入号码…", initialProgress = 0f) {
            try {
                val rowRange = current.selectedRange() ?: error(importRangeError(current))
                val draft = importService.readSpreadsheet(
                    session = current.session,
                    sheetId = current.selectedSheetId,
                    phoneColumnIndex = current.phoneColumnIndex,
                    skipHeader = current.skipHeader,
                    rowRange = rowRange,
                    estimatedLastRow = current.selectedSheet.lastRowNumber,
                    onProgress = { progress ->
                        updateLoading("正在读取并校验号码…", progress * IMPORT_READ_WEIGHT)
                    },
                )
                val column = current.selectedSheet.columns.first { it.index == current.phoneColumnIndex }
                val result = repository.importContacts(
                    records = draft.records,
                    invalidCount = draft.invalidCount,
                    metadata = OfflineImportMetadata(
                        displayName = current.session.displayName,
                        source = OfflineImportSource.SPREADSHEET,
                        sheetName = current.selectedSheet.name,
                        columnLetter = column.letter,
                        requestedStartRow = rowRange.startRow.takeIf { current.rangeMode == OfflineImportRangeMode.CUSTOM },
                        requestedEndRow = rowRange.endRowInclusive.takeIf {
                            current.rangeMode == OfflineImportRangeMode.CUSTOM
                        },
                        skipHeader = current.skipHeader,
                    ),
                    onProgress = { processed, total ->
                        val writeProgress = if (total == 0) 1f else processed.toFloat() / total
                        updateLoading(
                            "正在写入号码… $processed / $total",
                            IMPORT_READ_WEIGHT + writeProgress * (1f - IMPORT_READ_WEIGHT),
                        )
                    },
                )
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
        launchBusy(message = "正在检查粘贴内容…") {
            closeImportSession()
            transient.value = transient.value.copy(
                importState = OfflineImportUiState.PastePreview(value, importService.parsePaste(value)),
            )
        }
    }

    fun confirmPasteImport() {
        val current = transient.value.importState as? OfflineImportUiState.PastePreview ?: return
        launchBusy(message = "正在导入号码…", initialProgress = 0f) {
            val imported = repository.importContacts(
                records = current.parsed.numbers.map { phone ->
                    com.company.callcenter.data.offline.OfflineImportContact(phone)
                },
                invalidCount = current.parsed.invalidCount + current.parsed.blankCount,
                duplicateCount = current.parsed.duplicateCount,
                metadata = OfflineImportMetadata(
                    displayName = "手动粘贴",
                    source = OfflineImportSource.PASTE,
                ),
                onProgress = { processed, total ->
                    updateLoading(
                        "正在写入号码… $processed / $total",
                        if (total == 0) 1f else processed.toFloat() / total,
                    )
                },
            )
            transient.value = transient.value.copy(
                importState = OfflineImportUiState.Completed(imported),
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

    fun setMissedDatePreset(preset: OfflineMissedDatePreset) {
        when (preset) {
            OfflineMissedDatePreset.ALL -> missedDateFilter.value = OfflineMissedDateFilter()
            OfflineMissedDatePreset.THIS_WEEK ->
                missedDateFilter.value = OfflineDateRanges.thisWeek(System.currentTimeMillis())
            OfflineMissedDatePreset.CUSTOM -> Unit
        }
    }

    fun applyAllPhoneQuery(value: String) {
        val digits = value.filter(Char::isDigit)
        if (digits.isNotEmpty() && digits.length !in 1..4 && digits.length != 11) {
            transient.value = transient.value.copy(error = "号码搜索请输入完整 11 位号码，或前 3 位/后 4 位")
            return
        }
        allTaskFilter.value = allTaskFilter.value.copy(phoneQuery = digits)
    }

    fun setAllCallStatus(status: OfflineAllCallStatus) {
        allTaskFilter.value = allTaskFilter.value.copy(callStatus = status)
    }

    fun setAllImportBatch(batchId: String?) {
        allTaskFilter.value = allTaskFilter.value.copy(importBatchId = batchId)
    }

    fun setAllCreatedDatePreset(preset: OfflineMissedDatePreset) {
        val dateFilter = when (preset) {
            OfflineMissedDatePreset.ALL -> OfflineMissedDateFilter()
            OfflineMissedDatePreset.THIS_WEEK -> OfflineDateRanges.thisWeek(System.currentTimeMillis())
            OfflineMissedDatePreset.CUSTOM -> return
        }
        allTaskFilter.value = allTaskFilter.value.copy(createdDateFilter = dateFilter)
    }

    fun setCustomAllCreatedDateRange(startUtcMillis: Long, endUtcMillis: Long) {
        allTaskFilter.value = allTaskFilter.value.copy(
            createdDateFilter = OfflineDateRanges.custom(startUtcMillis, endUtcMillis),
        )
    }

    fun resetAllTaskFilters() {
        allTaskFilter.value = OfflineAllTaskFilter()
    }

    fun setCustomMissedDateRange(startUtcMillis: Long, endUtcMillis: Long) {
        missedDateFilter.value = OfflineDateRanges.custom(startUtcMillis, endUtcMillis)
    }

    fun setStatisticsRange(range: CallStatisticsRange) {
        statisticsRange.value = range
    }

    fun setMaximumAttempts(value: Int) {
        launchBusy(message = "正在更新外呼次数…") { repository.setMaximumAttempts(value) }
    }

    fun setSimDialMode(mode: SimDialMode) {
        simCallManager.setMode(mode)
    }

    fun refreshSimConfiguration() {
        simCallManager.refresh()
    }

    fun revealPhone(contactId: String) = launchBusy(message = "正在读取完整号码…") {
        transient.value = transient.value.copy(revealedPhone = repository.revealPhone(contactId))
    }

    fun revealHistoryPhone(attemptId: String) = launchBusy(message = "正在读取完整号码…") {
        transient.value = transient.value.copy(revealedPhone = repository.revealHistoryPhone(attemptId))
    }

    fun dismissPhone() {
        transient.value = transient.value.copy(revealedPhone = null)
    }

    fun call(contactId: String) = launchBusy(message = "正在准备拨号…") {
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
        launchBusy(message = "正在统计可清理数据…") {
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
        launchBusy(message = "正在清理历史数据…") {
            val result: OfflineCleanupResult = repository.deleteCompletedBefore(confirmation.days)
            transient.value = transient.value.copy(
                cleanupConfirmation = null,
                message = "已清除 ${result.deletedContacts} 条已完成数据及关联记录",
            )
        }
    }

    fun requestDeleteImport(batch: OfflineImportBatch) {
        launchBusy(message = "正在核对本次导入…") {
            transient.value = transient.value.copy(
                importDeleteConfirmation = OfflineImportDeleteConfirmation(
                    batchId = batch.id,
                    displayName = batch.displayName,
                    contactCount = repository.countContactsForImportBatch(batch.id),
                ),
            )
        }
    }

    fun cancelDeleteImport() {
        transient.value = transient.value.copy(importDeleteConfirmation = null)
    }

    fun confirmDeleteImport() {
        val confirmation = state.value.importDeleteConfirmation ?: return
        launchBusy(message = "正在删除本次导入及关联数据…") {
            val result = repository.deleteImportBatch(confirmation.batchId)
            if (allTaskFilter.value.importBatchId == confirmation.batchId) {
                allTaskFilter.value = allTaskFilter.value.copy(importBatchId = null)
            }
            transient.value = transient.value.copy(
                importDeleteConfirmation = null,
                message = "已删除这次导入的 ${result.deletedContacts} 条现存数据及关联通话记录",
            )
        }
    }

    fun clearError() {
        transient.value = transient.value.copy(error = null)
    }

    fun clearMessage() {
        transient.value = transient.value.copy(message = null)
    }

    private fun launchBusy(
        clearError: Boolean = true,
        message: String = "正在处理，请稍候…",
        initialProgress: Float? = null,
        block: suspend () -> Unit,
    ) {
        if (!operationInProgress.compareAndSet(false, true)) return
        viewModelScope.launch {
            transient.value = transient.value.copy(
                loading = true,
                loadingMessage = message,
                loadingProgress = initialProgress,
                error = if (clearError) null else transient.value.error,
            )
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                transient.value = transient.value.copy(error = failure.message ?: "操作失败，请稍后重试")
            } finally {
                operationInProgress.set(false)
                transient.value = transient.value.copy(loading = false, loadingProgress = null)
            }
        }
    }

    private fun updateLoading(message: String, progress: Float?) {
        if (!operationInProgress.get()) return
        transient.value = transient.value.copy(
            loadingMessage = message,
            loadingProgress = progress?.coerceIn(0f, 1f),
        )
    }

    private fun closeImportSession() {
        importPreviewJob?.cancel()
        importPreviewJob = null
        val session = (transient.value.importState as? OfflineImportUiState.Spreadsheet)?.session
        importService.close(session)
    }

    private fun updateImportRangeText(start: String?, end: String?) {
        val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return
        val updated = current.copy(
            startRowText = start ?: current.startRowText,
            endRowText = end ?: current.endRowText,
        )
        updateSpreadsheetState(updated, refreshCustomPreview = true)
    }

    private fun updateSpreadsheetState(
        state: OfflineImportUiState.Spreadsheet,
        refreshCustomPreview: Boolean,
    ) {
        val error: String? = if (state.selectedRange() == null) importRangeError(state) else null
        val updated = state.copy(rangeError = error, previewLoading = false)
        transient.value = transient.value.copy(importState = updated)
        importPreviewJob?.cancel()
        if (refreshCustomPreview && updated.rangeMode == OfflineImportRangeMode.CUSTOM && error == null) {
            importPreviewJob = viewModelScope.launch {
                delay(IMPORT_PREVIEW_DEBOUNCE_MS)
                val latest = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return@launch
                if (!latest.sameSelection(updated)) return@launch
                val range = latest.selectedRange() ?: return@launch
                transient.value = transient.value.copy(importState = latest.copy(previewLoading = true))
                try {
                    val rows = importService.previewSpreadsheetRange(
                        session = latest.session,
                        sheetId = latest.selectedSheetId,
                        phoneColumnIndex = latest.phoneColumnIndex,
                        skipHeader = latest.skipHeader,
                        rowRange = range,
                    )
                    val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return@launch
                    if (current.sameSelection(latest)) {
                        transient.value = transient.value.copy(
                            importState = current.copy(previewRows = rows, previewLoading = false, rangeError = null),
                        )
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    val current = transient.value.importState as? OfflineImportUiState.Spreadsheet ?: return@launch
                    if (current.sameSelection(latest)) {
                        transient.value = transient.value.copy(
                            importState = current.copy(
                                previewLoading = false,
                                rangeError = failure.message ?: "无法预览所选范围",
                            ),
                        )
                    }
                }
            }
        }
    }

    private fun importRangeError(state: OfflineImportUiState.Spreadsheet): String {
        val start = state.startRowText.toIntOrNull() ?: return "请输入起始行"
        val end = state.endRowText.toIntOrNull() ?: return "请输入结束行"
        return when {
            start < 1 -> "起始行必须大于 0"
            end < start -> "结束行不能早于起始行"
            end > state.selectedSheet.lastRowNumber -> "结束行不能超过第 ${state.selectedSheet.lastRowNumber} 行"
            else -> "导入范围无效"
        }
    }

    private fun OfflineImportUiState.Spreadsheet.sameSelection(other: OfflineImportUiState.Spreadsheet): Boolean =
        session === other.session && selectedSheetId == other.selectedSheetId &&
            phoneColumnIndex == other.phoneColumnIndex && skipHeader == other.skipHeader &&
            rangeMode == other.rangeMode && startRowText == other.startRowText && endRowText == other.endRowText

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
        importPreviewJob?.cancel()
        closeImportSession()
        repository.lock()
        super.onCleared()
    }

    private companion object {
        const val PENDING_RECONCILE_INTERVAL_MS = 5_000L
        const val IMPORT_READ_WEIGHT = 0.55f
        const val IMPORT_PREVIEW_DEBOUNCE_MS = 250L
        const val MAX_ROW_INPUT_CHARS = 7
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
