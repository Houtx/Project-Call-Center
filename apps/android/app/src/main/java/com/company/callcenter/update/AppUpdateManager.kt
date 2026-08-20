package com.company.callcenter.update

import android.content.Context
import com.company.callcenter.BuildConfig
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class AppUpdateManager(
    context: Context,
    manifestUrl: String = BuildConfig.UPDATE_MANIFEST_URL,
    releasesBaseUrl: String = BuildConfig.UPDATE_RELEASES_BASE_URL,
    httpClient: OkHttpClient = defaultHttpClient(),
) {
    private val appContext = context.applicationContext
    private val updateCheckStore = UpdateCheckStore(appContext)
    private val userAgent = "CallCenterAgent/${BuildConfig.VERSION_NAME} Android"
    private val packageVerifier = ApkPackageVerifier(appContext)
    private val manifestClient = ReleaseManifestClient(
        httpClient = httpClient,
        manifestUrl = manifestUrl,
        parser = UpdateManifestParser(releasesBaseUrl),
        userAgent = userAgent,
    )
    private val downloader = ApkDownloader(appContext, httpClient, packageVerifier, userAgent)
    private val installer = ApkInstaller(appContext, packageVerifier)

    suspend fun checkForUpdate(
        currentVersionCode: Long = BuildConfig.VERSION_CODE.toLong(),
    ): UpdateCheckResult {
        val release = manifestClient.fetch()
        val highestRequiredVersion = updateCheckStore.recordSuccessfulCheck(release.versionCode)
        return if (UpdatePolicy.requiresUpdate(currentVersionCode, release.versionCode)) {
            UpdateCheckResult.UpdateRequired(release)
        } else if (currentVersionCode < highestRequiredVersion) {
            throw AppUpdateException(
                UpdateFailureReason.INVALID_METADATA,
                "Update manifest is older than a previously observed release",
            )
        } else {
            UpdateCheckResult.UpToDate
        }
    }

    suspend fun downloadAndVerify(
        release: AppRelease,
        onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit = { _, _ -> },
    ): VerifiedApk = downloader.downloadAndVerify(release, onProgress)

    fun launchInstaller(verifiedApk: VerifiedApk): InstallLaunchResult = installer.launch(verifiedApk)

    private companion object {
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .cache(null)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(false)
            .build()
    }
}
