package com.company.callcenter.offline.importing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class XlsxSpreadsheetReaderTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val reader = SpreadsheetReader()

    @Test
    fun `previews multiple sheets and reads sparse shared inline numeric and formula cells`() {
        val file = temporaryFolder.newFile("customers.xlsx")
        writeWorkbook(
            file,
            sharedStrings = listOf("姓名", "手机号", "13600136000"),
            sheets = listOf(
                TestSheet(
                    "待呼客户",
                    """
                    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
                      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
                      <row r="2"><c r="A2" t="inlineStr"><is><t>张三</t></is></c><c r="C2" t="inlineStr"><is><t>13800138000</t></is></c></row>
                      <row r="3"><c r="C3"><v>1.3900139E10</v></c></row>
                      <row r="4"><c r="C4"><f>13700137000</f><v>13700137000</v></c></row>
                    </sheetData></worksheet>
                    """.trimIndent(),
                ),
                TestSheet(
                    "再次尝试",
                    """
                    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
                      <row r="1"><c r="B1" t="inlineStr"><is><r><t>手机</t></r><r><t>号</t></r></is></c></row>
                      <row r="2"><c r="B2" t="s"><v>2</v></c></row>
                    </sheetData></worksheet>
                    """.trimIndent(),
                ),
            ),
        )

        val preview = reader.preview(file)
        assertEquals(SpreadsheetFormat.XLSX, preview.format)
        assertEquals(listOf("待呼客户", "再次尝试"), preview.sheets.map { it.name })
        val phoneColumn = preview.sheets.first().columns.single { it.index == 2 }
        assertEquals("C", phoneColumn.letter)
        assertEquals("手机号", phoneColumn.header)
        assertEquals(listOf("13800138000", "13900139000", "13700137000"), phoneColumn.samples)
        assertEquals(1.0, phoneColumn.validRate, 0.0)

        val firstSheet = preview.sheets.first()
        val data = reader.readColumn(file, firstSheet.id, 2, skipHeader = true)
        assertEquals(listOf("13800138000", "13900139000", "13700137000"), data.cells.map { it.value })
        assertEquals(listOf(2, 3, 4), data.cells.map { it.rowNumber })

        val secondData = reader.readColumn(file, preview.sheets[1].id, 1, skipHeader = true)
        assertEquals(listOf("13600136000"), secondData.cells.map { it.value })
    }

    @Test
    fun `rejects missing shared string and columns beyond limit`() {
        val badShared = temporaryFolder.newFile("bad-shared.xlsx")
        writeWorkbook(
            badShared,
            sharedStrings = listOf("手机号"),
            sheets = listOf(TestSheet("数据", sheetWithCell("A1", "s", "99"))),
        )
        assertReason(SpreadsheetFailureReason.CORRUPT_FILE) { reader.preview(badShared) }

        val tooWide = temporaryFolder.newFile("wide.xlsx")
        writeWorkbook(
            tooWide,
            sharedStrings = null,
            sheets = listOf(TestSheet("数据", sheetWithCell("IW1", null, "13800138000"))),
        )
        assertReason(SpreadsheetFailureReason.LIMIT_EXCEEDED) { reader.preview(tooWide) }
    }

    @Test
    fun `rejects excessive row number and malformed XML`() {
        val rows = temporaryFolder.newFile("rows.xlsx")
        writeWorkbook(
            rows,
            sharedStrings = null,
            sheets = listOf(
                TestSheet(
                    "数据",
                    "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>" +
                        "<row r=\"100001\"><c r=\"A100001\"><v>13800138000</v></c></row>" +
                        "</sheetData></worksheet>",
                ),
            ),
        )
        assertReason(SpreadsheetFailureReason.LIMIT_EXCEEDED) { reader.preview(rows) }

        val malformed = temporaryFolder.newFile("malformed.xlsx")
        writeWorkbook(
            malformed,
            sharedStrings = null,
            sheets = listOf(TestSheet("数据", "<worksheet><sheetData><row>")),
        )
        assertReason(SpreadsheetFailureReason.CORRUPT_FILE) { reader.preview(malformed) }
    }

    @Test
    fun `rejects ZIP entry count and suspicious compression ratio`() {
        val manyEntries = temporaryFolder.newFile("many.xlsx")
        writeWorkbook(
            manyEntries,
            sharedStrings = null,
            sheets = listOf(TestSheet("数据", emptySheet())),
            extraEntries = ImportLimits.MAX_ZIP_ENTRIES,
        )
        assertReason(SpreadsheetFailureReason.LIMIT_EXCEEDED) { reader.preview(manyEntries) }

        val bomb = temporaryFolder.newFile("bomb.xlsx")
        writeWorkbook(
            bomb,
            sharedStrings = null,
            sheets = listOf(TestSheet("数据", emptySheet())),
            bombBytes = ByteArray(1_100_000) { 'A'.code.toByte() },
        )
        assertReason(SpreadsheetFailureReason.LIMIT_EXCEEDED) { reader.preview(bomb) }
    }

    @Test
    fun `rejects document type declarations`() {
        val file = temporaryFolder.newFile("doctype.xlsx")
        writeWorkbook(
            file,
            sharedStrings = null,
            sheets = listOf(TestSheet("数据", emptySheet())),
            workbookPrefix = "<!DOCTYPE workbook [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]>",
        )
        assertReason(SpreadsheetFailureReason.CORRUPT_FILE) { reader.preview(file) }
    }

    private fun writeWorkbook(
        file: File,
        sharedStrings: List<String>?,
        sheets: List<TestSheet>,
        extraEntries: Int = 0,
        bombBytes: ByteArray? = null,
        workbookPrefix: String = "",
    ) {
        ZipOutputStream(file.outputStream()).use { zip ->
            zip.textEntry(
                "[Content_Types].xml",
                """
                <?xml version="1.0" encoding="UTF-8"?>
                <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
                </Types>
                """.trimIndent(),
            )
            zip.textEntry(
                "xl/workbook.xml",
                """
                <?xml version="1.0" encoding="UTF-8"?>$workbookPrefix
                <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                  <sheets>${sheets.mapIndexed { index, sheet -> "<sheet name=\"${sheet.name}\" sheetId=\"${index + 1}\" r:id=\"rId${index + 1}\"/>" }.joinToString("")}</sheets>
                </workbook>
                """.trimIndent(),
            )
            zip.textEntry(
                "xl/_rels/workbook.xml.rels",
                """
                <?xml version="1.0" encoding="UTF-8"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  ${sheets.indices.joinToString("") { index -> "<Relationship Id=\"rId${index + 1}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet${index + 1}.xml\"/>" }}
                </Relationships>
                """.trimIndent(),
            )
            sheets.forEachIndexed { index, sheet -> zip.textEntry("xl/worksheets/sheet${index + 1}.xml", sheet.xml) }
            if (sharedStrings != null) {
                zip.textEntry(
                    "xl/sharedStrings.xml",
                    "<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">" +
                        sharedStrings.joinToString("") { "<si><t>$it</t></si>" } + "</sst>",
                )
            }
            repeat(extraEntries) { zip.textEntry("extra/$it.txt", "x") }
            bombBytes?.let {
                zip.putNextEntry(ZipEntry("extra/bomb.bin"))
                zip.write(it)
                zip.closeEntry()
            }
        }
    }

    private fun sheetWithCell(reference: String, type: String?, value: String): String =
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>" +
            "<row r=\"1\"><c r=\"$reference\"${type?.let { " t=\"$it\"" }.orEmpty()}><v>$value</v></c></row>" +
            "</sheetData></worksheet>"

    private fun emptySheet(): String =
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>"

    private fun ZipOutputStream.textEntry(name: String, value: String) {
        putNextEntry(ZipEntry(name))
        write(value.toByteArray())
        closeEntry()
    }

    private fun assertReason(reason: SpreadsheetFailureReason, block: () -> Unit) {
        val failure = assertThrows(SpreadsheetReadException::class.java, block)
        assertEquals(reason, failure.reason)
    }

    private data class TestSheet(val name: String, val xml: String)
}
