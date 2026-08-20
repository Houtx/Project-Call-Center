package com.company.callcenter.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
internal fun UsageTelemetrySetting(
    enabled: Boolean,
    onEnabledChange: (Boolean) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("匿名使用统计", fontWeight = FontWeight.Medium)
            Switch(checked = enabled, onCheckedChange = onEnabledChange)
        }
        Text(
            "每天最多发送一次匿名安装标识、APP/Android 版本、使用模式、国家/时区与按日外呼汇总。" +
                "服务端仅保留脱敏 IP，不包含号码、客户、SIM、服务器、文件或通话明细。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
internal fun UsageTelemetryConsentDialog(
    onAccept: () -> Unit,
    onDecline: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDecline,
        title = { Text("匿名使用统计") },
        text = {
            Text(
                "是否允许每天最多发送一次匿名设备、版本、模式和外呼数量汇总？" +
                    "不上传号码、客户、通话明细或导入文件，可随时在“我的”中关闭。",
            )
        },
        confirmButton = { Button(onClick = onAccept) { Text("允许") } },
        dismissButton = { TextButton(onClick = onDecline) { Text("暂不允许") } },
    )
}
