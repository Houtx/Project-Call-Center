package com.company.callcenter.update

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI

class UpdateManifestParser(
    releasesBaseUrl: String,
) {
    private val releasesBaseUri = URI(releasesBaseUrl).also { uri ->
        require(uri.scheme == "https") { "Release base URL must use HTTPS" }
        require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null) {
            "Release base URL is invalid"
        }
        require(uri.path.endsWith('/')) { "Release base URL must end with /" }
    }

    fun parse(json: String): AppRelease {
        val root = try {
            JsonParser.parseString(json).asJsonObject
        } catch (failure: RuntimeException) {
            throw invalid("Update manifest is not valid JSON", failure)
        }

        val schemaVersion = root.requireLong("schemaVersion")
        if (schemaVersion != SCHEMA_VERSION) throw invalid("Unsupported update manifest schema")

        val versionCode = root.requireLong("versionCode")
        if (versionCode <= 0) throw invalid("versionCode must be positive")

        val versionName = root.requireString("versionName")
        if (versionName.length !in 1..64) throw invalid("versionName is invalid")

        val releaseTag = root.requireString("releaseTag")
        if (!SAFE_PATH_SEGMENT.matches(releaseTag)) throw invalid("releaseTag is invalid")

        val packageName = root.requireString("packageName")
        if (!PACKAGE_NAME.matches(packageName)) throw invalid("packageName is invalid")

        val apkAsset = root.requireString("apkAsset")
        if (!SAFE_APK_ASSET.matches(apkAsset)) throw invalid("apkAsset is invalid")

        val sha256 = root.requireString("sha256").lowercase()
        if (!SHA_256.matches(sha256)) throw invalid("sha256 must contain 64 hexadecimal characters")

        val sizeBytes = root.requireLong("sizeBytes")
        if (sizeBytes !in 1..MAX_APK_BYTES) throw invalid("sizeBytes is invalid")

        val downloadUri = releasesBaseUri.resolve("$releaseTag/$apkAsset")
        if (downloadUri.scheme != "https" || downloadUri.host != releasesBaseUri.host) {
            throw invalid("Resolved APK URL is not trusted")
        }

        return AppRelease(
            versionCode = versionCode,
            versionName = versionName,
            releaseTag = releaseTag,
            packageName = packageName,
            apkAsset = apkAsset,
            apkDownloadUrl = downloadUri.toASCIIString(),
            sha256 = sha256,
            sizeBytes = sizeBytes,
        )
    }

    private fun JsonObject.requireString(name: String): String {
        val value = get(name)
        if (value == null || !value.isJsonPrimitive || !value.asJsonPrimitive.isString) {
            throw invalid("$name must be a string")
        }
        return value.asString.trim().takeIf { it.isNotEmpty() }
            ?: throw invalid("$name must not be blank")
    }

    private fun JsonObject.requireLong(name: String): Long {
        val value = get(name)
        if (value == null || !value.isJsonPrimitive || !value.asJsonPrimitive.isNumber) {
            throw invalid("$name must be an integer")
        }
        return runCatching {
            value.asBigDecimal.longValueExact()
        }.getOrElse { throw invalid("$name must be an integer", it) }
    }

    private fun invalid(message: String, cause: Throwable? = null) =
        AppUpdateException(UpdateFailureReason.INVALID_METADATA, message, cause)

    private companion object {
        const val SCHEMA_VERSION = 1L
        const val MAX_APK_BYTES = 500L * 1024L * 1024L
        val SAFE_PATH_SEGMENT = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
        val SAFE_APK_ASSET = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,191}\\.apk", RegexOption.IGNORE_CASE)
        val PACKAGE_NAME = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
        val SHA_256 = Regex("[0-9a-f]{64}")
    }
}
