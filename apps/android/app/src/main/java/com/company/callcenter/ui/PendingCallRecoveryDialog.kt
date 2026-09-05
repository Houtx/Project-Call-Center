package com.company.callcenter.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable

@Composable
fun PendingCallRecoveryDialog(
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { Button(onClick = onConfirm) { Text("确认恢复") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
        icon = { Icon(Icons.Outlined.RestartAlt, contentDescription = null) },
        title = { Text("强制恢复拨号") },
        text = {
            Text(
                "仅在确认上一通电话已经结束后使用。系统仍无法读取到的通话会记为“未知”，" +
                    "尚未完成上传的录音可能被放弃。联系人、任务和已有通话记录不会被删除。",
            )
        },
    )
}
