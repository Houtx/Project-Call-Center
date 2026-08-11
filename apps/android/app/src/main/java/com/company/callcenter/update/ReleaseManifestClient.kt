package com.company.callcenter.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI

internal class ReleaseManifestClient(
    private val httpClient: OkHttpClient,
    private val manifestUrl: String,
    private val parser: UpdateManifestParser,
    private val userAgent: String,
) {
    init {
        val uri = URI(manifestUrl)
        require(uri.scheme == "https" && uri.host != null && uri.userInfo == null) {
            "Update manifest URL must be a valid HTTPS URL"
        }
    }

    suspend fun fetch(): AppRelease = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(manifestUrl)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache")
            .header("User-Agent", userAgent)
            .build()
        try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw AppUpdateException(
                        UpdateFailureReason.NETWORK,
                        "Update check failed with HTTP ${response.code}",
                    )
                }
                val body = response.body
                    ?: throw AppUpdateException(UpdateFailureReason.NETWORK, "Update response is empty")
                if (body.contentLength() > MAX_MANIFEST_BYTES) {
                    throw AppUpdateException(UpdateFailureReason.INVALID_METADATA, "Update manifest is too large")
                }
                parser.parse(body.byteStream().use(::readLimitedUtf8))
            }
        } catch (failure: AppUpdateException) {
            throw failure
        } catch (failure: IOException) {
            throw AppUpdateException(UpdateFailureReason.NETWORK, "Unable to check for updates", failure)
        }
    }

    private fun readLimitedUtf8(input: java.io.InputStream): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read == -1) break
            total += read
            if (total > MAX_MANIFEST_BYTES) {
                throw AppUpdateException(UpdateFailureReason.INVALID_METADATA, "Update manifest is too large")
            }
            output.write(buffer, 0, read)
        }
        return output.toString(Charsets.UTF_8.name())
    }

    private companion object {
        const val MAX_MANIFEST_BYTES = 64 * 1024
    }
}
