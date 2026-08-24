package com.company.callcenter.telephony

import android.Manifest
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import android.telephony.PhoneNumberUtils
import android.util.Log
import androidx.core.content.ContextCompat

data class MatchedCallLog(
    val id: Long,
    val startedAt: Long,
    val endedAt: Long,
    val durationSeconds: Int,
)

class CallLogReader(private val context: Context) {
    private val resolver: ContentResolver = context.contentResolver

    fun hasPermission(): Boolean = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.READ_CALL_LOG,
    ) == PackageManager.PERMISSION_GRANTED

    fun latestOutgoingId(): Long {
        if (!hasPermission()) return -1
        try {
            resolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls._ID),
                "${CallLog.Calls.TYPE} = ?",
                arrayOf(CallLog.Calls.OUTGOING_TYPE.toString()),
                "${CallLog.Calls._ID} DESC",
            )?.use { cursor ->
                if (cursor.moveToFirst()) return cursor.getLong(0)
            }
        } catch (failure: RuntimeException) {
            Log.w(LOG_TAG, "CallLog baseline unavailable: ${failure.javaClass.simpleName}")
            return -1
        }
        return 0
    }

    fun findOutgoing(phone: String, baselineId: Long, initiatedAt: Long): MatchedCallLog? {
        if (!hasPermission()) return null
        val projection = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
            CallLog.Calls.LAST_MODIFIED,
        )
        val selection = "${CallLog.Calls.TYPE} = ? AND ${CallLog.Calls._ID} > ? " +
            "AND ${CallLog.Calls.DATE} >= ? AND ${CallLog.Calls.DATE} <= ?"
        val args = arrayOf(
            CallLog.Calls.OUTGOING_TYPE.toString(),
            baselineId.toString(),
            (initiatedAt - MATCH_CLOCK_TOLERANCE_MS).toString(),
            (initiatedAt + DIAL_START_MATCH_WINDOW_MS).toString(),
        )
        try {
            resolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                selection,
                args,
                "${CallLog.Calls.DATE} ASC",
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    val candidate = cursor.getString(1) ?: continue
                    if (!PhoneNumberUtils.areSamePhoneNumber(phone, candidate, "CN")) continue
                    val startedAt = cursor.getLong(2)
                    val duration = cursor.getInt(3).coerceAtLeast(0)
                    val modifiedAt = cursor.getLong(4)
                    return MatchedCallLog(
                        id = cursor.getLong(0),
                        startedAt = startedAt,
                        endedAt = modifiedAt.coerceAtLeast(startedAt + duration * 1_000L),
                        durationSeconds = duration,
                    )
                }
            }
        } catch (failure: RuntimeException) {
            Log.w(LOG_TAG, "CallLog query unavailable: ${failure.javaClass.simpleName}")
        }
        return null
    }

    private companion object {
        const val LOG_TAG = "CallCenterCallLog"
        const val MATCH_CLOCK_TOLERANCE_MS = 10_000L
        const val DIAL_START_MATCH_WINDOW_MS = 2L * 60L * 1_000L
    }
}
