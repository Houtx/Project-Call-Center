package com.company.callcenter.data.offline

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        OfflineContactEntity::class,
        OfflinePendingCallEntity::class,
        OfflineCallHistoryEntity::class,
        OfflineImportBatchEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
abstract class OfflineDatabase : RoomDatabase() {
    abstract fun dao(): OfflineDao
}

val OFFLINE_MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE offline_contacts ADD COLUMN importBatchId TEXT")
        db.execSQL("CREATE INDEX IF NOT EXISTS index_offline_contacts_queueOrder ON offline_contacts(queueOrder)")
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS index_offline_contacts_lastResult_queueOrder " +
                "ON offline_contacts(lastResult, queueOrder)",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS index_offline_contacts_importBatchId ON offline_contacts(importBatchId)")
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS offline_import_batches (
                id TEXT NOT NULL PRIMARY KEY,
                displayName TEXT NOT NULL,
                source TEXT NOT NULL,
                sheetName TEXT,
                columnLetter TEXT,
                requestedStartRow INTEGER,
                requestedEndRow INTEGER,
                skipHeader INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                addedCount INTEGER NOT NULL,
                duplicateCount INTEGER NOT NULL,
                invalidCount INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS index_offline_import_batches_createdAt " +
                "ON offline_import_batches(createdAt)",
        )
    }
}
