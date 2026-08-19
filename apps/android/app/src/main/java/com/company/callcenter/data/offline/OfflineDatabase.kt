package com.company.callcenter.data.offline

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [
        OfflineContactEntity::class,
        OfflinePendingCallEntity::class,
        OfflineCallHistoryEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class OfflineDatabase : RoomDatabase() {
    abstract fun dao(): OfflineDao
}
