package com.company.callcenter

import android.content.Context
import androidx.room.Room
import com.company.callcenter.data.CallCenterRepository
import com.company.callcenter.data.AppModeStore
import com.company.callcenter.data.SessionStore
import com.company.callcenter.data.local.CallCenterDatabase
import com.company.callcenter.data.offline.OfflineAccessStore
import com.company.callcenter.data.offline.OfflineDatabase
import com.company.callcenter.data.offline.OfflineImportService
import com.company.callcenter.data.offline.OFFLINE_MIGRATION_1_2
import com.company.callcenter.data.offline.OfflineRepository
import com.company.callcenter.data.remote.ApiFactory
import com.company.callcenter.telephony.CallLogReader
import com.company.callcenter.telephony.SimCallManager
import com.company.callcenter.telephony.CallRecorder
import com.company.callcenter.telemetry.UsageTelemetry
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
    private val offlineDatabase = Room.databaseBuilder(
        appContext,
        OfflineDatabase::class.java,
        "call-center-offline.db",
    ).addMigrations(OFFLINE_MIGRATION_1_2).build()
    private val session = SessionStore(appContext)
    private val apiFactory = ApiFactory()
    private val callLogReader = CallLogReader(appContext)
    val appModeStore = AppModeStore(
        appContext,
        legacyDefault = if (session.configuredServerUrl != null) com.company.callcenter.data.AppMode.ONLINE else null,
    )
    val simCallManager = SimCallManager(appContext)
    val callRecorder = CallRecorder(appContext)
    val usageTelemetry = UsageTelemetry(appContext)
    val offlineImportService = OfflineImportService(appContext)

    val repository = CallCenterRepository(
        context = appContext,
        dao = database.dao(),
        apiFactory = apiFactory,
        session = session,
        callLogReader = callLogReader,
        callRecorder = callRecorder,
    )

    val offlineRepository = OfflineRepository(
        context = appContext,
        database = offlineDatabase,
        access = OfflineAccessStore(appContext),
        callLogReader = callLogReader,
        appModeStore = appModeStore,
    )
}
