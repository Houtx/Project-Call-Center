package com.company.callcenter.ui

import com.company.callcenter.BuildConfig
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FileUpload
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.company.callcenter.data.offline.OfflineCallRecord
import com.company.callcenter.data.offline.OfflineCallResult
import com.company.callcenter.data.offline.OfflineAllCallStatus
import com.company.callcenter.data.offline.OfflineContact
import com.company.callcenter.data.offline.OfflineContactState
import com.company.callcenter.data.offline.OfflineMissedDatePreset
import com.company.callcenter.data.offline.OfflineTaskFilter
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun OfflineAgentApp(
    viewModel: OfflineViewModel,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    telemetryAvailable: Boolean,
    telemetryEnabled: Boolean,
    onTelemetryEnabledChange: (Boolean) -> Unit,
    onCheckForUpdate: () -> Unit,
    onUseOnline: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize()) {
        when {
            !state.configured -> OfflinePasswordSetupScreen(state.loading, state.error, viewModel::createPassword, onUseOnline)
            !state.unlocked -> OfflineUnlockScreen(
                loading = state.loading,
                error = state.error,
                retryAfterSeconds = state.unlockRetryAfterSeconds,
                onUnlock = viewModel::unlock,
                onUseOnline = onUseOnline,
            )
            else -> OfflineMainScreen(
                state = state,
                permissionsGranted = permissionsGranted,
                requestPermissions = requestPermissions,
                telemetryAvailable = telemetryAvailable,
                telemetryEnabled = telemetryEnabled,
                onTelemetryEnabledChange = onTelemetryEnabledChange,
                viewModel = viewModel,
                onCheckForUpdate = onCheckForUpdate,
                onUseOnline = onUseOnline,
            )
        }
        if (state.loading) BlockingLoadingOverlay(state.loadingMessage, state.loadingProgress)
    }
}

@Composable
private fun OfflinePasswordSetupScreen(
    loading: Boolean,
    error: String?,
    onCreate: (String, String) -> Unit,
    onUseOnline: () -> Unit,
) {
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    AccessScreenContainer(
        title = "设置离线数据密码",
        subtitle = "密码用于每次打开离线模式时解锁本机客户与通话数据。",
    ) {
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("离线密码") },
            supportingText = { Text("至少 6 位；忘记后只能清空 APP 数据") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = confirmation,
            onValueChange = { confirmation = it },
            label = { Text("再次输入密码") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = { onCreate(password, confirmation) },
            enabled = password.length >= 6 && confirmation.isNotEmpty() && !loading,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (loading) CircularProgressIndicator(strokeWidth = 2.dp) else Text("创建密码并进入")
        }
        TextButton(onClick = onUseOnline, enabled = !loading, modifier = Modifier.align(Alignment.End)) {
            Text("改用在线模式")
        }
    }
}

@Composable
private fun OfflineUnlockScreen(
    loading: Boolean,
    error: String?,
    retryAfterSeconds: Long,
    onUnlock: (String) -> Unit,
    onUseOnline: () -> Unit,
) {
    var password by remember { mutableStateOf("") }
    AccessScreenContainer(
        title = "解锁离线数据",
        subtitle = "离线客户、完整号码和通话记录仅保存在这台手机。",
    ) {
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("离线密码") },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = { onUnlock(password) },
            enabled = password.isNotEmpty() && retryAfterSeconds == 0L && !loading,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (loading) CircularProgressIndicator(strokeWidth = 2.dp) else Text("解锁")
        }
        TextButton(onClick = onUseOnline, enabled = !loading, modifier = Modifier.align(Alignment.End)) {
            Text("改用在线模式")
        }
    }
}

