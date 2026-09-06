package com.company.callcenter.announcement

import android.content.Context
import com.company.callcenter.BuildConfig
import com.google.gson.JsonParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URI
import java.time.Instant
import java.util.concurrent.TimeUnit

internal data class AppAnnouncement(
    val id: Long,
    val title: String,
    val content: String,
    val publishedAt: String,
)

internal object AnnouncementEndpointPolicy {
    fun fromTelemetryEndpoint(telemetryEndpoint: String): String? {
        val source = runCatching { URI(telemetryEndpoint.trim()) }.getOrNull() ?: return null
        if (
            !source.scheme.equals("https", ignoreCase = true) ||
            source.host.isNullOrBlank() ||
            source.userInfo != null ||
            source.fragment != null ||
            source.port != -1 && source.port !in 1..65_535
        ) {
            return null
        }
        return URI(
            "https",
            null,
            source.host,
            source.port,
            ANNOUNCEMENT_PATH,
            null,
            null,
        ).toASCIIString()
    }

    private const val ANNOUNCEMENT_PATH = "/api/app/v1/announcement/latest"
}

internal object AppAnnouncementParser {
    fun parse(json: String): AppAnnouncement {
        val root = try {
            JsonParser.parseString(json).asJsonObject
        } catch (failure: RuntimeException) {
            throw IOException("公告内容格式无效", failure)
        }
        val id = root.get("id")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }
            ?.let { runCatching { it.asBigDecimal.longValueExact() }.getOrNull() }
            ?.takeIf { it > 0 }
            ?: throw IOException("公告编号无效")
        val title = root.requiredText("title", 80)
        val content = root.requiredText("content", 4_000)
        val publishedAt = root.requiredText("publishedAt", 64)
        runCatching { Instant.parse(publishedAt) }
            .getOrElse { throw IOException("公告发布时间无效", it) }
        return AppAnnouncement(id, title, content, publishedAt)
    }

    private fun com.google.gson.JsonObject.requiredText(name: String, maximumLength: Int): String {
        val value = get(name)
        if (value == null || !value.isJsonPrimitive || !value.asJsonPrimitive.isString) {
            throw IOException("公告字段 $name 无效")
        }
        return value.asString.trim().takeIf { it.isNotEmpty() && it.length <= maximumLength }
            ?: throw IOException("公告字段 $name 无效")
    }
}

internal class AppAnnouncementManager(
    context: Context,
    telemetryEndpoint: String = BuildConfig.TELEMETRY_URL,
    private val client: OkHttpClient = defaultClient(),
) {
    private val endpoint = AnnouncementEndpointPolicy.fromTelemetryEndpoint(telemetryEndpoint)
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    suspend fun fetchUnread(): AppAnnouncement? {
        val url = endpoint ?: return null
        return try {
            withContext(Dispatchers.IO) {
                val request = Request.Builder()
                    .url(url)
                    .header("Accept", "application/json")
                    .header("Cache-Control", "no-cache")
                    .header("User-Agent", "CallCenterAgent/${BuildConfig.VERSION_NAME} Android")
                    .build()
                client.newCall(request).execute().use { response ->
                    if (response.code == 204) return@withContext null
                    if (!response.isSuccessful) throw IOException("公告接口返回 HTTP ${response.code}")
                    val body = response.body?.string() ?: throw IOException("公告内容为空")
                    val announcement = AppAnnouncementParser.parse(body)
                    if (preferences.getLong(LAST_READ_ID_KEY, 0L) == announcement.id) null else announcement
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        }
    }

    fun markRead(announcement: AppAnnouncement): Boolean =
        preferences.edit().putLong(LAST_READ_ID_KEY, announcement.id).commit()

    private companion object {
        const val PREFERENCES_NAME = "app_announcements"
        const val LAST_READ_ID_KEY = "last_read_announcement_id"

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .cache(null)
            .retryOnConnectionFailure(false)
            .callTimeout(8, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(false)
            .build()
    }
}
