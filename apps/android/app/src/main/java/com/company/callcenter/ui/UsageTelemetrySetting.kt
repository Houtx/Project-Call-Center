package com.company.callcenter.ui

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.company.callcenter.telemetry.UsageTelemetryDisablePolicy

@Composable
internal fun UsageTelemetrySetting(
    enabled: Boolean,
    onEnabledChange: (Boolean) -> Unit,
) {
    var showDisableDialog by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var passwordError by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("匿名使用统计", fontWeight = FontWeight.Medium)
            Switch(
                checked = enabled,
                onCheckedChange = { requested ->
                    if (requested) {
                        onEnabledChange(true)
                    } else {
                        password = ""
                        passwordError = null
                        showDisableDialog = true
                    }
                },
            )
        }
        Text(
            "公司内部版本默认开启；关闭时需要输入当天管理口令。每天最多发送一次匿名安装标识、APP/Android 版本、使用模式、国家/时区与按日外呼汇总。" +
                "服务端仅保留脱敏 IP，不包含号码、客户、SIM、服务器、文件或通话明细。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (showDisableDialog) {
        AlertDialog(
            onDismissRequest = {
                showDisableDialog = false
                password = ""
                passwordError = null
            },
            title = { Text("关闭匿名使用统计") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("请输入当天的 8 位管理口令，验证通过后才能关闭。")
                    OutlinedTextField(
                        value = password,
                        onValueChange = {
                            password = it.filter(Char::isDigit).take(8)
                            passwordError = null
                        },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("管理口令") },
                        singleLine = true,
                        isError = passwordError != null,
                        supportingText = passwordError?.let { message -> ({ Text(message) }) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        visualTransformation = PasswordVisualTransformation(),
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = password.length == 8,
                    onClick = {
                        if (UsageTelemetryDisablePolicy.isValid(password)) {
                            onEnabledChange(false)
                            showDisableDialog = false
                            password = ""
                            passwordError = null
                        } else {
                            passwordError = "管理口令不正确"
                        }
                    },
                ) { Text("确认关闭") }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showDisableDialog = false
                        password = ""
                        passwordError = null
                    },
                ) { Text("取消") }
            },
        )
    }
}
