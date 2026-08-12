package com.company.callcenter

import android.content.Context
import androidx.room.Room
import com.company.callcenter.data.CallCenterRepository
import com.company.callcenter.data.SessionStore
import com.company.callcenter.data.local.CallCenterDatabase
import com.company.callcenter.data.remote.ApiFactory
import com.company.callcenter.telephony.CallLogReader
import com.company.callcenter.telephony.SimCallManager
import com.company.callcenter.telephony.CallRecorder
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

class AppContainer(context: Context) {
    private val appContext = context.applicationContext
    private val database = Room.databaseBuilder(
        appContext,
        CallCenterDatabase::class.java,
        "call-center-agent.db",
    ).addMigrations(object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE pending_call_attempts ADD COLUMN recordingRequested INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE pending_call_attempts ADD COLUMN recordingPath TEXT")
            db.execSQL("ALTER TABLE pending_call_attempts ADD COLUMN recordingStartedAt INTEGER")
        }
    }).build()
    private val session = SessionStore(appContext)
    private val apiFactory = ApiFactory()
    val simCallManager = SimCallManager(appContext)
    val callRecorder = CallRecorder(appContext)

    val repository = CallCenterRepository(
        context = appContext,
        dao = database.dao(),
        apiFactory = apiFactory,
        session = session,
        callLogReader = CallLogReader(appContext),
        callRecorder = callRecorder,
    )
}
