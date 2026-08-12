package com.company.callcenter.update

import android.content.Intent
import java.io.File

data class AppRelease(
    val versionCode: Long,
    val versionName: String,
    val releaseTag: String,
    val packageName: String,
    val apkAsset: String,
    val apkDownloadUrl: String,
    val sha256: String,
    val sizeBytes: Long,
)

sealed interface UpdateCheckResult {
    data object UpToDate : UpdateCheckResult
    data class UpdateRequired(val release: AppRelease) : UpdateCheckResult
}

data class VerifiedApk internal constructor(
    val release: AppRelease,
    val file: File,
)

sealed interface InstallLaunchResult {
    data object InstallerOpened : InstallLaunchResult
    data class PermissionRequired(val settingsIntent: Intent) : InstallLaunchResult
}

enum class UpdateFailureReason {
    NETWORK,
    INVALID_METADATA,
    DOWNLOAD_FAILED,
    INTEGRITY_FAILED,
    INVALID_APK,
    INSTALLER_UNAVAILABLE,
}

class AppUpdateException(
    val reason: UpdateFailureReason,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

object UpdatePolicy {
    fun isCheckDisabled(debug: Boolean, manifestUrl: String): Boolean =
        debug && manifestUrl.isBlank()

    fun requiresUpdate(currentVersionCode: Long, releaseVersionCode: Long): Boolean {
        require(currentVersionCode > 0) { "Current version code must be positive" }
        require(releaseVersionCode > 0) { "Release version code must be positive" }
        return releaseVersionCode > currentVersionCode
    }
}
