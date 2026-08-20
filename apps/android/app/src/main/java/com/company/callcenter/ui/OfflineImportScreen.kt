package com.company.callcenter.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FileOpen
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.company.callcenter.data.offline.OfflineImportBatch
import com.company.callcenter.data.offline.OfflineImportSource
import com.company.callcenter.offline.importing.SpreadsheetColumnPreview
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OfflineImportScreen(
    state: OfflineImportUiState,
    importBatches: List<OfflineImportBatch>,
    onOpenSpreadsheet: (android.net.Uri) -> Unit,
    onSelectSheet: (String) -> Unit,
    onSelectPhoneColumn: (Int) -> Unit,
    onSkipHeaderChange: (Boolean) -> Unit,
    onRangeModeChange: (OfflineImportRangeMode) -> Unit,
    onStartRowChange: (String) -> Unit,
    onEndRowChange: (String) -> Unit,
    onConfirmSpreadsheet: () -> Unit,
    onPreviewPaste: (String) -> Unit,
    onConfirmPaste: () -> Unit,
    onReset: () -> Unit,
    onDeleteImport: (OfflineImportBatch) -> Unit,
) {
    var mode by remember {
        mutableIntStateOf(if (state is OfflineImportUiState.PastePreview) 1 else 0)
    }
    var pasteText by remember(state) {
        mutableStateOf((state as? OfflineImportUiState.PastePreview)?.source.orEmpty())
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(onOpenSpreadsheet)
    }
    val modeLocked = state !is OfflineImportUiState.Idle

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("Excel / CSV", "复制粘贴").forEachIndexed { index, label ->
                SegmentedButton(
                    selected = mode == index,
                    onClick = { mode = index },
                    enabled = !modeLocked,
                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                ) { Text(label) }
            }
        }
        if (modeLocked) {
            Text(
                when (state) {
                    is OfflineImportUiState.Spreadsheet,
                    OfflineImportUiState.Loading -> "正在处理已选择的表格；请先点击下方“重新选择”，再切换导入方式。"
                    is OfflineImportUiState.PastePreview ->
                        "正在预览粘贴内容；请先点击下方“重新选择”，再切换导入方式。"
                    is OfflineImportUiState.Completed -> "本次导入已完成；点击“继续导入”后可重新选择导入方式。"
                    OfflineImportUiState.Idle -> ""
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when (val importState = state) {
            OfflineImportUiState.Idle -> if (mode == 0) {
                SpreadsheetPicker {
                    // Android vendors assign inconsistent MIME types to CSV and spreadsheet files.
                    // The parser validates the actual file signature after selection.
                    filePicker.launch(arrayOf("*/*"))
                }
            } else {
                PasteEditor(pasteText, { pasteText = it }, { onPreviewPaste(pasteText) })
            }
            OfflineImportUiState.Loading -> {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator()
                    Text("正在检查文件结构和生成预览…")
                }
            }
            is OfflineImportUiState.Spreadsheet -> SpreadsheetSelection(
                state = importState,
                onSelectSheet = onSelectSheet,
                onSelectPhoneColumn = onSelectPhoneColumn,
                onSkipHeaderChange = onSkipHeaderChange,
                onRangeModeChange = onRangeModeChange,
                onStartRowChange = onStartRowChange,
                onEndRowChange = onEndRowChange,
                onConfirm = onConfirmSpreadsheet,
                onCancel = onReset,
            )
            is OfflineImportUiState.PastePreview -> {
                PasteEditor(pasteText, { pasteText = it }, { onPreviewPaste(pasteText) })
                ImportSummary(
                    valid = importState.parsed.validCount,
                    invalid = importState.parsed.invalidCount + importState.parsed.blankCount,
                    duplicates = importState.parsed.duplicateCount,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = onReset, modifier = Modifier.weight(1f)) {
                        Text("重新选择")
                    }
                    Button(
                        onClick = onConfirmPaste,
                        enabled = pasteText == importState.source && importState.parsed.validCount > 0,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text("导入 ${importState.parsed.validCount} 个")
                    }
                }
            }
            is OfflineImportUiState.Completed -> {
                Icon(Icons.Outlined.Phone, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Text("导入完成", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                ImportSummary(
                    valid = importState.result.addedCount,
                    invalid = importState.result.invalidCount,
                    duplicates = importState.result.duplicateCount,
                    validLabel = "新增",
                )
                Button(onClick = onReset, modifier = Modifier.fillMaxWidth()) { Text("继续导入") }
            }
        }
        ImportHistory(importBatches, onDeleteImport)
    }
}

@Composable
private fun SpreadsheetPicker(onPick: () -> Unit) {
    Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
    Text("从手机选择表格", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    Text(
        "支持 .xlsx、.xlsm、.csv 和 .tsv。有无标题都可以，可包含多张表和任意列，选择后只需指定号码列。",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Button(onClick = onPick, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Outlined.FileOpen, contentDescription = null)
        Text("选择文件", modifier = Modifier.padding(start = 8.dp))
    }
    Text(
        "不会执行文件中的宏；单文件最多 25 MiB、100,000 行。",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SpreadsheetSelection(
    state: OfflineImportUiState.Spreadsheet,
    onSelectSheet: (String) -> Unit,
    onSelectPhoneColumn: (Int) -> Unit,
    onSkipHeaderChange: (Boolean) -> Unit,
    onRangeModeChange: (OfflineImportRangeMode) -> Unit,
    onStartRowChange: (String) -> Unit,
    onEndRowChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    Text(state.session.displayName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    Text(
        "格式：${state.session.preview.format.name} · ${state.session.preview.sheets.size} 个工作表",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (state.session.preview.sheets.size > 1) {
        SelectorField(
            label = "工作表",
            value = state.selectedSheet.name,
            options = state.session.preview.sheets.map { it.id to it.name },
            onSelect = onSelectSheet,
        )
    }
    val phoneColumn = state.selectedSheet.columns.first { it.index == state.phoneColumnIndex }
    SelectorField(
        label = "手机号所在列",
        value = phoneColumn.displayLabel(),
        options = state.selectedSheet.columns.map { it.index to it.displayLabel() },
        onSelect = onSelectPhoneColumn,
    )
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("第一行是标题")
            Text("开启后，导入时会跳过第一行", style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = state.skipHeader, onCheckedChange = onSkipHeaderChange)
    }
    Text("导入范围", fontWeight = FontWeight.Medium)
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        listOf(OfflineImportRangeMode.ALL to "全部数据", OfflineImportRangeMode.CUSTOM to "自定义范围")
            .forEachIndexed { index, (mode, label) ->
                SegmentedButton(
                    selected = state.rangeMode == mode,
                    onClick = { onRangeModeChange(mode) },
                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                ) { Text(label) }
            }
    }
    if (state.rangeMode == OfflineImportRangeMode.CUSTOM) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = state.startRowText,
                onValueChange = onStartRowChange,
                label = { Text("起始行") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = state.endRowText,
                onValueChange = onEndRowChange,
                label = { Text("结束行") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        Text(
            "按表格中可见的实际行号计算，包含起始行和结束行；本表最后一行是 ${state.selectedSheet.lastRowNumber}。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    state.rangeError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    SpreadsheetPreviewList(state, phoneColumn)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) { Text("重新选择") }
        Button(
            onClick = onConfirm,
            enabled = state.rangeError == null && !state.previewLoading,
            modifier = Modifier.weight(1f),
        ) { Text("确认导入") }
    }
}

@Composable
private fun SpreadsheetPreviewList(
    state: OfflineImportUiState.Spreadsheet,
    phoneColumn: SpreadsheetColumnPreview,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(0.dp)) {
        Text("所选范围前 20 行预览", fontWeight = FontWeight.Medium)
        Text(
            "只保留标准化后 11 位的号码，其余内容会过滤",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (state.previewLoading) {
            Row(Modifier.padding(vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(modifier = Modifier.width(24.dp), strokeWidth = 2.dp)
                Text("正在刷新范围预览…")
            }
        } else if (state.previewRows.isEmpty()) {
            Text("所选范围没有可预览内容", modifier = Modifier.padding(vertical = 16.dp))
        } else {
            state.previewRows.forEachIndexed { index, sample ->
                val firstPhysicalRow = phoneColumn.previewRows.firstOrNull()?.rowNumber
                val skippedAsHeader = state.skipHeader && sample.rowNumber == firstPhysicalRow
                val valid = sample.normalizedPhone != null
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("${sample.rowNumber}", modifier = Modifier.width(44.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.weight(1f)) {
                        Text(
                            sample.rawValue.ifBlank { "（空白）" },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            when {
                                skippedAsHeader -> "跳过标题"
                                valid -> "将导入 ${sample.normalizedPhone}"
                                else -> "将过滤"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(
                        if (valid && !skippedAsHeader) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline,
                        contentDescription = null,
                        tint = if (valid && !skippedAsHeader) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (index != state.previewRows.lastIndex) HorizontalDivider()
            }
        }
    }
}

@Composable
private fun ImportHistory(
    batches: List<OfflineImportBatch>,
    onDelete: (OfflineImportBatch) -> Unit,
) {
    Text("导入历史", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    if (batches.isEmpty()) {
        Text("暂无导入记录", color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    batches.forEachIndexed { index, batch ->
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(batch.displayName, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(importBatchMetadata(batch), style = MaterialTheme.typography.bodySmall)
                Text(
                    "新增 ${batch.addedCount} · 重复 ${batch.duplicateCount} · 无效 ${batch.invalidCount}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { onDelete(batch) }) {
                Icon(Icons.Outlined.DeleteOutline, contentDescription = "删除本次导入")
            }
        }
        if (index != batches.lastIndex) HorizontalDivider()
    }
}

private fun importBatchMetadata(batch: OfflineImportBatch): String {
    val source = if (batch.source == OfflineImportSource.SPREADSHEET) {
        listOfNotNull(batch.sheetName, batch.columnLetter?.let { "$it 列" }).joinToString(" · ")
    } else {
        "手动粘贴"
    }
    val range = if (batch.requestedStartRow != null && batch.requestedEndRow != null) {
        "第 ${batch.requestedStartRow}-${batch.requestedEndRow} 行"
    } else {
        "全部数据"
    }
    return "${importHistoryTimeFormatter.format(Instant.ofEpochMilli(batch.createdAt))} · $source · $range"
}

private val importHistoryTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    .withZone(ZoneId.of("Asia/Shanghai"))

@Composable
private fun PasteEditor(
    value: String,
    onValueChange: (String) -> Unit,
    onPreview: () -> Unit,
) {
    Text("粘贴手机号", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    Text("号码之间可用换行、Tab、逗号、分号或顿号分隔。", color = MaterialTheme.colorScheme.onSurfaceVariant)
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text("号码列表") },
        placeholder = { Text("13800138000\n13900139000") },
        minLines = 8,
        maxLines = 14,
        modifier = Modifier.fillMaxWidth(),
    )
    Button(onClick = onPreview, enabled = value.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
        Text("检查并预览")
    }
}

@Composable
private fun ImportSummary(
    valid: Int,
    invalid: Int,
    duplicates: Int,
    validLabel: String = "有效",
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            horizontalArrangement = Arrangement.SpaceAround,
        ) {
            SummaryValue(validLabel, valid)
            SummaryValue("无效/空白", invalid)
            SummaryValue("重复", duplicates)
        }
    }
}

@Composable
private fun SummaryValue(label: String, value: Int) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value.toString(), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> SelectorField(
    label: String,
    value: String,
    options: List<Pair<T, String>>,
    onSelect: (T) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (key, optionLabel) ->
                DropdownMenuItem(
                    text = { Text(optionLabel) },
                    onClick = {
                        expanded = false
                        onSelect(key)
                    },
                )
            }
        }
    }
}

private fun SpreadsheetColumnPreview.displayLabel(): String =
    listOfNotNull(letter, header?.takeIf(String::isNotBlank)).joinToString(" · ")
