package com.company.callcenter.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.PeopleAlt
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.company.callcenter.data.CallStatistics
import com.company.callcenter.data.CallStatisticsRange
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallStatisticsScreen(
    statistics: CallStatistics,
    range: CallStatisticsRange,
    onRangeChange: (CallStatisticsRange) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                val ranges = listOf(
                    CallStatisticsRange.TODAY to "今天",
                    CallStatisticsRange.LAST_7_DAYS to "近7天",
                    CallStatisticsRange.ALL to "全部",
                )
                ranges.forEachIndexed { index, (item, label) ->
                    SegmentedButton(
                        selected = range == item,
                        onClick = { onRangeChange(item) },
                        shape = SegmentedButtonDefaults.itemShape(index, ranges.size),
                    ) { Text(label) }
                }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatisticCard("外呼次数", statistics.callCount.toString(), Icons.Outlined.Call, Modifier.weight(1f))
                StatisticCard("去重客户", statistics.customerCount.toString(), Icons.Outlined.PeopleAlt, Modifier.weight(1f))
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatisticCard("接通", statistics.connectedCount.toString(), Icons.Outlined.CheckCircle, Modifier.weight(1f))
                StatisticCard(
                    "接通率",
                    String.format(Locale.CHINA, "%.1f%%", statistics.connectionRate * 100),
                    Icons.Outlined.CheckCircle,
                    Modifier.weight(1f),
                )
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatisticCard("未接通", statistics.notConnectedCount.toString(), Icons.Outlined.Call, Modifier.weight(1f))
                StatisticCard("未知", statistics.unknownCount.toString(), Icons.Outlined.Call, Modifier.weight(1f))
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatisticCard(
                    "平均通话",
                    formatDuration(statistics.averageDurationSeconds.toLong()),
                    Icons.Outlined.AccessTime,
                    Modifier.weight(1f),
                )
                StatisticCard(
                    "最长通话",
                    formatDuration(statistics.maximumDurationSeconds.toLong()),
                    Icons.Outlined.AccessTime,
                    Modifier.weight(1f),
                )
            }
        }
        item {
            StatisticCard(
                "总通话时长",
                formatDuration(statistics.totalDurationSeconds),
                Icons.Outlined.AccessTime,
                Modifier.fillMaxWidth(),
            )
        }
        item {
            Text(
                "未知结果计入外呼次数，但不进入接通率分母。统计来自本机已完成采集的记录。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun StatisticCard(
    label: String,
    value: String,
    icon: ImageVector,
    modifier: Modifier,
) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun formatDuration(seconds: Long): String {
    if (seconds <= 0) return "0秒"
    val hours = seconds / 3_600
    val minutes = (seconds % 3_600) / 60
    val remainingSeconds = seconds % 60
    return buildString {
        if (hours > 0) append("${hours}小时")
        if (minutes > 0) append("${minutes}分")
        if (remainingSeconds > 0 || isEmpty()) append("${remainingSeconds}秒")
    }
}
