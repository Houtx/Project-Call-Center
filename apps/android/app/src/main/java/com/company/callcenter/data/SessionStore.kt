package com.company.callcenter.data

import android.content.Context
import com.company.callcenter.security.SecureValueStore
import java.util.UUID

class SessionStore(context: Context) {
    private val secure = SecureValueStore(context)
    private val publicPreferences = context.getSharedPreferences("app_settings", Context.MODE_PRIVATE)

    val installId: String
        get() = publicPreferences.getString("install_id", null) ?: UUID.randomUUID().toString().also {
            publicPreferences.edit().putString("install_id", it).apply()
        }

    val configuredServerUrl: String?
        get() = publicPreferences.getString(SERVER_URL_KEY, null)?.takeIf(String::isNotBlank)

    val lastServerUrl: String?
        get() = publicPreferences.getString(LAST_SERVER_URL_KEY, null)?.takeIf(String::isNotBlank)

    var accessToken: String?
        get() = secure.get("access_token")
        set(value) = secure.put("access_token", value)

    var refreshToken: String?
        get() = secure.get("refresh_token")
        set(value) = secure.put("refresh_token", value)

    var accessExpiresAt: Long
        get() = secure.get("access_expires_at")?.toLongOrNull() ?: 0L
        set(value) = secure.put("access_expires_at", value.toString())

    var deviceId: String?
        get() = secure.get("device_id")
        set(value) = secure.put("device_id", value)

    var syncCursor: String
        get() = secure.get("sync_cursor") ?: "0"
        set(value) = secure.put("sync_cursor", value)

    var displayName: String?
        get() = secure.get("display_name")
        set(value) = secure.put("display_name", value)

    fun encryptPhone(phone: String): String = secure.encrypt(phone)
    fun decryptPhone(phone: String): String = secure.decrypt(phone)

    fun saveServerConfiguration(url: String) {
        publicPreferences.edit()
            .putString(SERVER_URL_KEY, url)
            .putString(LAST_SERVER_URL_KEY, url)
            .apply()
    }

    fun invalidateServerConfiguration(failedUrl: String? = configuredServerUrl) {
        publicPreferences.edit()
            .apply {
                failedUrl?.takeIf(String::isNotBlank)?.let { putString(LAST_SERVER_URL_KEY, it) }
            }
            .apply()
        clearAuthentication()
    }

    fun clearForServerChange() {
        clearAuthentication()
        deviceId = null
    }

    fun clearAuthentication() = secure.clearSession()

    fun clear() = clearAuthentication()

    private companion object {
        const val SERVER_URL_KEY = "server_url"
        const val LAST_SERVER_URL_KEY = "last_server_url"
    }
}
