package com.company.callcenter.data.offline

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.company.callcenter.offline.importing.PastePhoneParseResult
import com.company.callcenter.offline.importing.PastePhoneParser
import com.company.callcenter.offline.importing.PhoneNumberNormalizer
import com.company.callcenter.offline.importing.SpreadsheetPreview
import com.company.callcenter.offline.importing.SpreadsheetReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

data class OfflineSpreadsheetSession internal constructor(
    internal val file: File,
    val displayName: String,
    val preview: SpreadsheetPreview,
)

data class OfflineSpreadsheetImportDraft(
    val records: List<OfflineImportContact>,
    val invalidCount: Int,
)

class OfflineImportService(
    context: Context,
    private val reader: SpreadsheetReader = SpreadsheetReader(),
) {
    private val appContext = context.applicationContext
    private val importDirectory = File(appContext.cacheDir, IMPORT_DIRECTORY).apply { mkdirs() }

    init {
        // A preview session cannot survive process recreation, so every leftover
        // file is orphaned and should be removed before accepting another import.
        importDirectory.listFiles().orEmpty().forEach(File::delete)
    }

    suspend fun openDocument(uri: Uri): OfflineSpreadsheetSession = withContext(Dispatchers.IO) {
        removeExpiredFiles()
        val displayName = queryDisplayName(uri)
        val suffix = displayName.substringAfterLast('.', "tmp")
            .lowercase()
            .takeIf { it.matches(Regex("[a-z0-9]{1,8}")) }
            ?.let { ".$it" }
            ?: ".tmp"
        val temporary = File.createTempFile("import-", suffix, importDirectory)
        try {
            copyLimited(uri, temporary)
            OfflineSpreadsheetSession(
                file = temporary,
                displayName = displayName,
                preview = reader.preview(temporary),
            )
        } catch (failure: Throwable) {
            temporary.delete()
            throw failure
        }
    }

    suspend fun readSpreadsheet(
        session: OfflineSpreadsheetSession,
        sheetId: String,
        phoneColumnIndex: Int,
        nameColumnIndex: Int?,
        skipHeader: Boolean,
    ): OfflineSpreadsheetImportDraft = withContext(Dispatchers.IO) {
        check(session.file.isFile) { "导入文件已失效，请重新选择" }
        val phoneCells = reader.readColumn(
            file = session.file,
            sheetId = sheetId,
            columnIndex = phoneColumnIndex,
            skipHeader = skipHeader,
        )
        val namesByRow = nameColumnIndex?.let { columnIndex ->
            reader.readColumn(
                file = session.file,
                sheetId = sheetId,
                columnIndex = columnIndex,
                skipHeader = skipHeader,
            ).cells.associate { it.rowNumber to it.value.trim().take(MAX_NAME_CHARS) }
        }.orEmpty()

        var invalid = 0
        val records = phoneCells.cells.mapNotNull { cell ->
            val phone = PhoneNumberNormalizer.normalize(cell.value)
            if (phone == null) {
                invalid += 1
                null
            } else {
                OfflineImportContact(phone = phone, name = namesByRow[cell.rowNumber]?.takeIf(String::isNotBlank))
            }
        }
        OfflineSpreadsheetImportDraft(records, invalid)
    }

    fun parsePaste(value: String): PastePhoneParseResult = PastePhoneParser.parse(value)

    fun close(session: OfflineSpreadsheetSession?) {
        session?.file?.takeIf { it.parentFile == importDirectory }?.delete()
    }

    private fun copyLimited(uri: Uri, destination: File) {
        val resolver = appContext.contentResolver
        val declaredSize = resolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
        if (declaredSize > MAX_FILE_BYTES) throw IllegalArgumentException("文件不能超过 25 MiB")
        val input = resolver.openInputStream(uri) ?: throw IOException("无法读取所选文件")
        input.use { source ->
            FileOutputStream(destination).use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0L
                while (true) {
                    val read = source.read(buffer)
                    if (read == -1) break
                    total += read
                    if (total > MAX_FILE_BYTES) throw IllegalArgumentException("文件不能超过 25 MiB")
                    output.write(buffer, 0, read)
                }
                output.fd.sync()
            }
        }
        if (destination.length() == 0L) throw IllegalArgumentException("所选文件为空")
    }

    private fun queryDisplayName(uri: Uri): String {
        appContext.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(0)?.trim()?.takeIf(String::isNotBlank)?.let { return it.take(200) }
                }
            }
        return "导入文件"
    }

    private fun removeExpiredFiles() {
        val cutoff = System.currentTimeMillis() - TEMP_FILE_TTL_MILLIS
        importDirectory.listFiles().orEmpty().forEach { file ->
            if (file.lastModified() < cutoff) file.delete()
        }
    }

    private companion object {
        const val IMPORT_DIRECTORY = "offline-imports"
        const val MAX_FILE_BYTES = 25L * 1024L * 1024L
        const val MAX_NAME_CHARS = 100
        const val TEMP_FILE_TTL_MILLIS = 24L * 60L * 60L * 1_000L
    }
}
