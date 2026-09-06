package com.company.callcenter.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.company.callcenter.announcement.AppAnnouncement
import kotlinx.coroutines.delay

@Composable
internal fun StartupAnnouncementGate(checking: Boolean) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        if (checking) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                CircularProgressIndicator()
                Text("正在读取公司公告", style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
internal fun StartupAnnouncementDialog(
    announcement: AppAnnouncement,
    onRead: () -> Unit,
) {
    var remainingSeconds by remember(announcement.id) { mutableIntStateOf(MINIMUM_READING_SECONDS) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(announcement.id, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (remainingSeconds > 0) {
                delay(1_000)
                remainingSeconds -= 1
            }
        }
    }

    AlertDialog(
        onDismissRequest = {},
        title = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("公司公告", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(announcement.title, fontWeight = FontWeight.SemiBold)
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(
                    announcement.content,
                    modifier = Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (remainingSeconds > 0) {
                    LinearProgressIndicator(
                        progress = { 1f - remainingSeconds / MINIMUM_READING_SECONDS.toFloat() },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        "请阅读公告，${remainingSeconds} 秒后可确认",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            Button(enabled = remainingSeconds == 0, onClick = onRead) {
                Text(if (remainingSeconds == 0) "已读并关闭" else "请稍候 ${remainingSeconds} 秒")
            }
        },
    )
}

private const val MINIMUM_READING_SECONDS = 10
