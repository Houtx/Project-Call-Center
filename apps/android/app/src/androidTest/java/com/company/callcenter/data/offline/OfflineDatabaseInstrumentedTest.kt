package com.company.callcenter.data.offline

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.company.callcenter.data.AppMode
import com.company.callcenter.data.AppModeStore
import com.company.callcenter.telephony.CallLogReader
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
    fun allTaskQueryFiltersByImportDateStatusAndPhoneWithoutLoadingEveryRow() = runTest {
        val dao = createDatabase().dao()
        dao.insertContacts(
            listOf(
                contact(1, importedAt = 100, phoneHash = "full-phone", phoneMasked = "138****8000"),
                contact(2, result = "CONNECTED", attemptedAt = 200, importedAt = 200, phoneMasked = "139****9000"),
                contact(3, result = "NOT_CONNECTED", attemptedAt = 300, importedAt = 300),
            ),
        )

        assertEquals(
            listOf("1"),
            dao.observeAllContacts("full-phone", null, null, null, null, "ALL", 100).first().map { it.id },
        )
        assertEquals(
            listOf("2"),
            dao.observeAllContacts(null, "9000", null, 150, 250, "CONNECTED", 100).first().map { it.id },
        )
        assertEquals(1, dao.observeAllContactCount(null, null, null, 250, null, "NOT_CONNECTED").first())
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

    @Test
    fun deletingImportBatchRemovesOnlyItsContactsAndDoesNotCreateHistoryRows() = runTest {
        val dao = createDatabase().dao()
        dao.insertImportBatch(importBatch("first"))
        dao.insertImportBatch(importBatch("second"))
        dao.insertContacts(
            listOf(
                contact(1, importBatchId = "first"),
                contact(2, importBatchId = "first"),
                contact(3, importBatchId = "second"),
            ),
        )

        assertEquals(2, dao.deleteImportBatchAndContacts("first"))
        assertEquals(listOf("second"), dao.observeImportBatches().first().map { it.id })
        assertEquals(listOf("3"), dao.observeAllContacts(null, null, null, null, null, "ALL", 100).first().map { it.id })
        assertEquals(
            listOf("3"),
            dao.observeAllContacts(null, null, "second", null, null, "ALL", 100).first().map { it.id },
        )
    }

    @Test
    fun forceRecoverySettlesUnknownAndAllowsAnotherAttempt() = runTest {
        val database = createDatabase()
        val dao = database.dao()
        val access = OfflineAccessStore(context)
        access.clearPassword()
        val appMode = AppModeStore(context, AppMode.OFFLINE).also { it.select(AppMode.OFFLINE) }
        val repository = OfflineRepository(
            context = context,
            database = database,
            access = access,
            callLogReader = CallLogReader(context),
            appModeStore = appMode,
            clock = { 1_000L },
        )
        repository.createPassword("test-password")
        try {
            dao.insertContacts(listOf(contact(1).copy(state = "COLLECTING", attemptCount = 1)))
            val pending = OfflinePendingCallEntity(
                attemptId = "attempt-1",
                contactId = "1",
                encryptedPhone = access.encrypt("13800138000"),
                callLogBaselineId = Long.MAX_VALUE,
                initiatedAt = 900L,
                deadlineAt = Long.MAX_VALUE,
                previousState = "READY",
                previousCompletedAt = null,
                previousQueueOrder = 1L,
            )
            dao.insertPendingCall(pending)

            val result = repository.forceRecoverPendingCalls()

            assertEquals(1, result.recoveredCount)
            assertEquals(0, result.remainingCount)
            assertFalse(dao.hasPendingCall())
            assertEquals("UNKNOWN", dao.observeHistory().first().single().result)
            assertEquals("RETRY", dao.contact("1")?.state)
            assertTrue(
                dao.beginAttempt(
                    pending.copy(attemptId = "attempt-2", initiatedAt = 1_100L),
                    queueOrder = 3L,
                    maxAttempts = 2,
                ),
            )
        } finally {
            access.clearPassword()
        }
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
        importedAt: Long = 1,
        phoneHash: String = "hash-$number",
        phoneMasked: String = "138****8000",
    ) = OfflineContactEntity(
        id = number.toString(),
        encryptedPhone = "encrypted-$number",
        phoneHash = phoneHash,
        phoneMasked = phoneMasked,
        encryptedName = null,
        importedAt = importedAt,
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
