package com.company.callcenter.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun AppModeScreen(
    onOnline: () -> Unit,
    onOffline: () -> Unit,
) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text("选择使用方式", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(
                "之后可以在“我的”中随时切换，在线与离线数据相互隔离。",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onOnline, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Cloud, contentDescription = null)
                Text("连接公司服务器", modifier = Modifier.padding(start = 8.dp))
            }
            OutlinedButton(onClick = onOffline, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.PhoneAndroid, contentDescription = null)
                Text("只在本机离线使用", modifier = Modifier.padding(start = 8.dp))
            }
            Text(
                "离线模式不连接 CRM 服务器；APP 更新检查仍可能使用互联网。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
