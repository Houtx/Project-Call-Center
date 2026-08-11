package com.company.callcenter

import android.app.Application
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.company.callcenter.worker.CallObservationWorker
import java.util.concurrent.TimeUnit

class CallCenterApplication : Application() {
    val container by lazy { AppContainer(this) }

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
    }
}
