package com.company.callcenter.telephony

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File
import java.util.UUID

data class RecordingFile(val file: File, val startedAt: Long)

class CallRecorder(context: Context) {
    private val appContext = context.applicationContext
    private val directory = File(appContext.filesDir, "recordings")
    private var recorder: MediaRecorder? = null
    private var current: RecordingFile? = null

    @get:Synchronized
    val isActive: Boolean
        get() = current != null

    @Synchronized
    fun start(attemptId: String): RecordingFile {
        check(current == null) { "已有录音正在采集" }
        directory.mkdirs()
        val file = File(directory, "$attemptId-${UUID.randomUUID()}.m4a")
        val startedAt = System.currentTimeMillis()
        val instance = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(appContext) else MediaRecorder()
        try {
            instance.setAudioSource(MediaRecorder.AudioSource.VOICE_CALL)
            instance.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            instance.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            instance.setAudioEncodingBitRate(24_000)
            instance.setAudioSamplingRate(16_000)
            instance.setAudioChannels(1)
            instance.setOutputFile(file.absolutePath)
            instance.prepare()
            instance.start()
        } catch (failure: Throwable) {
            runCatching { instance.reset() }
            runCatching { instance.release() }
            file.delete()
            throw IllegalStateException("设备不允许采集蜂窝通话音频", failure)
        }
        recorder = instance
        return RecordingFile(file, startedAt).also { current = it }
    }

    @Synchronized
    fun stop(): RecordingFile? {
        val file = current ?: return null
        val instance = recorder
        recorder = null
        current = null
        var stoppedCleanly = true
        if (instance != null) {
            stoppedCleanly = runCatching { instance.stop() }.isSuccess
            runCatching { instance.reset() }
            runCatching { instance.release() }
        }
        if (!stoppedCleanly || !file.file.exists() || file.file.length() <= 0L) {
            file.file.delete()
            return null
        }
        return file
    }

    @Synchronized
    fun discard() {
        stop()?.file?.delete()
    }
}
