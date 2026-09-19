package com.company.callcenter.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.LocationOff
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.MyLocation
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

enum class LocationPermissionStatus {
    PRECISE,
    APPROXIMATE,
    APPROXIMATE_SETTINGS_REQUIRED,
    REQUESTABLE,
    SETTINGS_REQUIRED,
}

@Composable
internal fun LocationPermissionSetting(
    status: LocationPermissionStatus,
    onRequestPermission: () -> Unit,
) {
    val granted = status == LocationPermissionStatus.PRECISE ||
        status == LocationPermissionStatus.APPROXIMATE ||
        status == LocationPermissionStatus.APPROXIMATE_SETTINGS_REQUIRED
    val statusText = when (status) {
        LocationPermissionStatus.PRECISE -> "精确定位已开启"
        LocationPermissionStatus.APPROXIMATE -> "大致位置已开启"
        LocationPermissionStatus.APPROXIMATE_SETTINGS_REQUIRED -> "大致位置已开启，可在系统设置提升精度"
        LocationPermissionStatus.REQUESTABLE -> "位置权限尚未开启"
        LocationPermissionStatus.SETTINGS_REQUIRED -> "需要在系统设置中开启位置权限"
    }

    HorizontalDivider()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = if (granted) Icons.Outlined.LocationOn else Icons.Outlined.LocationOff,
                contentDescription = null,
                tint = if (granted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            )
            Column(Modifier.padding(start = 10.dp)) {
                Text("位置权限", fontWeight = FontWeight.Medium)
                Text(
                    statusText,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        when (status) {
            LocationPermissionStatus.PRECISE -> Unit
            LocationPermissionStatus.APPROXIMATE -> OutlinedButton(
                onClick = onRequestPermission,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.MyLocation, contentDescription = null)
                Text("开启精确定位", modifier = Modifier.padding(start = 6.dp))
            }
            LocationPermissionStatus.APPROXIMATE_SETTINGS_REQUIRED -> OutlinedButton(
                onClick = onRequestPermission,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.Settings, contentDescription = null)
                Text("前往系统设置提升精度", modifier = Modifier.padding(start = 6.dp))
            }
            LocationPermissionStatus.REQUESTABLE -> FilledTonalButton(
                onClick = onRequestPermission,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.MyLocation, contentDescription = null)
                Text("开启位置权限", modifier = Modifier.padding(start = 6.dp))
            }
            LocationPermissionStatus.SETTINGS_REQUIRED -> FilledTonalButton(
                onClick = onRequestPermission,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.Settings, contentDescription = null)
                Text("前往系统设置", modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}
