package com.company.callcenter.offline.importing

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@RunWith(AndroidJUnit4::class)
class SpreadsheetReaderInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val reader = SpreadsheetReader()

    @Test
    fun parsesStandardWorkbookAndShowsTwentyRawRows() {
        val rows = buildString {
            append("<row><c r=\"C1\" t=\"inlineStr\"><is><t>联系号码</t></is></c></row>")
            repeat(24) { index ->
                append("<row><c r=\"C${index + 2}\"><v>${13000000001L + index}</v></c></row>")
            }
        }
        val file = workbookFile("standard.xlsx", rows, includeRelationships = true)

        val column = reader.preview(file).sheets.single().columns.single()

        assertEquals(2, column.index)
        assertEquals(20, column.previewRows.size)
        assertEquals("联系号码", column.previewRows.first().rawValue)
        assertTrue(column.suggestsHeader)
    }

    @Test
    fun parsesMacroWorkbookWithoutRelationshipMetadata() {
        val file = workbookFile(
            name = "mobile-export.xlsm",
            rows = "<row r=\"99\"><c r=\"\$D\$99\" t=\"inlineStr\"><is><t>12800138000</t></is></c></row>",
            includeRelationships = false,
            macroEnabled = true,
        )

        val column = reader.preview(file).sheets.single().columns.single()

        assertEquals(3, column.index)
        assertEquals("12800138000", column.previewRows.single().normalizedPhone)
    }

    @Test
    fun rejectsDocumentTypeDeclarationsOnAndroidParser() {
        val file = workbookFile(
            name = "doctype.xlsx",
            rows = "<row><c r=\"A1\"><v>13800138000</v></c></row>",
            includeRelationships = false,
            workbookPrefix = "<!DOCTYPE workbook [<!ENTITY xxe SYSTEM \"file:///etc/hosts\">]>",
        )

        val failure = assertThrows(SpreadsheetReadException::class.java) { reader.preview(file) }

        assertEquals(SpreadsheetFailureReason.CORRUPT_FILE, failure.reason)
    }

    private fun workbookFile(
        name: String,
        rows: String,
        includeRelationships: Boolean,
        macroEnabled: Boolean = false,
        workbookPrefix: String = "",
    ): File = File(context.cacheDir, name).also { file ->
        ZipOutputStream(file.outputStream()).use { zip ->
            val contentType = if (macroEnabled) {
                "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
            } else {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            }
            zip.textEntry(
                "[Content_Types].xml",
                "<Types><Override PartName=\"/xl/workbook.xml\" ContentType=\"$contentType\"/></Types>",
            )
            val relationship = if (includeRelationships) " r:id=\"rId1\"" else ""
            zip.textEntry(
                "xl/workbook.xml",
                workbookPrefix +
                    "<workbook xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">" +
                    "<sheets><sheet name=\"号码表\" sheetId=\"1\"$relationship/></sheets></workbook>",
            )
            if (includeRelationships) {
                zip.textEntry(
                    "xl/_rels/workbook.xml.rels",
                    "<Relationships><Relationship Id=\"rId1\" " +
                        "Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" " +
                        "Target=\"worksheets/sheet1.xml\"/></Relationships>",
                )
            }
            zip.textEntry("xl/worksheets/sheet1.xml", "<worksheet><sheetData>$rows</sheetData></worksheet>")
        }
    }

    private fun ZipOutputStream.textEntry(name: String, value: String) {
        putNextEntry(ZipEntry(name))
        write(value.toByteArray())
        closeEntry()
    }
}
