package com.company.callcenter.data.offline

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfflineDatabaseInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private var database: OfflineDatabase? = null

    @get:Rule
    val migrationHelper = MigrationTestHelper(
        instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation(),
        databaseClass = OfflineDatabase::class.java,
        specs = emptyList(),
        openFactory = FrameworkSQLiteOpenHelperFactory(),
    )

    @After
    fun closeDatabase() {
        database?.close()
        context.deleteDatabase(MIGRATION_DATABASE)
    }

    @Test
    fun migrationFromOnePreservesContactsAndAddsImportHistoryTables() {
        migrationHelper.createDatabase(MIGRATION_DATABASE, 1).apply {
            execSQL(
                """
                INSERT INTO offline_contacts (
                    id, encryptedPhone, phoneHash, phoneMasked, encryptedName, importedAt, state,
                    attemptCount, lastResult, lastAttemptAt, completedAt, queueOrder
                ) VALUES ('old', 'encrypted', 'hash', '138****8000', NULL, 1, 'READY', 0, NULL, NULL, NULL, 1)
                """.trimIndent(),
            )
            close()
        }

        val migrated = migrationHelper.runMigrationsAndValidate(
            MIGRATION_DATABASE,
            2,
            true,
            OFFLINE_MIGRATION_1_2,
        )
        migrated.query("SELECT id, importBatchId FROM offline_contacts").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("old", cursor.getString(0))
            assertTrue(cursor.isNull(1))
        }
        migrated.close()
    }

    @Test
    fun taskQueriesCountAllButReturnOnlyFirstHundredAndRefill() = runTest {
        val dao = createDatabase().dao()
        dao.insertContacts((1..101).map { contact(it) })

        assertEquals(101, dao.observePendingContactCount().first())
        assertEquals((1..100).map(Int::toString), dao.observePendingContacts(100).first().map { it.id })

        dao.settleContact("1", "CONNECTED", "CONNECTED", 10, 10, 102)
        val refilled = dao.observePendingContacts(100).first()
        assertEquals(100, refilled.size)
        assertEquals("2", refilled.first().id)
        assertEquals("101", refilled.last().id)
    }

    @Test
    fun missedQueryUsesDateBoundariesAndQueueOrder() = runTest {
        val dao = createDatabase().dao()
        dao.insertContacts(
            listOf(
                contact(1, "NOT_CONNECTED", 100),
                contact(2, "NOT_CONNECTED", 200),
                contact(3, "CONNECTED", 200),
            ),
        )

        val rows = dao.observeNotConnectedContacts(100, 200, 100).first()
        assertEquals(listOf("1"), rows.map { it.id })
        assertEquals(1, dao.observeNotConnectedContactCount(100, 200).first())
    }

    @Test
    fun importBatchPendingCallCanBeDetectedBeforeCascadeDeletion() = runTest {
        val dao = createDatabase().dao()
        dao.insertImportBatch(importBatch("batch"))
        dao.insertContacts(listOf(contact(1, importBatchId = "batch")))
        assertFalse(dao.hasPendingCallForImportBatch("batch"))

        dao.insertPendingCall(
            OfflinePendingCallEntity(
                attemptId = "attempt",
                contactId = "1",
                encryptedPhone = "encrypted",
                callLogBaselineId = 0,
                initiatedAt = 1,
                deadlineAt = 2,
                previousState = "READY",
                previousCompletedAt = null,
                previousQueueOrder = 1,
            ),
        )
        assertTrue(dao.hasPendingCallForImportBatch("batch"))
    }

    private fun createDatabase(): OfflineDatabase = Room.inMemoryDatabaseBuilder(context, OfflineDatabase::class.java)
        .allowMainThreadQueries()
        .build()
        .also { database = it }

    private fun contact(
        number: Int,
        result: String? = null,
        attemptedAt: Long? = null,
        importBatchId: String? = null,
    ) = OfflineContactEntity(
        id = number.toString(),
        encryptedPhone = "encrypted-$number",
        phoneHash = "hash-$number",
        phoneMasked = "138****8000",
        encryptedName = null,
        importedAt = 1,
        state = if (result == null) "READY" else "RETRY",
        attemptCount = if (result == null) 0 else 1,
        lastResult = result,
        lastAttemptAt = attemptedAt,
        completedAt = null,
        queueOrder = number.toLong(),
        importBatchId = importBatchId,
    )

    private fun importBatch(id: String) = OfflineImportBatchEntity(
        id = id,
        displayName = "test.xlsx",
        source = "SPREADSHEET",
        sheetName = "Sheet1",
        columnLetter = "A",
        requestedStartRow = null,
        requestedEndRow = null,
        skipHeader = true,
        createdAt = 1,
        addedCount = 1,
        duplicateCount = 0,
        invalidCount = 0,
    )

    private companion object {
        const val MIGRATION_DATABASE = "offline-migration-test"
    }
}
