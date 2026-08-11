package com.company.callcenter.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import java.io.File
import java.security.MessageDigest

internal class ApkPackageVerifier(context: Context) {
    private val packageManager = context.packageManager
    private val installedPackageName = context.packageName

    @Suppress("DEPRECATION")
    fun verify(apkFile: File, release: AppRelease) {
        val archive = packageManager.getPackageArchiveInfo(
            apkFile.absolutePath,
            PackageManager.GET_SIGNING_CERTIFICATES,
        ) ?: throw invalid("Downloaded file is not a valid APK")
        val archivePackageName = archive.packageName
        if (release.packageName != archivePackageName || archivePackageName != installedPackageName) {
            throw invalid("APK package name does not match the installed app")
        }
        if (archive.longVersionCode != release.versionCode) {
            throw invalid("APK version does not match the update manifest")
        }

        val installed = try {
            packageManager.getPackageInfo(installedPackageName, PackageManager.GET_SIGNING_CERTIFICATES)
        } catch (failure: PackageManager.NameNotFoundException) {
            throw invalid("Installed app metadata is unavailable", failure)
        }
        if (archive.longVersionCode <= installed.longVersionCode) {
            throw invalid("Downloaded APK is not newer than the installed app")
        }

        val archiveSigners = archive.signingDigests()
        val installedSigners = installed.signingDigests()
        if (archiveSigners.isEmpty() || installedSigners.isEmpty() || archiveSigners.intersect(installedSigners).isEmpty()) {
            throw invalid("APK signing certificate does not match the installed app")
        }
    }

    private fun PackageInfo.signingDigests(): Set<String> {
        val info = signingInfo ?: return emptySet()
        val signatures = if (info.hasMultipleSigners()) {
            info.apkContentsSigners
        } else {
            info.signingCertificateHistory
        }
        return signatures.orEmpty().mapTo(mutableSetOf()) { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHex()
        }
    }

    private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun invalid(message: String, cause: Throwable? = null) =
        AppUpdateException(UpdateFailureReason.INVALID_APK, message, cause)
}
