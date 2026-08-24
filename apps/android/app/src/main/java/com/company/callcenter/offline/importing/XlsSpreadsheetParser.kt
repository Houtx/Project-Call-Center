package com.company.callcenter.offline.importing

import jxl.Cell
import jxl.Workbook
import jxl.WorkbookSettings
import jxl.read.biff.BiffException
import java.io.File
import java.util.Locale

internal class XlsSpreadsheetParser(private val file: File) {
    fun preview(): SpreadsheetPreview = withWorkbook { workbook ->
        var totalRows = 0L
        val sheets = (0 until workbook.numberOfSheets).map { sheetIndex ->
            val sheet = workbook.getSheet(sheetIndex)
            val sheetId = sheetIndex.toString()
            val sheetName = sheet.name.ifBlank { "工作表 ${sheetIndex + 1}" }
            validateCell(sheetName)
            val accumulator = PreviewAccumulator(sheetId, sheetName)
            for (rowIndex in 0 until sheet.rows) {
                totalRows += 1
                if (totalRows > ImportLimits.MAX_ROWS) {
                    throw limitExceeded("一个文件最多支持 ${ImportLimits.MAX_ROWS} 行")
                }
                accumulator.accept(rowIndex + 1, rowValues(sheet.getRow(rowIndex)))
            }
            accumulator.build()
        }
        SpreadsheetPreview(SpreadsheetFormat.XLS, sheets)
    }

    fun readColumn(
        sheetId: String,
        columnIndex: Int,
        skipHeader: Boolean,
        startRow: Int,
        endRowInclusive: Int?,
        limit: Int?,
        onRowRead: (rowNumber: Int) -> Unit,
    ): SpreadsheetColumnData = withWorkbook { workbook ->
        val sheetIndex = sheetId.toIntOrNull()
            ?.takeIf { it in 0 until workbook.numberOfSheets }
            ?: throw SpreadsheetReadException(SpreadsheetFailureReason.SHEET_NOT_FOUND, "找不到所选工作表")
        val sheet = workbook.getSheet(sheetIndex)
        val cells = ArrayList<SpreadsheetCellValue>()
        var firstRow = true
        for (rowIndex in 0 until sheet.rows) {
            val rowNumber = rowIndex + 1
            onRowRead(rowNumber)
            val skip = skipHeader && firstRow
            firstRow = false
            if (!skip && rowNumber >= startRow && (endRowInclusive == null || rowNumber <= endRowInclusive)) {
                val value = sheet.getCell(columnIndex, rowIndex).contents.trim()
                validateCell(value)
                cells += SpreadsheetCellValue(rowNumber, value)
            }
            val reachedEndRow = endRowInclusive != null && rowNumber >= endRowInclusive
            val reachedLimit = limit != null && cells.size >= limit
            if (reachedEndRow || reachedLimit) break
        }
        SpreadsheetColumnData(sheetId, columnIndex, cells)
    }

    private fun rowValues(row: Array<Cell>): List<String> {
        if (row.size > ImportLimits.MAX_COLUMNS) {
            throw limitExceeded("工作表最多支持 ${ImportLimits.MAX_COLUMNS} 列")
        }
        val values = row.map { cell -> cell.contents.trim().also(::validateCell) }
        val populatedColumns = values.indexOfLast(String::isNotBlank) + 1
        return values.take(populatedColumns)
    }

    private fun <T> withWorkbook(block: (Workbook) -> T): T = try {
        val settings = WorkbookSettings().apply { locale = Locale.CHINA }
        val workbook = Workbook.getWorkbook(file, settings)
        try {
            block(workbook)
        } finally {
            workbook.close()
        }
    } catch (failure: BiffException) {
        val encrypted = failure.message.orEmpty().contains("password", ignoreCase = true) ||
            failure.message.orEmpty().contains("encrypt", ignoreCase = true)
        throw SpreadsheetReadException(
            if (encrypted) SpreadsheetFailureReason.ENCRYPTED_FILE else SpreadsheetFailureReason.CORRUPT_FILE,
            if (encrypted) "不支持加密的 Excel 文件" else "旧版 Excel 文件结构无效",
            failure,
        )
    }
}
