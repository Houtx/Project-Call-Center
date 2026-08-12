package com.company.callcenter.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [AssignedCustomerEntity::class, PendingCallEntity::class, CallHistoryEntity::class],
    version = 2,
    exportSchema = true,
)
abstract class CallCenterDatabase : RoomDatabase() {
    abstract fun dao(): CallCenterDao
}
