package com.company.callcenter.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
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
import androidx.compose.ui.unit.dp
import com.company.callcenter.offline.importing.SpreadsheetColumnPreview

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OfflineImportScreen(
    state: OfflineImportUiState,
    onOpenSpreadsheet: (android.net.Uri) -> Unit,
    onSelectSheet: (String) -> Unit,
    onSelectPhoneColumn: (Int) -> Unit,
    onSelectNameColumn: (Int?) -> Unit,
    onSkipHeaderChange: (Boolean) -> Unit,
    onConfirmSpreadsheet: () -> Unit,
    onPreviewPaste: (String) -> Unit,
    onConfirmPaste: () -> Unit,
    onReset: () -> Unit,
) {
    var mode by remember(state) {
        mutableIntStateOf(if (state is OfflineImportUiState.PastePreview) 1 else 0)
    }
    var pasteText by remember(state) {
        mutableStateOf((state as? OfflineImportUiState.PastePreview)?.source.orEmpty())
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(onOpenSpreadsheet)
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("Excel / CSV", "复制粘贴").forEachIndexed { index, label ->
                SegmentedButton(
                    selected = mode == index,
                    onClick = { mode = index },
                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                ) { Text(label) }
            }
        }

        when (val importState = state) {
            OfflineImportUiState.Idle -> if (mode == 0) {
                SpreadsheetPicker {
                    filePicker.launch(
                        arrayOf(
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            "text/csv",
                            "text/tab-separated-values",
                            "text/plain",
                            "application/octet-stream",
                        ),
                    )
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
                onSelectNameColumn = onSelectNameColumn,
                onSkipHeaderChange = onSkipHeaderChange,
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
                Button(
                    onClick = onConfirmPaste,
                    enabled = pasteText == importState.source && importState.parsed.validCount > 0,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("导入 ${importState.parsed.validCount} 个有效号码")
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
    }
}

@Composable
private fun SpreadsheetPicker(onPick: () -> Unit) {
    Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
    Text("从手机选择表格", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    Text(
        "支持 .xlsx、.csv 和 .tsv。文件可包含多张表和任意列，选择后再指定手机号列。",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Button(onClick = onPick, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Outlined.FileOpen, contentDescription = null)
        Text("选择文件", modifier = Modifier.padding(start = 8.dp))
    }
    Text(
        "旧版 .xls、加密文件和含宏工作簿不支持；单文件最多 25 MiB、100,000 行。",
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
    onSelectNameColumn: (Int?) -> Unit,
    onSkipHeaderChange: (Boolean) -> Unit,
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
    SelectorField<Int?>(
        label = "姓名所在列（可选）",
        value = state.nameColumnIndex?.let { selected ->
            state.selectedSheet.columns.firstOrNull { it.index == selected }?.displayLabel()
        } ?: "不导入姓名",
        options = listOf(null to "不导入姓名") + state.selectedSheet.columns
            .filter { it.index != state.phoneColumnIndex }
            .map { it.index to it.displayLabel() },
        onSelect = onSelectNameColumn,
    )
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("第一行是标题")
            Text("开启后，导入时会跳过第一行", style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = state.skipHeader, onCheckedChange = onSkipHeaderChange)
    }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("号码列预览", fontWeight = FontWeight.Medium)
            Text(
                "抽样有效 ${phoneColumn.validPhoneCount}/${phoneColumn.sampledValueCount}",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (phoneColumn.samples.isEmpty()) Text("该列没有可预览内容")
            phoneColumn.samples.forEach { sample -> Text(sample) }
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) { Text("重新选择") }
        Button(
            onClick = onConfirm,
            enabled = phoneColumn.validPhoneCount > 0,
            modifier = Modifier.weight(1f),
        ) { Text("确认导入") }
    }
}

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
