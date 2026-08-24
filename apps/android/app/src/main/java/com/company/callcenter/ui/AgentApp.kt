package com.company.callcenter.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.PeopleAlt
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.SimCard
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.company.callcenter.BuildConfig
import com.company.callcenter.data.ServerConnectionStatus
import com.company.callcenter.data.local.AssignedCustomerEntity
import com.company.callcenter.data.local.CallHistoryEntity
import com.company.callcenter.telephony.SimDialMode
import com.company.callcenter.telephony.SimDialState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun AgentApp(
    viewModel: AgentViewModel,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    telemetryAvailable: Boolean,
    telemetryEnabled: Boolean,
    onTelemetryEnabledChange: (Boolean) -> Unit,
    onCheckForUpdate: () -> Unit,
    onUseOffline: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize()) {
        if (!state.loggedIn) {
            LoginScreen(state, viewModel::signIn, onUseOffline)
        } else {
            MainScreen(
                state = state,
                permissionsGranted = permissionsGranted,
                requestPermissions = requestPermissions,
                telemetryAvailable = telemetryAvailable,
                telemetryEnabled = telemetryEnabled,
                onTelemetryEnabledChange = onTelemetryEnabledChange,
                viewModel = viewModel,
                onCheckForUpdate = onCheckForUpdate,
                onUseOffline = onUseOffline,
            )
        }
        if (state.loading) BlockingLoadingOverlay()
    }
}

