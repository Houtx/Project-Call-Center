package com.company.callcenter.telephony

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.company.callcenter.CallCenterApplication
import com.company.callcenter.R

class CallRecordingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        (application as CallCenterApplication).container.callRecorder.stop()
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val recorder = (application as CallCenterApplication).container.callRecorder
        when (intent?.action) {
            ACTION_START -> {
                val attemptId = intent.getStringExtra(EXTRA_ATTEMPT_ID) ?: return START_NOT_STICKY
                createChannel()
                val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle(getString(R.string.recording_notification_title))
                    .setOngoing(true)
                    .setSilent(true)
                    .build()
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification,
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
                )
                if (!recorder.isActive) {
                    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
            ACTION_STOP -> {
                recorder.stop()
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.recording_channel_name), NotificationManager.IMPORTANCE_LOW),
        )
    }

    companion object {
        private const val CHANNEL_ID = "call_recording"
        private const val NOTIFICATION_ID = 2001
        private const val ACTION_START = "com.company.callcenter.recording.START"
        private const val ACTION_STOP = "com.company.callcenter.recording.STOP"
        private const val EXTRA_ATTEMPT_ID = "attemptId"

        fun start(context: Context, attemptId: String) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, CallRecordingService::class.java)
                    .setAction(ACTION_START)
                    .putExtra(EXTRA_ATTEMPT_ID, attemptId),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallRecordingService::class.java))
        }
    }
}
