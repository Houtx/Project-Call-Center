package com.company.callcenter

import android.app.Application
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.company.callcenter.worker.CallObservationWorker
import com.company.callcenter.worker.OfflineCallObservationWorker
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class CallCenterApplication : Application() {
    val container by lazy { AppContainer(this) }
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        val request = PeriodicWorkRequestBuilder<CallObservationWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "call-observation-sync",
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
        val offlineRequest = PeriodicWorkRequestBuilder<OfflineCallObservationWorker>(15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "offline-call-observation",
            ExistingPeriodicWorkPolicy.KEEP,
            offlineRequest,
        )
        container.usageTelemetry.start(applicationScope, container.appModeStore.mode)
    }
}