@Composable
private fun LoginScreen(
    state: AgentUiState,
    onLogin: (String, String, String) -> Unit,
    onUseOffline: () -> Unit,
) {
    var serverAddress by remember(state.serverConnection.suggestedUrl) {
        mutableStateOf(state.serverConnection.suggestedUrl.orEmpty())
    }
    var username by remember { mutableStateOf(BuildConfig.DEBUG_AGENT_USERNAME) }
    var password by remember { mutableStateOf(BuildConfig.DEBUG_AGENT_PASSWORD) }
    val serverError = state.serverConnection.error
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Icon(Icons.Outlined.PeopleAlt, null, tint = MaterialTheme.colorScheme.primary)
            Text("坐席外呼", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text("连接服务器后登录坐席账号", color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
                value = serverAddress,
                onValueChange = { serverAddress = it },
                label = { Text("服务器地址") },
                placeholder = { Text("https://crm.example.com") },
                supportingText = {
                    if (serverError != null) Text(serverError, color = MaterialTheme.colorScheme.error)
                    else Text("支持填写域名或完整地址")
                },
                isError = serverError != null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true,
                enabled = !state.loading,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("坐席账号") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("密码") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            SelectionContainer {
                Text(
                    "登录设备\n品牌：${Build.MANUFACTURER}\n型号：${Build.MODEL}\n" +
                        "Android API：${Build.VERSION.SDK_INT}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.error?.takeUnless { it == serverError }?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Button(
                onClick = { onLogin(serverAddress, username, password) },
                enabled = serverAddress.isNotBlank() && username.isNotBlank() &&
                    password.isNotBlank() && !state.loading,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(8.dp),
            ) {
                if (state.loading) {
                    CircularProgressIndicator(strokeWidth = 2.dp)
                } else {
                    Text(
                        if (state.serverConnection.status == ServerConnectionStatus.INVALID) {
                            "重新连接并登录"
                        } else {
                            "连接并登录"
                        },
                    )
                }
            }
            OutlinedButton(
                onClick = onUseOffline,
                enabled = !state.loading,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(8.dp),
            ) {
                Text("不连接服务器，使用离线模式")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScreen(
    state: AgentUiState,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    telemetryAvailable: Boolean,
    telemetryEnabled: Boolean,
    onTelemetryEnabledChange: (Boolean) -> Unit,
    viewModel: AgentViewModel,
    onCheckForUpdate: () -> Unit,
    onUseOffline: () -> Unit,
) {
    var tab by remember { mutableIntStateOf(0) }
    val snackbars = remember { SnackbarHostState() }
    LaunchedEffect(tab) {
        viewModel.setAutoDialTaskScreenVisible(tab == 0)
    }
    DisposableEffect(viewModel) {
        onDispose { viewModel.setAutoDialTaskScreenVisible(false) }
    }
    LaunchedEffect(state.error) {
        state.error?.let {
            snackbars.showSnackbar(it)
            viewModel.clearError()
        }
    }
    state.revealedPhone?.let { phone ->
        AlertDialog(
            onDismissRequest = viewModel::dismissPhone,
            confirmButton = { Button(onClick = viewModel::dismissPhone) { Text("关闭") } },
            icon = { Icon(Icons.Outlined.Visibility, null) },
            title = { Text("完整号码") },
            text = { Text(phone, style = MaterialTheme.typography.headlineSmall) },
        )
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbars) },
        topBar = {
            TopAppBar(
                title = { Text(listOf("待呼任务", "通话记录", "外呼统计", "我的")[tab]) },
                actions = {
                    if (tab == 0) {
                        IconButton(
                            onClick = viewModel::refresh,
                            enabled = !state.loading && !state.autoDial.enabled,
                        ) {
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
                    Triple("记录", Icons.Outlined.History, 1),
                    Triple("统计", Icons.Outlined.BarChart, 2),
                    Triple("我的", Icons.Outlined.AccountCircle, 3),
                ).forEach { (label, icon, index) ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        icon = { Icon(icon, null) },
                        label = { Text(label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                0 -> TaskList(state, permissionsGranted, requestPermissions, viewModel)
                1 -> HistoryList(state.history, viewModel::revealHistoryPhone)
                2 -> CallStatisticsScreen(state.statistics, state.statisticsRange, viewModel::setStatisticsRange)
                else -> AccountScreen(
                    state,
                    permissionsGranted,
                    requestPermissions,
                    viewModel::logout,
                    viewModel::changeServer,
                    viewModel::setSimDialMode,
                    viewModel::setAutoDialDelaySeconds,
                    telemetryAvailable,
                    telemetryEnabled,
                    onTelemetryEnabledChange,
                    onCheckForUpdate,
                    onUseOffline,
                )
            }
        }
    }
}

@Composable
private fun TaskList(
    state: AgentUiState,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    viewModel: AgentViewModel,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            AutoDialBanner(
                state = state.autoDial,
                canEnable = permissionsGranted && state.simDial.canDial && !state.loading,
                onEnabledChange = viewModel::setAutoDialEnabled,
            )
        }
        if (!permissionsGranted) {
            item {
                PermissionBanner(requestPermissions)
            }
        } else if (!state.simDial.canDial) {
            item { MissingSimBanner() }
        } else if (state.simDial.systemManagedRouting) {
            item { SystemManagedSimBanner() }
        }
        if (state.assignments.isEmpty()) {
            item {
                EmptyState("暂无待呼任务", "回到前台或点击右上角刷新")
            }
        }
        items(state.assignments, key = { it.assignmentId }) { assignment ->
            TaskCard(
                assignment = assignment,
                maxCallAttempts = state.maxCallAttempts,
                interactionEnabled = !state.autoDial.enabled,
                callEnabled = !state.autoDial.enabled && permissionsGranted && state.simDial.canDial &&
                    !state.hasPendingCall,
                onReveal = { viewModel.revealPhone(assignment.assignmentId) },
                onCall = { viewModel.call(assignment.assignmentId) },
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}

@Composable
private fun MissingSimBanner() {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        shape = RoundedCornerShape(8.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.SimCard, null, tint = MaterialTheme.colorScheme.error)
            Column(Modifier.padding(start = 12.dp)) {
                Text("未检测到可用 SIM", fontWeight = FontWeight.SemiBold)
                Text("请插入并启用可拨号的 SIM 卡", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun SystemManagedSimBanner() {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        shape = RoundedCornerShape(8.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.SimCard, null)
            Column(Modifier.padding(start = 12.dp)) {
                Text("SIM 由系统管理", fontWeight = FontWeight.SemiBold)
                Text("拨号时由系统电话服务选择可用 SIM", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun PermissionBanner(onGrant: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        shape = RoundedCornerShape(8.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text("外呼权限未就绪", fontWeight = FontWeight.SemiBold)
                Text("授权前系统不会下发拨号号码", style = MaterialTheme.typography.bodySmall)
            }
            OutlinedButton(onClick = onGrant) { Text("授权") }
        }
    }
}

@Composable
private fun TaskCard(
    assignment: AssignedCustomerEntity,
    maxCallAttempts: Int,
    interactionEnabled: Boolean,
    callEnabled: Boolean,
    onReveal: () -> Unit,
    onCall: () -> Unit,
) {
    Card(shape = RoundedCornerShape(8.dp), elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(assignment.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(assignment.phoneMasked, style = MaterialTheme.typography.titleLarge)
                }
                Text(
                    "${assignment.attemptCount}/$maxCallAttempts 次",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val location = listOfNotNull(assignment.province, assignment.city, assignment.carrier).joinToString(" · ")
            if (location.isNotBlank()) Text(location, color = MaterialTheme.colorScheme.onSurfaceVariant)
            assignment.batchName?.let { Text("批次：$it", style = MaterialTheme.typography.bodySmall) }
            HorizontalDivider()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = onReveal,
                    enabled = interactionEnabled,
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Icon(Icons.Outlined.Visibility, null)
                    Text("查看号码", modifier = Modifier.padding(start = 6.dp))
                }
                Button(onClick = onCall, enabled = callEnabled, modifier = Modifier.weight(1f), shape = RoundedCornerShape(8.dp)) {
                    Icon(Icons.Outlined.Call, null)
                    Text("拨号", modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun HistoryList(
    history: List<CallHistoryEntity>,
    onRevealPhone: (String) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (history.isEmpty()) item { EmptyState("暂无通话记录", "完成外呼后记录会自动同步") }
        items(history, key = { it.attemptId }) { call ->
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (call.status == "CONNECTED") Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline,
                    null,
                    tint = if (call.status == "CONNECTED") MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(call.customerName, fontWeight = FontWeight.Medium)
                    Text("${call.phoneMasked} · ${formatTime(call.startedAt)}", style = MaterialTheme.typography.bodySmall)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(if (call.durationSeconds != null) "${call.durationSeconds} 秒" else "待核验")
                    IconButton(onClick = { onRevealPhone(call.attemptId) }) {
                        Icon(Icons.Outlined.Visibility, contentDescription = "查看完整号码")
                    }
                }
            }
            HorizontalDivider()
        }
    }
}

@Composable
private fun AccountScreen(
    state: AgentUiState,
    permissionsGranted: Boolean,
    requestPermissions: () -> Unit,
    onLogout: () -> Unit,
    onChangeServer: () -> Unit,
    onSimModeChange: (SimDialMode) -> Unit,
    onAutoDialDelayChange: (Int) -> Unit,
    telemetryAvailable: Boolean,
    telemetryEnabled: Boolean,
    onTelemetryEnabledChange: (Boolean) -> Unit,
    onCheckForUpdate: () -> Unit,
    onUseOffline: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        SettingsSection("账号") {
            Text(state.displayName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text("待呼客户 ${state.assignments.size} 个 · 本机记录 ${state.history.size} 条", style = MaterialTheme.typography.bodySmall)
        }
        SettingsSection("外呼权限与设备") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(if (permissionsGranted) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline, null)
                Text(if (permissionsGranted) "拨号与通话记录权限正常" else "外呼权限未就绪", modifier = Modifier.padding(start = 10.dp))
            }
            if (!permissionsGranted) FilledTonalButton(onClick = requestPermissions) {
                Icon(Icons.Outlined.LockOpen, null)
                Text("重新授权", modifier = Modifier.padding(start = 6.dp))
            }
        }
        SettingsSection("SIM 拨号") { SimDialSettings(state.simDial, onSimModeChange) }
        SettingsSection("自动拨号") {
            AutoDialDelaySetting(
                delaySeconds = state.autoDial.delaySeconds,
                enabled = !state.loading,
                onDelayChange = onAutoDialDelayChange,
            )
        }
        if (telemetryAvailable) {
            SettingsSection("使用统计") { UsageTelemetrySetting(telemetryEnabled, onTelemetryEnabledChange) }
        }
        SettingsSection("服务器与登录") {
            Text(
                "服务器：${state.serverConnection.configuredUrl ?: state.serverConnection.suggestedUrl ?: "未配置"}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(onClick = onChangeServer, modifier = Modifier.fillMaxWidth()) { Text("切换服务器") }
            OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) { Text("退出登录") }
            OutlinedButton(
                onClick = onUseOffline,
                enabled = !state.hasPendingCall && !state.loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("切换到离线模式") }
        }
        SettingsSection("关于与更新") {
            Text("APP 版本 ${BuildConfig.VERSION_NAME}")
            Text("构建号 ${BuildConfig.VERSION_CODE}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = onCheckForUpdate, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Refresh, null)
                Text("检查版本更新", modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimDialSettings(
    state: SimDialState,
    onModeChange: (SimDialMode) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.SimCard, null)
            Text("拨号 SIM 卡", modifier = Modifier.padding(start = 10.dp), fontWeight = FontWeight.Medium)
        }
        state.availableSims.forEach { sim ->
            Text(
                "${sim.slotLabel} · ${sim.displayName}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        when {
            state.systemManagedRouting -> {
                Text("兼容模式 · SIM 选择由系统电话服务管理")
                Text(
                    "固定卡和循环设置不可用；可在系统电话设置中指定默认拨号卡。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.availableSims.isEmpty() -> {
                Text("未检测到可用于拨号的 SIM 卡", color = MaterialTheme.colorScheme.error)
            }
            state.availableSims.size == 1 -> {
                Text(
                    "单卡模式 · 自动使用${state.availableSims.single().slotLabel}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            else -> {
                val options = listOf(
                    SimDialMode.SIM_1 to "卡1",
                    SimDialMode.SIM_2 to "卡2",
                    SimDialMode.ALTERNATE to "循环",
                )
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    options.forEachIndexed { index, (mode, label) ->
                        SegmentedButton(
                            selected = state.mode == mode,
                            onClick = { onModeChange(mode) },
                            shape = SegmentedButtonDefaults.itemShape(index, options.size),
                        ) {
                            Text(label)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyState(title: String, detail: String) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 64.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun formatTime(epochMillis: Long): String = DateTimeFormatter.ofPattern("MM-dd HH:mm")
    .withZone(ZoneId.of("Asia/Shanghai"))
    .format(Instant.ofEpochMilli(epochMillis))
