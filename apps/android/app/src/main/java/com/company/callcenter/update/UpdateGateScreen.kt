package com.company.callcenter.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SystemUpdateAlt
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

sealed interface StartupUpdateState {
    data object Checking : StartupUpdateState
    data object Ready : StartupUpdateState
    data class Downloading(val release: AppRelease, val percent: Int) : StartupUpdateState
    data class PermissionRequired(val verifiedApk: VerifiedApk) : StartupUpdateState
    data class InstallationPending(val verifiedApk: VerifiedApk) : StartupUpdateState
    data class Failed(val message: String) : StartupUpdateState
}

@Composable
fun UpdateGateScreen(
    state: StartupUpdateState,
    onRetry: () -> Unit,
    onContinueInstallation: (VerifiedApk) -> Unit,
) {
    Box(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().widthIn(max = 440.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                Icons.Outlined.SystemUpdateAlt,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(20.dp))
            when (state) {
                StartupUpdateState.Checking -> CheckingContent()
                is StartupUpdateState.Downloading -> DownloadingContent(state)
                is StartupUpdateState.PermissionRequired -> InstallationContent(
                    title = "允许安装更新",
                    message = "请允许本应用安装内部发布的 APK，授权后返回继续安装。",
                    buttonLabel = "继续安装",
                    onContinue = { onContinueInstallation(state.verifiedApk) },
                )
                is StartupUpdateState.InstallationPending -> InstallationContent(
                    title = "必须完成更新",
                    message = "系统安装界面已打开。完成安装并重新启动后才能继续使用。",
                    buttonLabel = "重新打开安装器",
                    onContinue = { onContinueInstallation(state.verifiedApk) },
                )
                is StartupUpdateState.Failed -> FailureContent(state.message, onRetry)
                StartupUpdateState.Ready -> Unit
            }
        }
    }
}

@Composable
private fun CheckingContent() {
    Text("正在检查更新", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(10.dp))
    Text("确认版本后即可进入", color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(24.dp))
    CircularProgressIndicator()
}

@Composable
private fun DownloadingContent(state: StartupUpdateState.Downloading) {
    Text("发现新版本 ${state.release.versionName}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(10.dp))
    Text("正在下载安装包，更新完成前无法进入", color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(24.dp))
    LinearProgressIndicator(
        progress = { state.percent / 100f },
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    Text("${state.percent}%", style = MaterialTheme.typography.labelLarge)
}

@Composable
private fun InstallationContent(
    title: String,
    message: String,
    buttonLabel: String,
    onContinue: () -> Unit,
) {
    Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(10.dp))
    Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    Spacer(Modifier.height(24.dp))
    Button(onClick = onContinue, modifier = Modifier.fillMaxWidth().height(48.dp)) {
        Text(buttonLabel)
    }
}

@Composable
private fun FailureContent(message: String, onRetry: () -> Unit) {
    Text("暂时无法进入", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(10.dp))
    Text(message, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
    Spacer(Modifier.height(24.dp))
    OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth().height(48.dp)) {
        Text("重试")
    }
}