@Composable
private fun AccessScreenContainer(
    title: String,
    subtitle: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OfflineMainScreen(
    state: OfflineUiState,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    telemetryAvailable: Boolean,
    telemetryEnabled: Boolean,
    onTelemetryEnabledChange: (Boolean) -> Unit,
    viewModel: OfflineViewModel,
    onCheckForUpdate: () -> Unit,
    onUseOnline: () -> Unit,
) {
    var tab by remember { mutableIntStateOf(0) }
    val snackbars = remember { SnackbarHostState() }
    var showPasswordDialog by remember { mutableStateOf(false) }

    LaunchedEffect(state.error, state.message) {
        (state.error ?: state.message)?.let {
            snackbars.showSnackbar(it)
            viewModel.clearError()
            viewModel.clearMessage()
        }
    }
    state.revealedPhone?.let { phone ->
        AlertDialog(
            onDismissRequest = viewModel::dismissPhone,
            confirmButton = { Button(onClick = viewModel::dismissPhone) { Text("关闭") } },
            icon = { Icon(Icons.Outlined.Visibility, contentDescription = null) },
            title = { Text("完整号码") },
            text = { Text(phone, style = MaterialTheme.typography.headlineSmall) },
        )
    }
    state.cleanupConfirmation?.let { cleanup ->
        AlertDialog(
            onDismissRequest = viewModel::cancelCleanup,
            confirmButton = {
                Button(onClick = viewModel::confirmCleanup, enabled = cleanup.contactCount > 0) { Text("确认清理") }
            },
            dismissButton = { TextButton(onClick = viewModel::cancelCleanup) { Text("取消") } },
            icon = { Icon(Icons.Outlined.DeleteOutline, contentDescription = null) },
            title = { Text("清理 ${cleanup.days} 天前数据") },
            text = { Text("将删除 ${cleanup.contactCount} 条已完成联系人及其通话明细。此操作无法恢复。") },
        )
    }
    state.importDeleteConfirmation?.let { deletion ->
        AlertDialog(
            onDismissRequest = viewModel::cancelDeleteImport,
            confirmButton = {
                Button(onClick = viewModel::confirmDeleteImport) { Text("确认删除") }
            },
            dismissButton = { TextButton(onClick = viewModel::cancelDeleteImport) { Text("取消") } },
            icon = { Icon(Icons.Outlined.DeleteOutline, contentDescription = null) },
            title = { Text("删除导入记录") },
            text = {
                Text(
                    "将删除“${deletion.displayName}”本次导入的 ${deletion.contactCount} 条现存客户及关联通话记录。" +
                        "重复或无效数据不会影响其他导入。此操作无法恢复。",
                )
            },
        )
    }
    if (showPasswordDialog) {
        ChangePasswordDialog(
            onDismiss = { showPasswordDialog = false },
            onConfirm = { current, next, confirmation ->
                viewModel.changePassword(current, next, confirmation)
                showPasswordDialog = false
            },
        )
    }

    val titles = listOf("离线待呼", "导入数据", "通话记录", "外呼统计", "我的")
    Scaffold(
        snackbarHost = { SnackbarHost(snackbars) },
        topBar = {
            TopAppBar(
                title = { Text(titles[tab]) },
                actions = {
                    if (tab == 0) {
                        IconButton(onClick = viewModel::refresh, enabled = !state.loading) {
                            Icon(Icons.Outlined.Refresh, contentDescription = "刷新")
                        }
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                listOf(
                    Triple("任务", Icons.Outlined.Call, 0),
                    Triple("导入", Icons.Outlined.FileUpload, 1),
                    Triple("记录", Icons.Outlined.History, 2),
                    Triple("统计", Icons.Outlined.BarChart, 3),
                    Triple("我的", Icons.Outlined.AccountCircle, 4),
                ).forEach { (label, icon, index) ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = {
                            if (tab == 1 && index != 1) viewModel.resetImport()
                            tab = index
                        },
                        icon = { Icon(icon, contentDescription = null) },
                        label = { Text(label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                0 -> OfflineTaskList(state, permissionsGranted, requestPermissions, viewModel)
                1 -> OfflineImportScreen(
                    state = state.importState,
                    importBatches = state.importBatches,
                    onOpenSpreadsheet = viewModel::openSpreadsheet,
                    onSelectSheet = viewModel::selectImportSheet,
                    onSelectPhoneColumn = viewModel::selectPhoneColumn,
                    onSkipHeaderChange = viewModel::setImportSkipsHeader,
                    onRangeModeChange = viewModel::setImportRangeMode,
                    onStartRowChange = viewModel::setImportStartRow,
                    onEndRowChange = viewModel::setImportEndRow,
                    onConfirmSpreadsheet = viewModel::confirmSpreadsheetImport,
                    onPreviewPaste = viewModel::previewPaste,
                    onConfirmPaste = viewModel::confirmPasteImport,
                    onReset = viewModel::resetImport,
                    onDeleteImport = viewModel::requestDeleteImport,
                )
                2 -> OfflineHistoryList(state.history, viewModel::revealHistoryPhone)
                3 -> CallStatisticsScreen(state.statistics, state.statisticsRange, viewModel::setStatisticsRange)
                else -> OfflineAccountScreen(
                    state = state,
                    permissionsGranted = permissionsGranted,
                    requestPermissions = requestPermissions,
                    onSimModeChange = viewModel::setSimDialMode,
                    onMaximumAttemptsChange = viewModel::setMaximumAttempts,
                    onCleanup = viewModel::requestCleanup,
                    onChangePassword = { showPasswordDialog = true },
                    onLock = viewModel::lock,
                    telemetryAvailable = telemetryAvailable,
                    telemetryEnabled = telemetryEnabled,
                    onTelemetryEnabledChange = onTelemetryEnabledChange,
                    onCheckForUpdate = onCheckForUpdate,
                    onUseOnline = onUseOnline,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OfflineTaskList(
    state: OfflineUiState,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    viewModel: OfflineViewModel,
) {
    var customDateTarget by remember { mutableStateOf<OfflineTaskFilter?>(null) }
    var phoneQuery by remember(state.allTaskFilter.phoneQuery) { mutableStateOf(state.allTaskFilter.phoneQuery) }
    if (customDateTarget != null) {
        val pickerState = androidx.compose.material3.rememberDateRangePickerState()
        DatePickerDialog(
            onDismissRequest = { customDateTarget = null },
            confirmButton = {
                TextButton(
                    onClick = {
                        val start = pickerState.selectedStartDateMillis ?: return@TextButton
                        val end = pickerState.selectedEndDateMillis ?: start
                        if (customDateTarget == OfflineTaskFilter.ALL) {
                            viewModel.setCustomAllCreatedDateRange(start, end)
                        } else {
                            viewModel.setCustomMissedDateRange(start, end)
                        }
                        customDateTarget = null
                    },
                    enabled = pickerState.selectedStartDateMillis != null,
                ) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { customDateTarget = null }) { Text("取消") } },
        ) {
            DateRangePicker(state = pickerState, modifier = Modifier.fillMaxWidth().height(500.dp))
        }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            val label = when (state.taskFilter) {
                OfflineTaskFilter.PENDING -> "待呼"
                OfflineTaskFilter.NOT_CONNECTED -> "未接通"
                OfflineTaskFilter.ALL -> "全部"
            }
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text("$label 共 ${state.taskTotalCount} 条", style = MaterialTheme.typography.titleLarge)
                Text(
                    "当前滚动显示前 ${minOf(state.taskContacts.size, 100)} 条，完成一条后自动补充",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item {
            val filters = listOf(
                OfflineTaskFilter.PENDING to "待呼",
                OfflineTaskFilter.NOT_CONNECTED to "未接通",
                OfflineTaskFilter.ALL to "全部",
            )
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                filters.forEachIndexed { index, (filter, label) ->
                    SegmentedButton(
                        selected = state.taskFilter == filter,
                        onClick = { viewModel.setTaskFilter(filter) },
                        shape = SegmentedButtonDefaults.itemShape(index, filters.size),
                    ) { Text(label) }
                }
            }
        }
        if (state.taskFilter == OfflineTaskFilter.NOT_CONNECTED) {
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(
                        OfflineMissedDatePreset.ALL to "全部时间",
                        OfflineMissedDatePreset.THIS_WEEK to "本周",
                        OfflineMissedDatePreset.CUSTOM to "自定义",
                    ).forEach { (preset, label) ->
                        OutlinedButton(
                            onClick = {
                                if (preset == OfflineMissedDatePreset.CUSTOM) {
                                    customDateTarget = OfflineTaskFilter.NOT_CONNECTED
                                }
                                else viewModel.setMissedDatePreset(preset)
                            },
                            modifier = Modifier.weight(1f),
                        ) { Text(label) }
                    }
                }
                if (state.missedDateFilter.preset != OfflineMissedDatePreset.ALL) {
                    Text(
                        missedDateFilterLabel(state.missedDateFilter),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        if (state.taskFilter == OfflineTaskFilter.ALL) {
            item {
                AllTaskFilters(
                    state = state,
                    phoneQuery = phoneQuery,
                    onPhoneQueryChange = { phoneQuery = it.filter(Char::isDigit).take(11) },
                    onSearch = { viewModel.applyAllPhoneQuery(phoneQuery) },
                    onStatusChange = viewModel::setAllCallStatus,
                    onImportBatchChange = viewModel::setAllImportBatch,
                    onDatePresetChange = { preset ->
                        if (preset == OfflineMissedDatePreset.CUSTOM) {
                            customDateTarget = OfflineTaskFilter.ALL
                        } else {
                            viewModel.setAllCreatedDatePreset(preset)
                        }
                    },
                    onReset = {
                        phoneQuery = ""
                        viewModel.resetAllTaskFilters()
                    },
                )
            }
        }
        if (!permissionsGranted) item { OfflinePermissionBanner(requestPermissions) }
        else if (state.simDial.availableSims.isEmpty()) item { OfflineMissingSimBanner() }
        if (state.taskContacts.isEmpty()) {
            item { OfflineEmptyState("暂无符合条件的数据", "可在“导入”中添加手机号") }
        }
        items(state.taskContacts, key = OfflineContact::id) { contact ->
            OfflineContactCard(
                contact = contact,
                maximumAttempts = state.maximumAttempts,
                callEnabled = !state.loading && permissionsGranted && state.simDial.availableSims.isNotEmpty() &&
                    !state.hasPendingCall && contact.state != OfflineContactState.CONNECTED &&
                    contact.state != OfflineContactState.COLLECTING && contact.attemptCount < state.maximumAttempts,
                onReveal = { viewModel.revealPhone(contact.id) },
                onCall = { viewModel.call(contact.id) },
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}

@Composable
private fun AllTaskFilters(
    state: OfflineUiState,
    phoneQuery: String,
    onPhoneQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onStatusChange: (OfflineAllCallStatus) -> Unit,
    onImportBatchChange: (String?) -> Unit,
    onDatePresetChange: (OfflineMissedDatePreset) -> Unit,
    onReset: () -> Unit,
) {
    var statusMenuOpen by remember { mutableStateOf(false) }
    var batchMenuOpen by remember { mutableStateOf(false) }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("筛选全部任务", fontWeight = FontWeight.Medium)
            OutlinedTextField(
                value = phoneQuery,
                onValueChange = onPhoneQueryChange,
                label = { Text("号码搜索") },
                supportingText = { Text("完整 11 位号码，或输入前 3 位/后 4 位") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onSearch() }),
                singleLine = true,
                trailingIcon = {
                    IconButton(onClick = onSearch) { Icon(Icons.Outlined.Search, contentDescription = "查询号码") }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Box {
                OutlinedButton(onClick = { statusMenuOpen = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("呼叫状态：${allCallStatusLabel(state.allTaskFilter.callStatus)}")
                }
                DropdownMenu(expanded = statusMenuOpen, onDismissRequest = { statusMenuOpen = false }) {
                    OfflineAllCallStatus.entries.forEach { status ->
                        DropdownMenuItem(
                            text = { Text(allCallStatusLabel(status)) },
                            onClick = {
                                statusMenuOpen = false
                                onStatusChange(status)
                            },
                        )
                    }
                }
            }
            Box {
                val selectedBatch = state.importBatches.firstOrNull { it.id == state.allTaskFilter.importBatchId }
                OutlinedButton(onClick = { batchMenuOpen = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("导入记录：${selectedBatch?.displayName ?: "全部记录"}", maxLines = 1)
                }
                DropdownMenu(expanded = batchMenuOpen, onDismissRequest = { batchMenuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("全部导入记录") },
                        onClick = {
                            batchMenuOpen = false
                            onImportBatchChange(null)
                        },
                    )
                    state.importBatches.forEach { batch ->
                        DropdownMenuItem(
                            text = { Text("${offlineFormatTime(batch.createdAt)} · ${batch.displayName}") },
                            onClick = {
                                batchMenuOpen = false
                                onImportBatchChange(batch.id)
                            },
                        )
                    }
                }
            }
            Text("创建日期", style = MaterialTheme.typography.bodySmall)
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(
                    OfflineMissedDatePreset.ALL to "全部时间",
                    OfflineMissedDatePreset.THIS_WEEK to "本周导入",
                    OfflineMissedDatePreset.CUSTOM to "自定义",
                ).forEach { (preset, label) ->
                    OutlinedButton(onClick = { onDatePresetChange(preset) }) { Text(label) }
                }
            }
            if (state.allTaskFilter.createdDateFilter.preset != OfflineMissedDatePreset.ALL) {
                Text(
                    createdDateFilterLabel(state.allTaskFilter.createdDateFilter),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onReset, modifier = Modifier.weight(1f)) { Text("重置") }
                Button(onClick = onSearch, modifier = Modifier.weight(1f)) { Text("查询") }
            }
        }
    }
}

@Composable
private fun OfflineContactCard(
    contact: OfflineContact,
    maximumAttempts: Int,
    callEnabled: Boolean,
    onReveal: () -> Unit,
    onCall: () -> Unit,
) {
    Card(shape = RoundedCornerShape(8.dp), elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(contact.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(contact.phoneMasked, style = MaterialTheme.typography.titleLarge)
                }
                Text("${contact.attemptCount}/$maximumAttempts 次", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(offlineStateLabel(contact), style = MaterialTheme.typography.bodySmall)
            Text(
                "导入于 ${offlineFormatTime(contact.importedAt)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onReveal, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Outlined.Visibility, contentDescription = null)
                    Text("查看", modifier = Modifier.padding(start = 6.dp))
                }
                Button(onClick = onCall, enabled = callEnabled, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Outlined.Call, contentDescription = null)
                    Text("拨号", modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun OfflineHistoryList(
    history: List<OfflineCallRecord>,
    onReveal: (String) -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        if (history.isEmpty()) item { OfflineEmptyState("暂无通话记录", "完成外呼后记录会在本机生成") }
        items(history, key = OfflineCallRecord::attemptId) { call ->
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (call.result == OfflineCallResult.CONNECTED) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline,
                    contentDescription = null,
                    tint = if (call.result == OfflineCallResult.CONNECTED) {
                        MaterialTheme.colorScheme.secondary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(call.customerName, fontWeight = FontWeight.Medium)
                    Text("${call.phoneMasked} · ${offlineFormatTime(call.startedAt)}", style = MaterialTheme.typography.bodySmall)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(offlineResultLabel(call))
                    IconButton(onClick = { onReveal(call.attemptId) }) {
                        Icon(Icons.Outlined.Visibility, contentDescription = "查看完整号码")
                    }
                }
            }
        }
    }
}

@Composable
private fun OfflineAccountScreen(
    state: OfflineUiState,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    onSimModeChange: (com.company.callcenter.telephony.SimDialMode) -> Unit,
    onMaximumAttemptsChange: (Int) -> Unit,
    onCleanup: (Int) -> Unit,
    onChangePassword: () -> Unit,
    onLock: () -> Unit,
    telemetryAvailable: Boolean,
    telemetryEnabled: Boolean,
    onTelemetryEnabledChange: (Boolean) -> Unit,
    onCheckForUpdate: () -> Unit,
    onUseOnline: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        SettingsSection("本机离线账户") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.PhoneAndroid, contentDescription = null)
                Text("离线模式", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 10.dp))
            }
            Text("客户和通话数据仅保存在本机，不会同步到 CRM 服务器。", color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = onChangePassword, modifier = Modifier.fillMaxWidth()) { Text("修改离线密码") }
            OutlinedButton(onClick = onLock, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Lock, contentDescription = null)
                Text("立即锁定", modifier = Modifier.padding(start = 8.dp))
            }
        }
        SettingsSection("外呼权限与设备") {
            if (permissionsGranted) Text("拨号与通话记录权限正常")
            else OutlinedButton(onClick = requestPermissions) { Text("重新授权外呼权限") }
        }
        SettingsSection("SIM 拨号") { SimDialSettings(state.simDial, onSimModeChange) }
        SettingsSection("外呼限制") {
            Text("单个号码最大外呼次数", fontWeight = FontWeight.Medium)
            Text("用于防止误操作造成反复呼叫。未接通任务仍可按日期筛选。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { onMaximumAttemptsChange(state.maximumAttempts - 1) }, enabled = !state.loading && state.maximumAttempts > 1) {
                    Icon(Icons.Outlined.Remove, contentDescription = "减少")
                }
                Text("${state.maximumAttempts} 次", style = MaterialTheme.typography.titleMedium)
                IconButton(onClick = { onMaximumAttemptsChange(state.maximumAttempts + 1) }, enabled = !state.loading && state.maximumAttempts < 10) {
                    Icon(Icons.Outlined.Add, contentDescription = "增加")
                }
            }
        }
        SettingsSection("本机数据") {
            Text("清理已完成数据", fontWeight = FontWeight.Medium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(10, 15, 30).forEach { days ->
                    OutlinedButton(onClick = { onCleanup(days) }, modifier = Modifier.weight(1f)) { Text("$days 天前") }
                }
            }
            Text("清理会同时删除联系人和关联通话明细；采集中的号码不会被删除。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (telemetryAvailable) SettingsSection("使用统计") { UsageTelemetrySetting(telemetryEnabled, onTelemetryEnabledChange) }
        SettingsSection("关于与更新") {
            Text("APP 版本 ${BuildConfig.VERSION_NAME}")
            Text("构建号 ${BuildConfig.VERSION_CODE}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = onCheckForUpdate, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Refresh, null)
                Text("检查版本更新", modifier = Modifier.padding(start = 6.dp))
            }
        }
        SettingsSection("模式切换") {
            OutlinedButton(onClick = onUseOnline, enabled = !state.loading && !state.hasPendingCall, modifier = Modifier.fillMaxWidth()) {
                Text("切换到在线模式")
            }
        }
    }
}

@Composable
private fun ChangePasswordDialog(
    onDismiss: () -> Unit,
    onConfirm: (String, String, String) -> Unit,
) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(
                onClick = { onConfirm(current, next, confirmation) },
                enabled = current.isNotBlank() && next.length >= 6 && confirmation.isNotBlank(),
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
        title = { Text("修改离线密码") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = current,
                    onValueChange = { current = it },
                    label = { Text("当前密码") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = next,
                    onValueChange = { next = it },
                    label = { Text("新密码") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = confirmation,
                    onValueChange = { confirmation = it },
                    label = { Text("再次输入新密码") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                )
            }
        },
    )
}

@Composable
private fun OfflinePermissionBanner(onGrant: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null)
            Text("外呼与通话记录权限未就绪", modifier = Modifier.weight(1f).padding(horizontal = 10.dp))
            OutlinedButton(onClick = onGrant) { Text("授权") }
        }
    }
}

@Composable
private fun OfflineMissingSimBanner() {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Text("未检测到可拨号的 SIM 卡", modifier = Modifier.fillMaxWidth().padding(14.dp))
    }
}

@Composable
private fun OfflineEmptyState(title: String, detail: String) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun offlineStateLabel(contact: OfflineContact): String = when (contact.state) {
    OfflineContactState.READY -> "未外呼"
    OfflineContactState.COLLECTING -> "正在采集通话结果"
    OfflineContactState.RETRY -> "上次未接通，可再次尝试"
    OfflineContactState.CONNECTED -> "已接通"
    OfflineContactState.EXHAUSTED -> "未接通，已达到次数上限"
}

private fun offlineResultLabel(call: OfflineCallRecord): String = when (call.result) {
    OfflineCallResult.CONNECTED -> "${call.durationSeconds ?: 0} 秒"
    OfflineCallResult.NOT_CONNECTED -> "未接通"
    OfflineCallResult.UNKNOWN -> "未知"
}

private val offlineTimeFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")
    .withZone(ZoneId.of("Asia/Shanghai"))

private fun offlineFormatTime(value: Long): String = offlineTimeFormatter.format(Instant.ofEpochMilli(value))

private fun missedDateFilterLabel(filter: com.company.callcenter.data.offline.OfflineMissedDateFilter): String {
    val start = filter.startMillis?.let(::offlineFormatDate).orEmpty()
    val end = filter.endExclusiveMillis?.minus(1)?.let(::offlineFormatDate).orEmpty()
    return when (filter.preset) {
        OfflineMissedDatePreset.THIS_WEEK -> "本周未接通：$start 至 $end"
        OfflineMissedDatePreset.CUSTOM -> "筛选范围：$start 至 $end"
        OfflineMissedDatePreset.ALL -> ""
    }
}

private fun createdDateFilterLabel(filter: com.company.callcenter.data.offline.OfflineMissedDateFilter): String {
    val start = filter.startMillis?.let(::offlineFormatDate).orEmpty()
    val end = filter.endExclusiveMillis?.minus(1)?.let(::offlineFormatDate).orEmpty()
    return when (filter.preset) {
        OfflineMissedDatePreset.THIS_WEEK -> "本周导入：$start 至 $end"
        OfflineMissedDatePreset.CUSTOM -> "创建日期：$start 至 $end"
        OfflineMissedDatePreset.ALL -> ""
    }
}

private fun allCallStatusLabel(status: OfflineAllCallStatus): String = when (status) {
    OfflineAllCallStatus.ALL -> "全部状态"
    OfflineAllCallStatus.NOT_CALLED -> "从未外呼"
    OfflineAllCallStatus.PENDING -> "当前待呼"
    OfflineAllCallStatus.CONNECTED -> "已接通"
    OfflineAllCallStatus.NOT_CONNECTED -> "未接通"
    OfflineAllCallStatus.UNKNOWN -> "结果未知"
    OfflineAllCallStatus.COLLECTING -> "采集中"
}

private val offlineDateFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.of("Asia/Shanghai"))
private fun offlineFormatDate(value: Long): String = offlineDateFormatter.format(Instant.ofEpochMilli(value))
