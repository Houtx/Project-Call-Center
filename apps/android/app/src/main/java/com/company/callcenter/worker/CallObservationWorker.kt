package com.company.callcenter.worker

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.company.callcenter.BuildConfig
import com.company.callcenter.CallCenterApplication
import com.company.callcenter.update.AppUpdateManager
import com.company.callcenter.update.UpdateCheckResult
import com.company.callcenter.update.UpdatePolicy
import kotlinx.coroutines.CancellationException

class CallObservationWorker(
    appContext: Context,
    workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
    override suspend fun doWork(): Result {
        return try {
            val updateCheckDisabled = UpdatePolicy.isCheckDisabled(
                BuildConfig.DEBUG,
                BuildConfig.UPDATE_MANIFEST_URL,
            )
            if (!updateCheckDisabled &&
                AppUpdateManager(applicationContext).checkForUpdate() != UpdateCheckResult.UpToDate
            ) {
                return Result.success()
            }
            val repository = (applicationContext as CallCenterApplication).container.repository
            if (!repository.isLoggedIn) return Result.success()
            repository.refreshSession()
            repository.reconcilePending()
            repository.heartbeat()
            Result.success()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            Result.retry()
        }
    }
}
