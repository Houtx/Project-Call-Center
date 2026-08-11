package com.company.callcenter

import android.content.Context
import androidx.room.Room
import com.company.callcenter.data.CallCenterRepository
import com.company.callcenter.data.SessionStore
import com.company.callcenter.data.local.CallCenterDatabase
import com.company.callcenter.data.remote.ApiFactory
import com.company.callcenter.telephony.CallLogReader
import com.company.callcenter.telephony.SimCallManager

class AppContainer(context: Context) {
    private val appContext = context.applicationContext
    private val database = Room.databaseBuilder(
        appContext,
        CallCenterDatabase::class.java,
        "call-center-agent.db",
    ).build()
    private val session = SessionStore(appContext)
    private val apiFactory = ApiFactory()
    val simCallManager = SimCallManager(appContext)

    val repository = CallCenterRepository(
        context = appContext,
        dao = database.dao(),
        apiFactory = apiFactory,
        session = session,
        callLogReader = CallLogReader(appContext),
    )
}
