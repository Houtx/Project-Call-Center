package com.company.callcenter

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.company.callcenter.ui.AgentApp
import com.company.callcenter.ui.AgentViewModel
import com.company.callcenter.ui.AgentViewModelFactory
import com.company.callcenter.ui.AppModeScreen
import com.company.callcenter.ui.CallCenterTheme
import com.company.callcenter.ui.OfflineAgentApp
import com.company.callcenter.ui.OfflineViewModel
import com.company.callcenter.ui.OfflineViewModelFactory
import com.company.callcenter.data.AppMode
import com.company.callcenter.data.DialSource
import com.company.callcenter.data.offline.OfflineDialAccessPolicy
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val permissionsReady = mutableStateOf(false)
    private val updateState = MutableStateFlow<StartupUpdateState>(StartupUpdateState.Checking)
    private val updateManager by lazy { AppUpdateManager(applicationContext) }
    private val appContainer by lazy { (application as CallCenterApplication).container }
    private val viewModel: AgentViewModel by viewModels {
        AgentViewModelFactory(appContainer.repository, appContainer.simCallManager, appContainer.appModeStore)
    }
    private val offlineViewModel: OfflineViewModel by viewModels {
        OfflineViewModelFactory(
            appContainer.offlineRepository,
            appContainer.simCallManager,
            appContainer.offlineImportService,
        )
    }
    private var updateJob: Job? = null
    private var dialCollectorStarted = false
    private var pendingRecordingAuthorization: com.company.callcenter.data.DialAuthorization? = null
    private var backgroundLockJob: Job? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        permissionsReady.value = requiredPermissionsGranted()
        viewModel.refreshSimConfiguration()
        offlineViewModel.refreshSimConfiguration()
        if (permissionsReady.value && updateState.value == StartupUpdateState.Ready) {
            when (appContainer.appModeStore.mode.value) {
                AppMode.ONLINE -> viewModel.refresh()
                AppMode.OFFLINE -> offlineViewModel.refresh()
                null -> Unit
            }
        }
    }

    private val unknownSourcesLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        val current = updateState.value
        if (current is StartupUpdateState.PermissionRequired) {
            updateState.value = current
        }
    }

    private val recordingPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val authorization = pendingRecordingAuthorization ?: return@registerForActivityResult
        pendingRecordingAuthorization = null
        lifecycleScope.launch {
            continueDial(authorization, granted)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        permissionsReady.value = requiredPermissionsGranted()
        setContent {
            val startupState = updateState.collectAsStateWithLifecycle().value
            val appMode = appContainer.appModeStore.mode.collectAsStateWithLifecycle().value
            val telemetryEnabled = appContainer.usageTelemetry.enabled.collectAsStateWithLifecycle().value
            CallCenterTheme {
                if (startupState == StartupUpdateState.Ready) {
                    val requestCallPermissions = {
                        permissionLauncher.launch(
                            arrayOf(
                                Manifest.permission.CALL_PHONE,
                                Manifest.permission.READ_CALL_LOG,
                                Manifest.permission.READ_PHONE_STATE,
                            ),
                        )
                    }
                    when (appMode) {
                        null -> AppModeScreen(
                            onOnline = { appContainer.appModeStore.select(AppMode.ONLINE) },
                            onOffline = { appContainer.appModeStore.select(AppMode.OFFLINE) },
                        )
                        AppMode.ONLINE -> AgentApp(
                            viewModel = viewModel,
                            permissionsGranted = permissionsReady.value,
                            requestPermissions = requestCallPermissions,
                            telemetryAvailable = appContainer.usageTelemetry.isAvailable,
                            telemetryEnabled = telemetryEnabled,
                            onTelemetryEnabledChange = appContainer.usageTelemetry::setEnabled,
                            onUseOffline = {
                                if (!viewModel.state.value.loading && !viewModel.state.value.hasPendingCall) {
                                    appContainer.appModeStore.select(AppMode.OFFLINE)
                                }
                            },
                        )
                        AppMode.OFFLINE -> OfflineAgentApp(
                            viewModel = offlineViewModel,
                            permissionsGranted = permissionsReady.value,
                            requestPermissions = requestCallPermissions,
                            telemetryAvailable = appContainer.usageTelemetry.isAvailable,
                            telemetryEnabled = telemetryEnabled,
                            onTelemetryEnabledChange = appContainer.usageTelemetry::setEnabled,
                            onUseOnline = {
                                if (!offlineViewModel.state.value.loading && !offlineViewModel.state.value.hasPendingCall) {
                                    offlineViewModel.lock()
                                    appContainer.appModeStore.select(AppMode.ONLINE)
                                }
                            },
                        )
                    }
                } else {
                    UpdateGateScreen(
                        state = startupState,
                        onRetry = ::beginUpdateCheck,
                        onContinueInstallation = ::openInstaller,
                    )
                }
            }
        }
        lifecycleScope.launch {
            appContainer.appModeStore.mode.collect { mode ->
                if (mode == AppMode.OFFLINE) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
            }
        }
        beginUpdateCheck()
    }

    override fun onResume() {
        super.onResume()
        backgroundLockJob?.cancel()
        backgroundLockJob = null
        permissionsReady.value = requiredPermissionsGranted()
        if (updateState.value == StartupUpdateState.Ready) {
            viewModel.refreshSimConfiguration()
            offlineViewModel.refreshSimConfiguration()
            if (appContainer.appModeStore.mode.value == AppMode.OFFLINE) {
                appContainer.offlineRepository.lockIfBackgroundTimeout(OFFLINE_AUTO_LOCK_MILLIS)
            }
            when (appContainer.appModeStore.mode.value) {
                AppMode.ONLINE -> viewModel.onReturnedToForeground()
                AppMode.OFFLINE -> offlineViewModel.onReturnedToForeground()
                null -> Unit
            }
        }
    }

    override fun onStop() {
        if (appContainer.appModeStore.mode.value == AppMode.OFFLINE) {
            appContainer.offlineRepository.markBackgrounded()
            backgroundLockJob?.cancel()
            backgroundLockJob = lifecycleScope.launch {
                delay(OFFLINE_AUTO_LOCK_MILLIS)
                if (appContainer.appModeStore.mode.value == AppMode.OFFLINE) {
                    offlineViewModel.lock()
                }
            }
        }
        super.onStop()
    }

    override fun onDestroy() {
        backgroundLockJob?.cancel()
        if (isFinishing && dialCollectorStarted && appContainer.appModeStore.mode.value == AppMode.OFFLINE) {
            offlineViewModel.lock()
        }
        super.onDestroy()
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
                if (updateManager.canUseCachedPolicy(failure)) {
                    Toast.makeText(
                        this@MainActivity,
                        "更新服务暂时不可达，已使用 72 小时内的版本校验结果",
                        Toast.LENGTH_LONG,
                    ).show()
                    unlockApplication()
                } else {
                    updateState.value = StartupUpdateState.Failed(failure.toUpdateMessage())
                }
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
        if (appContainer.appModeStore.mode.value == AppMode.OFFLINE) {
            appContainer.offlineRepository.lockIfBackgroundTimeout(OFFLINE_AUTO_LOCK_MILLIS)
        }
        startDialCollector()
        updateState.value = StartupUpdateState.Ready
    }

    private fun startDialCollector() {
        if (dialCollectorStarted) return
        dialCollectorStarted = true
        lifecycleScope.launch {
            viewModel.dialEvents.collect(::consumeDialAuthorization)
        }
        lifecycleScope.launch {
            offlineViewModel.dialEvents.collect(::consumeDialAuthorization)
        }
    }

    private suspend fun consumeDialAuthorization(authorization: com.company.callcenter.data.DialAuthorization) {
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) || !isAuthorizationUsable(authorization)) {
            cancelAuthorization(authorization)
            return
        }
        handleDialAuthorization(authorization)
    }

    private suspend fun handleDialAuthorization(authorization: com.company.callcenter.data.DialAuthorization) {
        if (
            authorization.recordingRequested &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingRecordingAuthorization = authorization
            recordingPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        } else {
            continueDial(authorization, granted = true)
        }
    }

    private suspend fun continueDial(
        authorization: com.company.callcenter.data.DialAuthorization,
        granted: Boolean,
    ) {
        if (!isAuthorizationUsable(authorization)) {
            cancelAuthorization(authorization)
            return
        }
        if (
            authorization.source == DialSource.ONLINE &&
            authorization.recordingRequested &&
            (!granted || !appContainer.repository.startRecording(authorization.attemptId))
        ) {
            appContainer.repository.markRecordingUnsupported(
                authorization.attemptId,
                if (granted) "VOICE_CALL_SOURCE_REJECTED" else "RECORD_AUDIO_PERMISSION_DENIED",
            )
        }
        if (!isAuthorizationUsable(authorization)) {
            if (authorization.source == DialSource.ONLINE) appContainer.repository.discardRecording()
            cancelAuthorization(authorization)
            return
        }
        runCatching { appContainer.simCallManager.placeCall(authorization.phone) }
            .onFailure { failure ->
                if (authorization.source == DialSource.ONLINE) {
                    appContainer.repository.discardRecording()
                    viewModel.reportDialLaunchFailure(authorization.attemptId, failure)
                } else {
                    offlineViewModel.reportDialLaunchFailure(authorization.attemptId, failure)
                }
            }
    }

    private fun isAuthorizationUsable(authorization: com.company.callcenter.data.DialAuthorization): Boolean =
        when (authorization.source) {
            DialSource.ONLINE -> appContainer.appModeStore.mode.value == AppMode.ONLINE &&
                appContainer.repository.isLoggedIn
            DialSource.OFFLINE -> OfflineDialAccessPolicy.canAuthorize(
                appContainer.appModeStore.mode.value,
                appContainer.offlineRepository.unlocked.value,
            )
        }

    private suspend fun cancelAuthorization(authorization: com.company.callcenter.data.DialAuthorization) {
        if (authorization.source == DialSource.ONLINE) {
            appContainer.repository.discardRecording()
            runCatching { appContainer.repository.cancelFailedCallAttempt(authorization.attemptId) }
        } else {
            appContainer.offlineRepository.cancelFailedCallAttempt(authorization.attemptId)
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
        const val OFFLINE_AUTO_LOCK_MILLIS = 60_000L
    }
}
