package com.company.callcenter.offline.importing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets

class CsvSpreadsheetReaderTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val reader = SpreadsheetReader()

    @Test
    fun `previews quoted UTF-8 CSV and reads a selected column`() {
        val file = temporaryFolder.newFile("customers.csv")
        file.writeBytes(
            byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()) +
                "姓名,手机号,备注\r\n张三,13800138000,\"第一行\n第二行\"\r\n李四,1.3900139E10,完成\r\n"
                    .toByteArray(),
        )

        val preview = reader.preview(file)
        assertEquals(SpreadsheetFormat.CSV, preview.format)
        assertEquals("数据", preview.sheets.single().name)
        assertEquals(3, preview.sheets.single().rowCount)
        val phoneColumn = preview.sheets.single().columns.single { it.index == 1 }
        assertEquals("B", phoneColumn.letter)
        assertEquals("手机号", phoneColumn.header)
        assertEquals(listOf("手机号", "13800138000", "1.3900139E10"), phoneColumn.samples)
        assertEquals(listOf(1, 2, 3), phoneColumn.previewRows.map { it.rowNumber })
        assertEquals(true, phoneColumn.suggestsHeader)
        assertEquals(2.0 / 3.0, phoneColumn.validRate, 0.0)

        val rowsRead = mutableListOf<Int>()
        val data = reader.readColumn(
            file,
            preview.sheets.single().id,
            1,
            skipHeader = true,
            onRowRead = rowsRead::add,
        )
        assertEquals(listOf("13800138000", "1.3900139E10"), data.cells.map { it.value })
        assertEquals(listOf(2, 3), data.cells.map { it.rowNumber })
        assertEquals(listOf(1, 2, 3), rowsRead)
    }

    @Test
    fun `detects UTF-16 TSV and GB18030 CSV`() {
        val tsv = temporaryFolder.newFile("customers.tsv")
        tsv.writeBytes(
            byteArrayOf(0xff.toByte(), 0xfe.toByte()) +
                "姓名\t手机号\r\n甲\t13700137000\r\n".toByteArray(StandardCharsets.UTF_16LE),
        )
        val tsvPreview = reader.preview(tsv)
        assertEquals(SpreadsheetFormat.TSV, tsvPreview.format)
        assertEquals("手机号", tsvPreview.sheets.single().columns[1].header)

        val gb = temporaryFolder.newFile("customers-gb.csv")
        gb.writeBytes("姓名;手机号\r\n乙;13600136000\r\n".toByteArray(Charset.forName("GB18030")))
        val gbPreview = reader.preview(gb)
        assertEquals(listOf("手机号", "13600136000"), gbPreview.sheets.single().columns[1].samples)
    }

    @Test
    fun `shows the first twenty raw rows with or without a header`() {
        val file = temporaryFolder.newFile("preview.csv").apply {
            writeText((1..25).joinToString("\n") { row -> if (row == 1) "自定义标题" else "${13000000000L + row}" })
        }

        val column = reader.preview(file).sheets.single().columns.single()
        assertEquals(20, column.previewRows.size)
        assertEquals("自定义标题", column.previewRows.first().rawValue)
        assertEquals("13000000020", column.previewRows.last().rawValue)
        assertEquals(true, column.suggestsHeader)
    }

    @Test
    fun `reads an inclusive physical row range and limits range preview`() {
        val file = temporaryFolder.newFile("range.csv").apply {
            writeText("手机号\n13800138000\n13900139000\n13700137000\n13600136000\n")
        }

        val ranged = reader.readColumn(
            file = file,
            sheetId = reader.preview(file).sheets.single().id,
            columnIndex = 0,
            skipHeader = true,
            startRow = 3,
            endRowInclusive = 5,
        )
        assertEquals(listOf(3, 4, 5), ranged.cells.map { it.rowNumber })
        assertEquals(listOf("13900139000", "13700137000", "13600136000"), ranged.cells.map { it.value })

        val preview = reader.readColumn(
            file = file,
            sheetId = reader.preview(file).sheets.single().id,
            columnIndex = 0,
            skipHeader = false,
            startRow = 2,
            endRowInclusive = 5,
            limit = 2,
        )
        assertEquals(listOf(2, 3), preview.cells.map { it.rowNumber })
    }

    @Test
    fun `rejects invalid custom row ranges`() {
        val file = temporaryFolder.newFile("range-invalid.csv").apply { writeText("13800138000") }
        assertReason(SpreadsheetFailureReason.INVALID_RANGE) {
            reader.readColumn(file, "text", 0, skipHeader = false, startRow = 3, endRowInclusive = 2)
        }
    }

    @Test
    fun `rejects malformed quotes and cell and column limits`() {
        val malformed = temporaryFolder.newFile("malformed.csv").apply {
            writeText("手机号\n\"13800138000")
        }
        assertReason(SpreadsheetFailureReason.CORRUPT_FILE) { reader.preview(malformed) }

        val longCell = temporaryFolder.newFile("long.csv").apply {
            writeText("A".repeat(ImportLimits.MAX_CELL_CHARS + 1))
        }
        assertReason(SpreadsheetFailureReason.LIMIT_EXCEEDED) { reader.preview(longCell) }

        val tooManyColumns = temporaryFolder.newFile("wide.csv").apply {
            writeText((0..ImportLimits.MAX_COLUMNS).joinToString(",") { "x" })
        }
        assertReason(SpreadsheetFailureReason.LIMIT_EXCEEDED) { reader.preview(tooManyColumns) }
    }

    @Test
    fun `rejects row and file size limits`() {
        val tooManyRows = temporaryFolder.newFile("rows.csv")
        tooManyRows.bufferedWriter().use { writer ->
            repeat(ImportLimits.MAX_ROWS + 1) { writer.appendLine("13800138000") }
        }
        assertReason(SpreadsheetFailureReason.LIMIT_EXCEEDED) { reader.preview(tooManyRows) }

        val tooLarge = temporaryFolder.newFile("large.csv")
        RandomAccessFile(tooLarge, "rw").use { it.setLength(ImportLimits.MAX_FILE_BYTES + 1) }
        assertReason(SpreadsheetFailureReason.FILE_TOO_LARGE) { reader.preview(tooLarge) }
    }

    @Test
    fun `rejects binary and encrypted OLE input`() {
        val binary = temporaryFolder.newFile("binary.csv").apply {
            writeBytes(byteArrayOf(1, 0, 2, 3, 4))
        }
        assertReason(SpreadsheetFailureReason.UNSUPPORTED_FORMAT) { reader.preview(binary) }

        val ole = temporaryFolder.newFile("encrypted.xlsx").apply {
            writeBytes(byteArrayOf(
                0xd0.toByte(), 0xcf.toByte(), 0x11, 0xe0.toByte(),
                0xa1.toByte(), 0xb1.toByte(), 0x1a, 0xe1.toByte(),
            ))
        }
        assertReason(SpreadsheetFailureReason.ENCRYPTED_FILE) { reader.preview(ole) }
    }

    private fun assertReason(reason: SpreadsheetFailureReason, block: () -> Unit) {
        val failure = assertThrows(SpreadsheetReadException::class.java, block)
        assertEquals(reason, failure.reason)
    }
}
