package com.company.callcenter

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.company.callcenter.ui.AgentApp
import com.company.callcenter.ui.AgentViewModel
import com.company.callcenter.ui.AgentViewModelFactory
import com.company.callcenter.ui.CallCenterTheme
import com.company.callcenter.update.AppUpdateException
import com.company.callcenter.update.AppUpdateManager
import com.company.callcenter.update.InstallLaunchResult
import com.company.callcenter.update.StartupUpdateState
import com.company.callcenter.update.UpdateCheckResult
import com.company.callcenter.update.UpdateFailureReason
import com.company.callcenter.update.UpdateGateScreen
import com.company.callcenter.update.UpdatePolicy
import com.company.callcenter.update.VerifiedApk
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val permissionsReady = mutableStateOf(false)
    private val updateState = MutableStateFlow<StartupUpdateState>(StartupUpdateState.Checking)
    private val updateManager by lazy { AppUpdateManager(applicationContext) }
    private val appContainer by lazy { (application as CallCenterApplication).container }
    private val viewModel: AgentViewModel by viewModels {
        AgentViewModelFactory(appContainer.repository, appContainer.simCallManager)
    }
    private var updateJob: Job? = null
    private var dialCollectorStarted = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        permissionsReady.value = requiredPermissionsGranted()
        viewModel.refreshSimConfiguration()
        if (permissionsReady.value && updateState.value == StartupUpdateState.Ready) viewModel.refresh()
    }

    private val unknownSourcesLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        val current = updateState.value
        if (current is StartupUpdateState.PermissionRequired) {
            updateState.value = current
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        permissionsReady.value = requiredPermissionsGranted()
        setContent {
            val startupState = updateState.collectAsStateWithLifecycle().value
            CallCenterTheme {
                if (startupState == StartupUpdateState.Ready) {
                    AgentApp(
                        viewModel = viewModel,
                        permissionsGranted = permissionsReady.value,
                        requestPermissions = {
                            permissionLauncher.launch(
                                arrayOf(
                                    Manifest.permission.CALL_PHONE,
                                    Manifest.permission.READ_CALL_LOG,
                                    Manifest.permission.READ_PHONE_STATE,
                                    Manifest.permission.RECORD_AUDIO,
                                ),
                            )
                        },
                    )
                } else {
                    UpdateGateScreen(
                        state = startupState,
                        onRetry = ::beginUpdateCheck,
                        onContinueInstallation = ::openInstaller,
                    )
                }
            }
        }
        beginUpdateCheck()
    }

    override fun onResume() {
        super.onResume()
        permissionsReady.value = requiredPermissionsGranted()
        if (updateState.value == StartupUpdateState.Ready) {
            viewModel.refreshSimConfiguration()
            viewModel.onReturnedToForeground()
        }
    }

    private fun beginUpdateCheck() {
        if (updateJob?.isActive == true) return
        if (UpdatePolicy.isCheckDisabled(BuildConfig.DEBUG, BuildConfig.UPDATE_MANIFEST_URL)) {
            // Open-source Debug builds have no organization-specific release feed.
            // A Release build is rejected by Gradle unless the feed is configured.
            unlockApplication()
            return
        }
        updateJob = lifecycleScope.launch {
            updateState.value = StartupUpdateState.Checking
            try {
                when (val result = updateManager.checkForUpdate()) {
                    UpdateCheckResult.UpToDate -> unlockApplication()
                    is UpdateCheckResult.UpdateRequired -> downloadAndInstall(result.release)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                updateState.value = StartupUpdateState.Failed(failure.toUpdateMessage())
            }
        }
    }

    private suspend fun downloadAndInstall(release: com.company.callcenter.update.AppRelease) {
        updateState.value = StartupUpdateState.Downloading(release, 0)
        var lastReportedBytes = 0L
        val verifiedApk = try {
            updateManager.downloadAndVerify(release) { downloaded, total ->
                if (downloaded == total || downloaded - lastReportedBytes >= PROGRESS_STEP_BYTES) {
                    lastReportedBytes = downloaded
                    val percent = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                    updateState.value = StartupUpdateState.Downloading(release, percent)
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            updateState.value = StartupUpdateState.Failed(failure.toUpdateMessage())
            return
        }
        openInstaller(verifiedApk)
    }

    private fun openInstaller(verifiedApk: VerifiedApk) {
        runCatching { updateManager.launchInstaller(verifiedApk) }
            .onSuccess { result ->
                when (result) {
                    InstallLaunchResult.InstallerOpened -> {
                        updateState.value = StartupUpdateState.InstallationPending(verifiedApk)
                    }
                    is InstallLaunchResult.PermissionRequired -> {
                        updateState.value = StartupUpdateState.PermissionRequired(verifiedApk)
                        runCatching { unknownSourcesLauncher.launch(result.settingsIntent) }
                            .onFailure { failure ->
                                updateState.value = StartupUpdateState.Failed(failure.toUpdateMessage())
                            }
                    }
                }
            }
            .onFailure { failure ->
                updateState.value = StartupUpdateState.Failed(failure.toUpdateMessage())
            }
    }

    private fun unlockApplication() {
        startDialCollector()
        updateState.value = StartupUpdateState.Ready
    }

    private fun startDialCollector() {
        if (dialCollectorStarted) return
        dialCollectorStarted = true
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.dialEvents.collect { authorization ->
                    if (authorization.recordingRequested && !appContainer.repository.startRecording(authorization.attemptId)) {
                        appContainer.repository.markRecordingUnsupported(authorization.attemptId, "VOICE_CALL_SOURCE_REJECTED")
                    }
                    runCatching { appContainer.simCallManager.placeCall(authorization.phone) }
                        .onFailure { failure ->
                            appContainer.repository.discardRecording()
                            viewModel.reportDialLaunchFailure(authorization.attemptId, failure)
                        }
                }
            }
        }
    }

    private fun Throwable.toUpdateMessage(): String = when ((this as? AppUpdateException)?.reason) {
        UpdateFailureReason.NETWORK -> "无法连接更新服务器，请检查网络后重试"
        UpdateFailureReason.INVALID_METADATA -> "更新信息无效，请联系管理员"
        UpdateFailureReason.DOWNLOAD_FAILED -> "安装包下载失败，请重试"
        UpdateFailureReason.INTEGRITY_FAILED -> "安装包校验失败，请联系管理员"
        UpdateFailureReason.INVALID_APK -> "安装包签名或版本不正确，请联系管理员"
        UpdateFailureReason.INSTALLER_UNAVAILABLE -> "手机未找到可用的系统安装器"
        null -> "更新检查失败，请重试"
    }

    private fun requiredPermissionsGranted(): Boolean {
        val missingPermissions = listOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_PHONE_STATE,
        ).filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (BuildConfig.DEBUG) {
            Log.d(LOG_TAG, "Missing call permissions: ${missingPermissions.joinToString()}")
        }
        return missingPermissions.isEmpty()
    }

    private companion object {
        const val LOG_TAG = "CallCenterActivity"
        const val PROGRESS_STEP_BYTES = 256L * 1024L
    }
}
