package com.company.callcenter.data.remote

import com.company.callcenter.BuildConfig
import com.company.callcenter.data.ServerVerificationException
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.GET
import java.util.concurrent.TimeUnit

class ApiFactory {
    @Volatile
    private var cachedApi: CachedApi? = null

    fun api(serverUrl: String, accessToken: String?): CallCenterApi {
        cachedApi?.takeIf { it.serverUrl == serverUrl && it.accessToken == accessToken }
            ?.let { return it.api }
        return synchronized(this) {
            cachedApi?.takeIf { it.serverUrl == serverUrl && it.accessToken == accessToken }
                ?.api ?: buildApi(serverUrl, accessToken).also { api ->
                cachedApi = CachedApi(serverUrl, accessToken, api)
            }
        }
    }

    suspend fun verifyServer(rawAddress: String): String {
        val serverUrl = ServerEndpoint.normalize(rawAddress, allowCleartext = BuildConfig.DEBUG)
        val response = Retrofit.Builder()
            .baseUrl(serverUrl)
            .client(buildClient(accessToken = null, timeoutSeconds = 8))
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ServerProbeApi::class.java)
            .health()
        if (response.status != "ok" || response.database != "up") {
            throw ServerVerificationException("该地址不是可用的坐席外呼服务器")
        }
        return serverUrl
    }

    fun invalidateCache() {
        synchronized(this) {
            cachedApi = null
        }
    }

    private fun buildApi(serverUrl: String, accessToken: String?): CallCenterApi = Retrofit.Builder()
        .baseUrl(serverUrl)
        .client(buildClient(accessToken = accessToken, timeoutSeconds = 15))
        .addConverterFactory(GsonConverterFactory.create())
        .build()
        .create(CallCenterApi::class.java)

    private fun buildClient(accessToken: String?, timeoutSeconds: Long): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC else HttpLoggingInterceptor.Level.NONE
            redactHeader("Authorization")
        }
        return OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request().newBuilder()
                    .header("Accept", "application/json, application/problem+json")
                    .header("X-Request-ID", java.util.UUID.randomUUID().toString())
                    .apply {
                        accessToken?.let { header("Authorization", "Bearer $it") }
                    }
                    .build()
                chain.proceed(request)
            }
            .addInterceptor(logging)
            .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    private data class CachedApi(
        val serverUrl: String,
        val accessToken: String?,
        val api: CallCenterApi,
    )
}

private interface ServerProbeApi {
    @GET("health")
    suspend fun health(): ServerHealthResponse
}

private data class ServerHealthResponse(
    val status: String?,
    val database: String?,
)
