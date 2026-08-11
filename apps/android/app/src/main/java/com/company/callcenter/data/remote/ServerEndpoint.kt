package com.company.callcenter.data.remote

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerEndpoint {
    fun normalize(rawAddress: String, allowCleartext: Boolean): String {
        val trimmed = rawAddress.trim()
        require(trimmed.isNotEmpty()) { "请输入服务器地址" }

        val address = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val parsed = address.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("服务器地址格式不正确")

        require(parsed.scheme == "https" || allowCleartext && parsed.scheme == "http") {
            if (allowCleartext) "服务器地址必须使用 HTTP 或 HTTPS" else "服务器地址必须使用 HTTPS"
        }
        require(parsed.username.isEmpty() && parsed.password.isEmpty()) {
            "服务器地址不能包含用户名或密码"
        }
        require(parsed.query == null && parsed.fragment == null) {
            "服务器地址不能包含查询参数或页面锚点"
        }

        val path = parsed.encodedPath.trimEnd('/')
        val apiPath = if (path.endsWith(API_PATH)) "$path/" else "${path.ifEmpty { "" }}$API_PATH/"
        return parsed.newBuilder()
            .encodedPath(apiPath)
            .build()
            .toString()
    }

    private const val API_PATH = "/api/v1"
}
