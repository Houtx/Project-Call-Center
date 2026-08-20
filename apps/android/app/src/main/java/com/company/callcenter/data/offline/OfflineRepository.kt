package com.company.callcenter.data.offline

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.room.withTransaction
import com.company.callcenter.data.AppMode
import com.company.callcenter.data.AppModeStore
import com.company.callcenter.data.CallStatistics
import com.company.callcenter.data.CallStatisticsRange
import com.company.callcenter.data.DialAuthorization
import com.company.callcenter.data.DialSource
import com.company.callcenter.data.local.CallStatisticsRow
import com.company.callcenter.offline.importing.PhoneNumberNormalizer
import com.company.callcenter.telephony.CallLogReader
import com.company.callcenter.telemetry.CallMetricsRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineRepository(
    private val context: Context,
    private val database: OfflineDatabase,
    private val access: OfflineAccessStore,
    private val callLogReader: CallLogReader,
    private val appModeStore: AppModeStore,
    private val callMetricsRecorder: CallMetricsRecorder = CallMetricsRecorder.NOOP,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val dao = database.dao()
    private val importMutex = Mutex()
    private val callStateCoordinator = OfflineCallStateCoordinator()
    private val mutableConfigured = MutableStateFlow(access.isConfigured)
    private val mutableUnlocked = MutableStateFlow(false)
    private val mutableMaximumAttempts = MutableStateFlow(access.maximumAttempts)
    @Volatile private var backgroundedAtMillis: Long = 0L

    val configured: StateFlow<Boolean> = mutableConfigured.asStateFlow()
    val unlocked: StateFlow<Boolean> = mutableUnlocked.asStateFlow()
    val maximumAttempts: StateFlow<Int> = mutableMaximumAttempts.asStateFlow()
    val hasPendingCall: Flow<Boolean> = dao.observeHasPendingCall()

    val history: Flow<List<OfflineCallRecord>> = unlocked.flatMapLatest { isUnlocked ->
        if (!isUnlocked) flowOf(emptyList()) else dao.observeHistory().map { rows ->
            rows.mapNotNull(::toCallRecord)
        }
    }

    val importBatches: Flow<List<OfflineImportBatch>> = unlocked.flatMapLatest { isUnlocked ->
        if (!isUnlocked) flowOf(emptyList()) else dao.observeImportBatches().map { rows -> rows.map(::toImportBatch) }
    }

    fun taskPage(
        filter: OfflineTaskFilter,
        dateFilter: OfflineMissedDateFilter,
        allFilter: OfflineAllTaskFilter,
    ): Flow<OfflineTaskPage> = unlocked.flatMapLatest { isUnlocked ->
        if (!isUnlocked) {
            flowOf(OfflineTaskPage())
        } else {
            val rows: Flow<List<OfflineContactEntity>>
            val count: Flow<Int>
            when (filter) {
                OfflineTaskFilter.PENDING -> {
                    rows = dao.observePendingContacts(TASK_PAGE_SIZE)
                    count = dao.observePendingContactCount()
                }
                OfflineTaskFilter.NOT_CONNECTED -> {
                    rows = dao.observeNotConnectedContacts(
                        dateFilter.startMillis,
                        dateFilter.endExclusiveMillis,
                        TASK_PAGE_SIZE,
                    )
                    count = dao.observeNotConnectedContactCount(
                        dateFilter.startMillis,
                        dateFilter.endExclusiveMillis,
                    )
                }
                OfflineTaskFilter.ALL -> {
                    val digits = allFilter.phoneQuery.filter(Char::isDigit)
                    val phoneHash = digits.takeIf { it.length == 11 }?.let(access::phoneHash)
                    val maskedQuery = digits.takeIf { it.length in 1..4 }
                    rows = dao.observeAllContacts(
                        phoneHash = phoneHash,
                        maskedQuery = maskedQuery,
                        importBatchId = allFilter.importBatchId,
                        startMillis = allFilter.createdDateFilter.startMillis,
                        endExclusiveMillis = allFilter.createdDateFilter.endExclusiveMillis,
                        callStatus = allFilter.callStatus.name,
                        limit = TASK_PAGE_SIZE,
                    )
                    count = dao.observeAllContactCount(
                        phoneHash = phoneHash,
                        maskedQuery = maskedQuery,
                        importBatchId = allFilter.importBatchId,
                        startMillis = allFilter.createdDateFilter.startMillis,
                        endExclusiveMillis = allFilter.createdDateFilter.endExclusiveMillis,
                        callStatus = allFilter.callStatus.name,
                    )
                }
            }
            combine(rows, count) { contacts, total ->
                OfflineTaskPage(contacts.mapNotNull(::toContact), total)
            }
        }
    }

    fun statistics(range: CallStatisticsRange): Flow<CallStatistics> = unlocked.flatMapLatest { isUnlocked ->
        if (!isUnlocked) {
            flowOf(CallStatistics())
        } else {
            dao.observeStatistics(range.sinceMillis(clock())).map { row -> row.toStatistics() }
        }
    }

    fun createPassword(password: String) {
        access.createPassword(password)
        mutableConfigured.value = true
        mutableUnlocked.value = true
    }

    fun unlock(password: String): OfflineUnlockResult {
        val result = access.verifyPassword(password)
        if (result.unlocked) mutableUnlocked.value = true
        return result
    }

    fun lock() {
        mutableUnlocked.value = false
    }

    fun markBackgrounded() {
        backgroundedAtMillis = clock()
    }

    fun lockIfBackgroundTimeout(timeoutMillis: Long): Boolean {
        require(timeoutMillis > 0)
        val backgroundedAt = backgroundedAtMillis
        backgroundedAtMillis = 0L
        val shouldLock = backgroundedAt > 0L && clock() - backgroundedAt >= timeoutMillis
        if (shouldLock) lock()
        return shouldLock
    }

    fun changePassword(currentPassword: String, newPassword: String): Boolean {
        checkUnlocked()
        return access.changePassword(currentPassword, newPassword)
    }

    suspend fun eraseOfflineData(password: String): Boolean = withContext(Dispatchers.IO) {
        if (!access.verifyPassword(password).unlocked) return@withContext false
        importMutex.withLock {
            callStateCoordinator.serialized {
                dao.clearAll()
                access.clearPassword()
                mutableUnlocked.value = false
                mutableConfigured.value = false
                mutableMaximumAttempts.value = DEFAULT_MAX_ATTEMPTS
                true
            }
        }
    }

    suspend fun setMaximumAttempts(value: Int) = withContext(Dispatchers.IO) {
        require(value in MIN_MAX_ATTEMPTS..MAX_MAX_ATTEMPTS) { "外呼次数只能设置为 1-10 次" }
        callStateCoordinator.serialized {
            checkUnlocked()
            dao.reconcileMaximumAttempts(value, clock())
            access.maximumAttempts = value
            mutableMaximumAttempts.value = value
        }
    }

    suspend fun importContacts(
        records: List<OfflineImportContact>,
        invalidCount: Int = 0,
        duplicateCount: Int = 0,
        metadata: OfflineImportMetadata,
        onProgress: (processed: Int, total: Int) -> Unit = { _, _ -> },
    ): OfflineImportResult = withContext(Dispatchers.IO) {
        checkUnlocked()
        importMutex.withLock {
            val unique = LinkedHashMap<String, Pair<String, String?>>()
            var duplicatesInInput = duplicateCount
            var invalid = invalidCount
            records.forEach { record ->
                val phone = PhoneNumberNormalizer.normalize(record.phone)
                if (phone == null) {
                    invalid += 1
                    return@forEach
                }
                val hash = access.phoneHash(phone)
                if (unique.putIfAbsent(hash, phone to record.name?.trim()?.takeIf(String::isNotBlank)) != null) {
                    duplicatesInInput += 1
                }
            }

            val batchId = UUID.randomUUID().toString()
            val importedAt = clock()
            onProgress(0, unique.size)
            database.withTransaction {
                dao.insertImportBatch(metadata.toEntity(batchId, importedAt))
                var queueOrder = dao.maximumQueueOrder()
                var added = 0
                var processed = 0
                unique.entries.chunked(IMPORT_CHUNK_SIZE).forEach { chunk ->
                    val entities = chunk.map { (hash, phoneAndName) ->
                        val (phone, name) = phoneAndName
                        queueOrder += 1
                        OfflineContactEntity(
                            id = UUID.randomUUID().toString(),
                            encryptedPhone = access.encrypt(phone),
                            phoneHash = hash,
                            phoneMasked = maskPhone(phone),
                            encryptedName = name?.let(access::encrypt),
                            importedAt = importedAt,
                            state = OfflineContactState.READY.name,
                            attemptCount = 0,
                            lastResult = null,
                            lastAttemptAt = null,
                            completedAt = null,
                            queueOrder = queueOrder,
                            importBatchId = batchId,
                        )
                    }
                    added += dao.insertContacts(entities).count { rowId -> rowId != -1L }
                    processed += chunk.size
                    onProgress(processed, unique.size)
                }
                val result = OfflineImportResult(
                    addedCount = added,
                    duplicateCount = duplicatesInInput + unique.size - added,
                    invalidCount = invalid,
                )
                dao.finishImportBatch(batchId, result.addedCount, result.duplicateCount, result.invalidCount)
                onProgress(unique.size, unique.size)
                result
            }
        }
    }

    suspend fun countContactsForImportBatch(batchId: String): Int = withContext(Dispatchers.IO) {
        checkUnlocked()
        dao.countContactsForImportBatch(batchId)
    }

    suspend fun deleteImportBatch(batchId: String): OfflineImportDeleteResult = withContext(Dispatchers.IO) {
        importMutex.withLock {
            callStateCoordinator.serialized {
                checkUnlocked()
                OfflineImportDeleteResult(dao.deleteImportBatchAndContacts(batchId))
            }
        }
    }

    suspend fun revealPhone(contactId: String): String = withContext(Dispatchers.IO) {
        checkUnlocked()
        val contact = dao.contact(contactId) ?: error("离线联系人不存在")
        access.decrypt(contact.encryptedPhone)
    }

    suspend fun revealHistoryPhone(attemptId: String): String = withContext(Dispatchers.IO) {
        checkUnlocked()
        val history = dao.history(attemptId) ?: error("通话记录不存在")
        access.decrypt(history.encryptedPhone)
    }

    suspend fun authorizeCall(contactId: String): DialAuthorization = withContext(Dispatchers.IO) {
        callStateCoordinator.serialized {
            checkOfflineDialAccess()
            checkRequiredPermissions()
            val contact = dao.contact(contactId) ?: error("离线联系人不存在")
            check(
                OfflineCallPolicy.canCall(
                    state = OfflineContactState.valueOf(contact.state),
                    attemptCount = contact.attemptCount,
                    maximumAttempts = maximumAttempts.value,
                ),
            ) { "该联系人当前不可外呼或已达到最大外呼次数" }

            val phone = access.decrypt(contact.encryptedPhone)
            val initiatedAt = clock()
            val attemptId = UUID.randomUUID().toString()
            val queueOrder = dao.maximumQueueOrder() + 1
            val pending = OfflinePendingCallEntity(
                attemptId = attemptId,
                contactId = contact.id,
                encryptedPhone = contact.encryptedPhone,
                callLogBaselineId = callLogReader.latestOutgoingId(),
                initiatedAt = initiatedAt,
                deadlineAt = initiatedAt + COLLECTION_WINDOW_MILLIS,
                previousState = contact.state,
                previousCompletedAt = contact.completedAt,
                previousQueueOrder = contact.queueOrder,
            )
            checkOfflineDialAccess()
            check(dao.beginAttempt(pending, queueOrder, maximumAttempts.value)) {
                "该联系人当前不可外呼，请刷新后重试"
            }
            DialAuthorization(
                attemptId = attemptId,
                phone = phone,
                recordingRequested = false,
                source = DialSource.OFFLINE,
            )
        }
    }

    suspend fun cancelFailedCallAttempt(attemptId: String) = withContext(Dispatchers.IO) {
        callStateCoordinator.serialized {
            val pending = dao.pendingCall(attemptId) ?: return@serialized
            dao.cancelAttempt(pending)
        }
    }

    suspend fun reconcilePending(): Int = withContext(Dispatchers.IO) {
        callStateCoordinator.serialized {
            if (!callLogReader.hasPermission()) return@serialized 0
            var completed = 0
            dao.pendingCalls().forEach { pending ->
                val phone = runCatching { access.decrypt(pending.encryptedPhone) }.getOrNull()
                    ?: return@forEach
                val matched = callLogReader.findOutgoing(
                    phone = phone,
                    baselineId = pending.callLogBaselineId,
                    initiatedAt = pending.initiatedAt,
                )
                if (matched == null && clock() < pending.deadlineAt) return@forEach

                val contact = dao.contact(pending.contactId) ?: return@forEach
                val result = when {
                    matched == null -> OfflineCallResult.UNKNOWN
                    matched.durationSeconds > 0 -> OfflineCallResult.CONNECTED
                    else -> OfflineCallResult.NOT_CONNECTED
                }
                val settlement = OfflineCallPolicy.settle(
                    result = result,
                    attemptCount = contact.attemptCount,
                    maximumAttempts = maximumAttempts.value,
                    observedAt = clock(),
                )
                val startedAt = matched?.startedAt ?: pending.initiatedAt
                val history = OfflineCallHistoryEntity(
                    attemptId = pending.attemptId,
                    contactId = pending.contactId,
                    encryptedPhone = pending.encryptedPhone,
                    encryptedName = contact.encryptedName,
                    phoneMasked = contact.phoneMasked,
                    result = result.name,
                    startedAt = startedAt,
                    durationSeconds = matched?.durationSeconds,
                    observedAt = clock(),
                    systemCallLogId = matched?.id,
                )
                if (
                    dao.settleAttempt(
                        pending = pending,
                        history = history,
                        state = settlement.state.name,
                        result = result.name,
                        completedAt = settlement.completedAt,
                        queueOrder = dao.maximumQueueOrder() + 1,
                    )
                ) {
                    callMetricsRecorder.record(
                        pending.attemptId,
                        AppMode.OFFLINE,
                        result.name,
                        matched?.durationSeconds,
                        startedAt,
                    )
                    completed += 1
                }
            }
            completed
        }
    }

    suspend fun countCompletedBefore(days: Int): Int = withContext(Dispatchers.IO) {
        checkUnlocked()
        dao.countCompletedBefore(cleanupCutoff(days))
    }

    suspend fun deleteCompletedBefore(days: Int): OfflineCleanupResult = withContext(Dispatchers.IO) {
        callStateCoordinator.serialized {
            checkUnlocked()
            OfflineCleanupResult(dao.deleteCompletedBefore(cleanupCutoff(days)))
        }
    }

    private fun cleanupCutoff(days: Int): Long {
        require(days in CLEANUP_DAYS) { "只支持清理 10、15 或 30 天前的数据" }
        return Instant.ofEpochMilli(clock())
            .atZone(SHANGHAI_ZONE)
            .toLocalDate()
            .minusDays(days.toLong())
            .atStartOfDay(SHANGHAI_ZONE)
            .toInstant()
            .toEpochMilli()
    }

    private fun toContact(entity: OfflineContactEntity): OfflineContact? = runCatching {
        OfflineContact(
            id = entity.id,
            name = entity.encryptedName?.let(access::decrypt)?.takeIf(String::isNotBlank) ?: "未命名号码",
            phoneMasked = entity.phoneMasked,
            state = OfflineContactState.valueOf(entity.state),
            attemptCount = entity.attemptCount,
            lastResult = entity.lastResult?.let(OfflineCallResult::valueOf),
            importedAt = entity.importedAt,
            lastAttemptAt = entity.lastAttemptAt,
            completedAt = entity.completedAt,
        )
    }.getOrNull()

    private fun toCallRecord(entity: OfflineCallHistoryEntity): OfflineCallRecord? = runCatching {
        OfflineCallRecord(
            attemptId = entity.attemptId,
            contactId = entity.contactId,
            customerName = entity.encryptedName?.let(access::decrypt)?.takeIf(String::isNotBlank) ?: "未命名号码",
            phoneMasked = entity.phoneMasked,
            result = OfflineCallResult.valueOf(entity.result),
            startedAt = entity.startedAt,
            durationSeconds = entity.durationSeconds,
        )
    }.getOrNull()

    private fun toImportBatch(entity: OfflineImportBatchEntity): OfflineImportBatch = OfflineImportBatch(
        id = entity.id,
        displayName = entity.displayName,
        source = OfflineImportSource.valueOf(entity.source),
        sheetName = entity.sheetName,
        columnLetter = entity.columnLetter,
        requestedStartRow = entity.requestedStartRow,
        requestedEndRow = entity.requestedEndRow,
        skipHeader = entity.skipHeader,
        createdAt = entity.createdAt,
        addedCount = entity.addedCount,
        duplicateCount = entity.duplicateCount,
        invalidCount = entity.invalidCount,
    )

    private fun OfflineImportMetadata.toEntity(id: String, createdAt: Long) = OfflineImportBatchEntity(
        id = id,
        displayName = displayName.take(200),
        source = source.name,
        sheetName = sheetName?.take(100),
        columnLetter = columnLetter?.take(5),
        requestedStartRow = requestedStartRow,
        requestedEndRow = requestedEndRow,
        skipHeader = skipHeader,
        createdAt = createdAt,
        addedCount = 0,
        duplicateCount = 0,
        invalidCount = 0,
    )

    private fun checkUnlocked() {
        check(unlocked.value) { "离线数据已锁定，请先输入密码" }
    }

    private fun checkOfflineDialAccess() {
        check(OfflineDialAccessPolicy.canAuthorize(appModeStore.mode.value, unlocked.value)) {
            "当前不是已解锁的离线模式"
        }
    }

    private fun checkRequiredPermissions() {
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
            "未授予拨打电话权限"
        }
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED) {
            "未授予读取通话记录权限"
        }
    }

    private fun maskPhone(phone: String): String = if (phone.length == 11) {
        "${phone.take(3)}****${phone.takeLast(4)}"
    } else {
        "***${phone.takeLast(4)}"
    }

    private fun CallStatisticsRow.toStatistics(): CallStatistics = CallStatistics(
        callCount = callCount,
        customerCount = customerCount,
        connectedCount = connectedCount,
        notConnectedCount = notConnectedCount,
        unknownCount = unknownCount,
        totalDurationSeconds = totalDurationSeconds,
        averageDurationSeconds = averageDurationSeconds,
        maximumDurationSeconds = maximumDurationSeconds,
    )

    private companion object {
        const val IMPORT_CHUNK_SIZE = 500
        const val TASK_PAGE_SIZE = 100
        const val COLLECTION_WINDOW_MILLIS = 24L * 60L * 60L * 1_000L
        const val DEFAULT_MAX_ATTEMPTS = 2
        const val MIN_MAX_ATTEMPTS = 1
        const val MAX_MAX_ATTEMPTS = 10
        val CLEANUP_DAYS = setOf(10, 15, 30)
        val SHANGHAI_ZONE: ZoneId = ZoneId.of("Asia/Shanghai")
    }
}
