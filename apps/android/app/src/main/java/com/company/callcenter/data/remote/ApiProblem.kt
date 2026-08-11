package com.company.callcenter.data.remote

import com.google.gson.JsonParser
import retrofit2.HttpException

class ApiRequestException(
    val statusCode: Int,
    val problemCode: String?,
    message: String,
    cause: Throwable,
) : Exception(message, cause)

internal object ApiProblemParser {
    fun from(error: HttpException): ApiRequestException {
        val problem = parse(readLimitedBody(error))
        return ApiRequestException(
            statusCode = error.code(),
            problemCode = problem.code,
            message = userMessage(error.code(), problem),
            cause = error,
        )
    }

    internal fun parse(body: String?): ApiProblem {
        if (body.isNullOrBlank()) return ApiProblem()
        return runCatching {
            val root = JsonParser.parseString(body).asJsonObject
            ApiProblem(
                code = root.get("code")
                    ?.takeIf { it.isJsonPrimitive }
                    ?.asString
                    ?.trim()
                    ?.takeIf(PROBLEM_CODE::matches),
                detail = root.get("detail")
                    ?.takeIf { it.isJsonPrimitive }
                    ?.asString
                    ?.trim()
                    ?.takeIf { it.length in 1..MAX_DETAIL_CHARS },
            )
        }.getOrDefault(ApiProblem())
    }

    internal fun userMessage(statusCode: Int, problem: ApiProblem): String = problem.detail
        ?.takeUnless { it == GENERIC_SERVER_DETAIL }
        ?: problem.code?.let(KNOWN_MESSAGES::get)
        ?: "服务器拒绝请求（HTTP $statusCode）"

    private fun readLimitedBody(error: HttpException): String? {
        val body = error.response()?.errorBody() ?: return null
        if (body.contentLength() > MAX_ERROR_BODY_CHARS) return null
        return runCatching {
            body.charStream().use { reader ->
                val result = StringBuilder()
                val chunk = CharArray(1024)
                while (result.length <= MAX_ERROR_BODY_CHARS) {
                    val remaining = (MAX_ERROR_BODY_CHARS + 1 - result.length).coerceAtMost(chunk.size)
                    val count = reader.read(chunk, 0, remaining)
                    if (count < 0) break
                    result.append(chunk, 0, count)
                }
                result.takeIf { it.length <= MAX_ERROR_BODY_CHARS }?.toString()
            }
        }.getOrNull()
    }

    private const val GENERIC_SERVER_DETAIL = "服务器无法完成请求"
    private const val MAX_ERROR_BODY_CHARS = 8 * 1024
    private const val MAX_DETAIL_CHARS = 500
    private val PROBLEM_CODE = Regex("[A-Z][A-Z0-9_]{0,63}")
    private val KNOWN_MESSAGES = mapOf(
        "AGENT_NOT_ACTIVE" to "坐席账号已停用",
        "DEVICE_NOT_ALLOWLISTED" to "当前机型未通过兼容性验证",
        "INSTALL_ALREADY_BOUND" to "本机已经绑定其他坐席",
        "INVALID_CREDENTIALS" to "用户名或密码错误",
        "DEVICE_NOT_ACTIVE" to "设备未绑定或已被撤销",
        "SESSION_REPLACED" to "账号已在其他手机登录，当前设备已下线",
        "APP_UPDATE_REQUIRED" to "当前 APP 版本已停用，请先完成更新",
        "PHONE_PERMISSIONS_REQUIRED" to "请授予拨打电话和读取通话记录权限",
    )
}

internal data class ApiProblem(
    val code: String? = null,
    val detail: String? = null,
)
