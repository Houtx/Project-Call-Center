package com.company.callcenter.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.company.callcenter.data.AutoDialSettingsStore

@Composable
internal fun AutoDialBanner(
    state: AutoDialUiState,
    canEnable: Boolean,
    onEnabledChange: (Boolean) -> Unit,
) {
    val active = state.enabled
    val containerColor = if (active) {
        MaterialTheme.colorScheme.primaryContainer
    } else {
        MaterialTheme.colorScheme.surfaceContainerLow
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = containerColor),
        border = BorderStroke(
            width = if (active) 2.dp else 1.dp,
            color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
        ),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.Call,
                    contentDescription = null,
                    tint = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(
                        when {
                            !active -> "自动拨号"
                            state.phase == AutoDialPhase.PAUSED -> "自动拨号已暂停"
                            state.phase == AutoDialPhase.DIALING -> "正在自动拨号"
                            else -> "自动拨号模式运行中"
                        },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        if (active) state.message else "开启后按任务顺序自动外呼",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = active,
                    onCheckedChange = onEnabledChange,
                    enabled = active || canEnable,
                )
            }
            if (active) {
                state.remainingSeconds?.let { remaining ->
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            remaining.toString(),
                            style = MaterialTheme.typography.displaySmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text("秒后拨打下一条", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Button(
                    onClick = { onEnabledChange(false) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Icon(Icons.Outlined.StopCircle, contentDescription = null)
                    Text("停止自动拨号", modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@Composable
internal fun AutoDialDelaySetting(
    delaySeconds: Int,
    enabled: Boolean,
    onDelayChange: (Int) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("挂断后等待时间", fontWeight = FontWeight.Medium)
        Text(
            "上一通结束并完成结果核验后，倒计时再拨下一条。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = { onDelayChange(delaySeconds - 1) },
                enabled = enabled && delaySeconds > AutoDialSettingsStore.MIN_DELAY_SECONDS,
            ) {
                Icon(Icons.Outlined.Remove, contentDescription = "减少等待时间")
            }
            Text(
                "$delaySeconds 秒",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
            IconButton(
                onClick = { onDelayChange(delaySeconds + 1) },
                enabled = enabled && delaySeconds < AutoDialSettingsStore.MAX_DELAY_SECONDS,
            ) {
                Icon(Icons.Outlined.Add, contentDescription = "增加等待时间")
            }
        }
        Text(
            "可设置 ${AutoDialSettingsStore.MIN_DELAY_SECONDS}–${AutoDialSettingsStore.MAX_DELAY_SECONDS} 秒，默认 10 秒。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
