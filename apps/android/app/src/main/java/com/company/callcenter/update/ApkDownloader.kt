package com.company.callcenter.update

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

internal class ApkDownloader(
    context: Context,
    private val httpClient: OkHttpClient,
    private val packageVerifier: ApkPackageVerifier,
    private val userAgent: String,
) {
    private val updateDirectory = File(context.cacheDir, UPDATE_DIRECTORY).apply { mkdirs() }

    suspend fun downloadAndVerify(
        release: AppRelease,
        onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit,
    ): VerifiedApk = withContext(Dispatchers.IO) {
        val temporary = try {
            File.createTempFile("download-", ".part", updateDirectory)
        } catch (failure: IOException) {
            throw AppUpdateException(
                UpdateFailureReason.DOWNLOAD_FAILED,
                "Unable to prepare APK download",
                failure,
            )
        }
        try {
            val request = Request.Builder()
                .url(release.apkDownloadUrl)
                .header("Accept", APK_CONTENT_TYPE)
                .header("Cache-Control", "no-cache")
                .header("User-Agent", userAgent)
                .build()
            val digest = MessageDigest.getInstance("SHA-256")
            var downloaded = 0L
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw AppUpdateException(
                        UpdateFailureReason.DOWNLOAD_FAILED,
                        "APK download failed with HTTP ${response.code}",
                    )
                }
                val body = response.body
                    ?: throw AppUpdateException(UpdateFailureReason.DOWNLOAD_FAILED, "APK response is empty")
                val reportedSize = body.contentLength()
                if (reportedSize > 0 && reportedSize != release.sizeBytes) {
                    throw AppUpdateException(
                        UpdateFailureReason.INTEGRITY_FAILED,
                        "APK size does not match the update manifest",
                    )
                }
                body.byteStream().use { input ->
                    FileOutputStream(temporary).use { output ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            coroutineContext.ensureActive()
                            val read = input.read(buffer)
                            if (read == -1) break
                            downloaded += read
                            if (downloaded > release.sizeBytes) {
                                throw AppUpdateException(
                                    UpdateFailureReason.INTEGRITY_FAILED,
                                    "APK is larger than the update manifest declares",
                                )
                            }
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                            onProgress(downloaded, release.sizeBytes)
                        }
                        output.fd.sync()
                    }
                }
            }
            if (downloaded != release.sizeBytes) {
                throw AppUpdateException(UpdateFailureReason.INTEGRITY_FAILED, "APK download is incomplete")
            }
            val expectedDigest = release.sha256.hexToBytes()
            if (!MessageDigest.isEqual(digest.digest(), expectedDigest)) {
                throw AppUpdateException(UpdateFailureReason.INTEGRITY_FAILED, "APK checksum verification failed")
            }
            packageVerifier.verify(temporary, release)

            val verifiedFile = File(updateDirectory, "${release.versionCode}-${release.apkAsset}")
            if (verifiedFile.exists() && !verifiedFile.delete()) {
                throw AppUpdateException(UpdateFailureReason.DOWNLOAD_FAILED, "Unable to replace cached update")
            }
            if (!temporary.renameTo(verifiedFile)) {
                throw AppUpdateException(UpdateFailureReason.DOWNLOAD_FAILED, "Unable to finalize APK download")
            }
            VerifiedApk(release, verifiedFile)
        } catch (failure: AppUpdateException) {
            throw failure
        } catch (failure: IOException) {
            throw AppUpdateException(UpdateFailureReason.DOWNLOAD_FAILED, "Unable to download APK", failure)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun String.hexToBytes(): ByteArray =
        chunked(2).map { octet -> octet.toInt(16).toByte() }.toByteArray()

    private companion object {
        const val UPDATE_DIRECTORY = "updates"
        const val APK_CONTENT_TYPE = "application/vnd.android.package-archive"
    }
}
