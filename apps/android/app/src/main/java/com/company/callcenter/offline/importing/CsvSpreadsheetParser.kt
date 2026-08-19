package com.company.callcenter.offline.importing

import java.io.BufferedInputStream
import java.io.BufferedReader
import java.io.File
import java.io.FileInputStream
import java.io.InputStreamReader
import java.io.PushbackReader
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

internal class CsvSpreadsheetParser(private val file: File) {
    private val encoding by lazy(::detectEncoding)
    private val delimiter by lazy(::detectDelimiter)
    private val format: SpreadsheetFormat
        get() = if (delimiter == '\t') SpreadsheetFormat.TSV else SpreadsheetFormat.CSV

    fun preview(): SpreadsheetPreview {
        val accumulator = PreviewAccumulator(SHEET_ID, file.nameWithoutExtension.ifBlank { "数据" })
        parseRecords { _, values -> accumulator.accept(values) }
        return SpreadsheetPreview(format, listOf(accumulator.build()))
    }

    fun readColumn(sheetId: String, columnIndex: Int, skipHeader: Boolean): SpreadsheetColumnData {
        if (sheetId != SHEET_ID) {
            throw SpreadsheetReadException(SpreadsheetFailureReason.SHEET_NOT_FOUND, "找不到所选工作表")
        }
        val cells = ArrayList<SpreadsheetCellValue>()
        parseRecords { rowNumber, values ->
            if (!(skipHeader && rowNumber == 1)) {
                cells += SpreadsheetCellValue(rowNumber, values.getOrNull(columnIndex).orEmpty())
            }
        }
        return SpreadsheetColumnData(SHEET_ID, columnIndex, cells)
    }

