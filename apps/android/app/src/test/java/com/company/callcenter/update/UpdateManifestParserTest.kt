package com.company.callcenter.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateManifestParserTest {
    private val parser = UpdateManifestParser(
        "https://github.com/example-org/call-center-agent-releases/releases/download/",
    )

    @Test
    fun `parses a valid release manifest and pins the APK to its tag`() {
        val release = parser.parse(validManifest(versionCode = 12))

        assertEquals(12L, release.versionCode)
        assertEquals("1.2.0", release.versionName)
        assertEquals(
            "https://github.com/example-org/call-center-agent-releases/releases/download/v1.2.0/call-center-agent-v1.2.0.apk",
            release.apkDownloadUrl,
        )
        assertEquals("a".repeat(64), release.sha256)
        assertEquals(1_234_567L, release.sizeBytes)
    }

    @Test
    fun `rejects path traversal in APK asset`() {
        val manifest = validManifest().replace(
            "call-center-agent-v1.2.0.apk",
            "../call-center-agent-v1.2.0.apk",
        )

        val error = runCatching { parser.parse(manifest) }.exceptionOrNull()

        assertTrue(error is AppUpdateException)
        assertEquals(UpdateFailureReason.INVALID_METADATA, (error as AppUpdateException).reason)
    }

    @Test
    fun `rejects invalid checksum and fractional version code`() {
        val invalidChecksum = validManifest().replace("a".repeat(64), "abc")
        val fractionalVersion = validManifest().replace("\"versionCode\": 2", "\"versionCode\": 2.5")

        assertTrue(runCatching { parser.parse(invalidChecksum) }.exceptionOrNull() is AppUpdateException)
        assertTrue(runCatching { parser.parse(fractionalVersion) }.exceptionOrNull() is AppUpdateException)
    }

    @Test
    fun `only a greater version code requires the mandatory update`() {
        assertTrue(UpdatePolicy.requiresUpdate(currentVersionCode = 4, releaseVersionCode = 5))
        assertFalse(UpdatePolicy.requiresUpdate(currentVersionCode = 4, releaseVersionCode = 4))
        assertFalse(UpdatePolicy.requiresUpdate(currentVersionCode = 4, releaseVersionCode = 3))
    }

    private fun validManifest(versionCode: Long = 2) = """
        {
          "schemaVersion": 1,
          "versionCode": $versionCode,
          "versionName": "1.2.0",
          "releaseTag": "v1.2.0",
          "packageName": "com.company.callcenter",
          "apkAsset": "call-center-agent-v1.2.0.apk",
          "sha256": "${"a".repeat(64)}",
          "sizeBytes": 1234567
        }
    """.trimIndent()
}
