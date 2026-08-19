package com.company.callcenter.worker

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.company.callcenter.CallCenterApplication
import com.company.callcenter.data.AppMode
import kotlinx.coroutines.CancellationException

class OfflineCallObservationWorker(
    appContext: Context,
    workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
    override suspend fun doWork(): Result {
        return try {
            val container = (applicationContext as CallCenterApplication).container
            if (container.appModeStore.mode.value != AppMode.OFFLINE) return Result.success()
            val repository = container.offlineRepository
            repository.reconcilePending()
            Result.success()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            Result.retry()
        }
    }
}
