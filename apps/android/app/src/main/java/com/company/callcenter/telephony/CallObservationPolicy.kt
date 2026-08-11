package com.company.callcenter.telephony

object CallObservationPolicy {
    fun classify(durationSeconds: Int): String =
        if (durationSeconds > 0) "CONNECTED" else "NOT_CONNECTED"

    fun isCollectionExpired(nowMillis: Long, deadlineMillis: Long): Boolean =
        nowMillis >= deadlineMillis
}
