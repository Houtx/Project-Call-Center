package com.company.callcenter.data

enum class ServerConnectionStatus {
    NOT_CONFIGURED,
    UNVERIFIED,
    VERIFYING,
    READY,
    INVALID,
}

data class ServerConnectionState(
    val status: ServerConnectionStatus,
    val configuredUrl: String? = null,
    val suggestedUrl: String? = configuredUrl,
    val error: String? = null,
) {
    val requiresConfiguration: Boolean
        get() = status != ServerConnectionStatus.READY
}

class ServerConfigurationRequiredException : IllegalStateException("请先配置并验证服务器地址")

class ServerVerificationException(message: String, cause: Throwable? = null) :
    IllegalStateException(message, cause)

class PendingCallsBlockServerChangeException(
    val pendingCount: Int,
    val previousServerUrl: String,
) : IllegalStateException("当前有 $pendingCount 条通话记录待采集，请恢复原服务器并完成同步后再切换")
