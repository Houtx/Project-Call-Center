package com.company.callcenter.offline.importing

import jxl.Workbook
import jxl.write.Label
import jxl.write.Number as NumberCell
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class XlsSpreadsheetReaderTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val reader = SpreadsheetReader()

    @Test
    fun `previews legacy workbook and reads selected phone column`() {
        val file = temporaryFolder.newFile("customers.xls")
        val workbook = Workbook.createWorkbook(file)
        val sheet = workbook.createSheet("客户数据", 0)
        sheet.addCell(Label(0, 0, "姓名"))
        sheet.addCell(Label(1, 0, "手机号"))
        sheet.addCell(Label(0, 1, "张三"))
        sheet.addCell(Label(1, 1, "13800138000"))
        sheet.addCell(Label(0, 2, "李四"))
        sheet.addCell(NumberCell(1, 2, 13900139000.0))
        workbook.write()
        workbook.close()

        val preview = reader.preview(file)
        assertEquals(SpreadsheetFormat.XLS, preview.format)
        assertEquals("客户数据", preview.sheets.single().name)
        assertEquals("手机号", preview.sheets.single().columns[1].header)
        assertEquals(listOf(1, 2, 3), preview.sheets.single().columns[1].previewRows.map { it.rowNumber })

        val data = reader.readColumn(
            file = file,
            sheetId = preview.sheets.single().id,
            columnIndex = 1,
            skipHeader = true,
        )
        assertEquals(listOf(2, 3), data.cells.map { it.rowNumber })
        assertEquals(
            listOf("13800138000", "13900139000"),
            data.cells.map { PhoneNumberNormalizer.normalize(it.value) },
        )
    }
}