    private fun parseRecords(onRecord: (Int, List<String>) -> Unit) {
        openReader().use { reader ->
            val fields = ArrayList<String>()
            val field = StringBuilder()
            var inQuotes = false
            var rowNumber = 0
            var hasContent = false

            fun finishField() {
                validateCell(field.toString())
                fields += field.toString()
                field.setLength(0)
                if (fields.size > ImportLimits.MAX_COLUMNS) {
                    throw limitExceeded("表格最多支持 ${ImportLimits.MAX_COLUMNS} 列")
                }
            }

            fun finishRecord() {
                finishField()
                rowNumber += 1
                if (rowNumber > ImportLimits.MAX_ROWS) {
                    throw limitExceeded("表格最多支持 ${ImportLimits.MAX_ROWS} 行")
                }
                onRecord(rowNumber, fields.toList())
                fields.clear()
                hasContent = false
            }

            while (true) {
                val code = reader.read()
                if (code == -1) break
                val character = code.toChar()
                if (character == '\u0000') {
                    throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "文本文件包含无效字符")
                }
                if (inQuotes) {
                    if (character == '"') {
                        val next = reader.read()
                        if (next == '"'.code) {
                            field.append('"')
                        } else {
                            inQuotes = false
                            if (next != -1) reader.unread(next)
                        }
                    } else {
                        field.append(character)
                    }
                    if (field.length > ImportLimits.MAX_CELL_CHARS) {
                        throw limitExceeded("单元格内容不能超过 ${ImportLimits.MAX_CELL_CHARS} 个字符")
                    }
                    hasContent = true
                    continue
                }
                when (character) {
                    '"' -> {
                        if (field.isEmpty()) inQuotes = true else field.append(character)
                        hasContent = true
                    }
                    delimiter -> {
                        finishField()
                        hasContent = true
                    }
                    '\r', '\n' -> {
                        if (character == '\r') {
                            val next = reader.read()
                            if (next != '\n'.code && next != -1) reader.unread(next)
                        }
                        finishRecord()
                    }
                    else -> {
                        field.append(character)
                        if (field.length > ImportLimits.MAX_CELL_CHARS) {
                            throw limitExceeded("单元格内容不能超过 ${ImportLimits.MAX_CELL_CHARS} 个字符")
                        }
                        hasContent = true
                    }
                }
            }
            if (inQuotes) {
                throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "CSV 引号没有闭合")
            }
            if (hasContent || field.isNotEmpty() || fields.isNotEmpty()) finishRecord()
        }
    }

    private fun detectDelimiter(): Char {
        val counts = linkedMapOf(',' to 0, '\t' to 0, ';' to 0)
        openReader().use { reader ->
            var inQuotes = false
            var records = 0
            while (records < DELIMITER_SAMPLE_RECORDS) {
                val code = reader.read()
                if (code == -1) break
                val character = code.toChar()
                if (character == '"') {
                    if (inQuotes) {
                        val next = reader.read()
                        if (next != '"'.code) {
                            inQuotes = false
                            if (next != -1) reader.unread(next)
                        }
                    } else {
                        inQuotes = true
                    }
                } else if (!inQuotes) {
                    if (character in counts) counts[character] = counts.getValue(character) + 1
                    if (character == '\n') records += 1
                }
            }
        }
        val preferred = if (file.extension.equals("tsv", ignoreCase = true)) '\t' else ','
        val maximum = counts.values.maxOrNull() ?: 0
        if (maximum == 0) return preferred
        return counts.entries.firstOrNull { it.value == maximum && it.key == preferred }?.key
            ?: counts.maxBy { it.value }.key
    }

    private fun detectEncoding(): Encoding {
        val prefix = ByteArray(3)
        val read = FileInputStream(file).use { it.read(prefix) }
        if (read >= 3 && prefix[0] == 0xef.toByte() && prefix[1] == 0xbb.toByte() && prefix[2] == 0xbf.toByte()) {
            return Encoding(StandardCharsets.UTF_8, 3)
        }
        if (read >= 2 && prefix[0] == 0xff.toByte() && prefix[1] == 0xfe.toByte()) {
            return Encoding(StandardCharsets.UTF_16LE, 2)
        }
        if (read >= 2 && prefix[0] == 0xfe.toByte() && prefix[1] == 0xff.toByte()) {
            return Encoding(StandardCharsets.UTF_16BE, 2)
        }
        rejectBinaryPrefix()
        return if (isValidUtf8()) Encoding(StandardCharsets.UTF_8, 0) else Encoding(Charset.forName("GB18030"), 0)
    }

    private fun rejectBinaryPrefix() {
        BufferedInputStream(FileInputStream(file)).use { input ->
            var controls = 0
            var total = 0
            while (total < BINARY_SAMPLE_BYTES) {
                val value = input.read()
                if (value == -1) break
                if (value == 0) {
                    throw SpreadsheetReadException(SpreadsheetFailureReason.UNSUPPORTED_FORMAT, "所选文件不是文本表格")
                }
                if (value < 0x20 && value !in listOf('\r'.code, '\n'.code, '\t'.code)) controls += 1
                total += 1
            }
            if (total > 0 && controls * 20 > total) {
                throw SpreadsheetReadException(SpreadsheetFailureReason.UNSUPPORTED_FORMAT, "所选文件不是文本表格")
            }
        }
    }

    private fun isValidUtf8(): Boolean = try {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        InputStreamReader(FileInputStream(file), decoder).use { reader ->
            val buffer = CharArray(DEFAULT_BUFFER_SIZE)
            while (reader.read(buffer) != -1) Unit
        }
        true
    } catch (_: CharacterCodingException) {
        false
    }

    private fun openReader(): PushbackReader {
        val input = FileInputStream(file)
        var remaining = encoding.bomBytes
        while (remaining > 0) {
            val skipped = input.skip(remaining.toLong()).toInt()
            if (skipped <= 0) {
                input.close()
                throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "文本编码标记无效")
            }
            remaining -= skipped
        }
        val decoder = encoding.charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return PushbackReader(BufferedReader(InputStreamReader(input, decoder)), 1)
    }

    private data class Encoding(val charset: Charset, val bomBytes: Int)

    private companion object {
        const val SHEET_ID = "text"
        const val DELIMITER_SAMPLE_RECORDS = 20
        const val BINARY_SAMPLE_BYTES = 8 * 1024
    }
}
