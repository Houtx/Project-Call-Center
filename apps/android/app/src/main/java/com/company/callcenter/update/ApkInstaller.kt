package com.company.callcenter.update

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider

internal class ApkInstaller(
    private val context: Context,
    private val packageVerifier: ApkPackageVerifier,
) {
    fun launch(verifiedApk: VerifiedApk): InstallLaunchResult {
        packageVerifier.verify(verifiedApk.file, verifiedApk.release)
        if (!context.packageManager.canRequestPackageInstalls()) {
            return InstallLaunchResult.PermissionRequired(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${context.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }

        val apkUri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.updates",
            verifiedApk.file,
        )
        val installIntent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(apkUri, APK_CONTENT_TYPE)
            .apply {
                clipData = ClipData.newRawUri("APK update", apkUri)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        if (installIntent.resolveActivity(context.packageManager) == null) {
            throw AppUpdateException(UpdateFailureReason.INSTALLER_UNAVAILABLE, "No APK installer is available")
        }
        context.startActivity(installIntent)
        return InstallLaunchResult.InstallerOpened
    }

    private companion object {
        const val APK_CONTENT_TYPE = "application/vnd.android.package-archive"
    }
}
