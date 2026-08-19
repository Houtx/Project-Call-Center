package com.company.callcenter.offline.importing

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.zip.ZipException

class SpreadsheetReader {
    fun preview(file: File): SpreadsheetPreview = guardedRead {
        validateFile(file)
        when (detectContainer(file)) {
            ContainerKind.XLSX -> XlsxSpreadsheetParser(file).preview()
            ContainerKind.TEXT -> CsvSpreadsheetParser(file).preview()
            ContainerKind.OLE -> throw SpreadsheetReadException(
                SpreadsheetFailureReason.ENCRYPTED_FILE,
                "不支持加密的 Excel 文件或旧版 .xls 文件",
            )
            ContainerKind.UNKNOWN -> throw SpreadsheetReadException(
                SpreadsheetFailureReason.UNSUPPORTED_FORMAT,
                "仅支持 .xlsx、.xlsm、.csv 和 .tsv 文件",
            )
        }
    }

    fun readColumn(
        file: File,
        sheetId: String,
        columnIndex: Int,
        skipHeader: Boolean,
        startRow: Int = 1,
        endRowInclusive: Int? = null,
        limit: Int? = null,
        onRowRead: (rowNumber: Int) -> Unit = {},
    ): SpreadsheetColumnData = guardedRead {
        validateFile(file)
        if (columnIndex !in 0 until ImportLimits.MAX_COLUMNS) {
            throw SpreadsheetReadException(
                SpreadsheetFailureReason.INVALID_COLUMN,
                "列序号必须介于 0 和 ${ImportLimits.MAX_COLUMNS - 1} 之间",
            )
        }
        if (startRow !in 1..ImportLimits.MAX_PHYSICAL_ROW ||
            endRowInclusive != null && endRowInclusive !in startRow..ImportLimits.MAX_PHYSICAL_ROW ||
            limit != null && limit <= 0
        ) {
            throw SpreadsheetReadException(
                SpreadsheetFailureReason.INVALID_RANGE,
                "导入范围无效，请检查起始行和结束行",
            )
        }
        when (detectContainer(file)) {
            ContainerKind.XLSX -> XlsxSpreadsheetParser(file).readColumn(
                sheetId,
                columnIndex,
                skipHeader,
                startRow,
                endRowInclusive,
                limit,
                onRowRead,
            )
            ContainerKind.TEXT -> CsvSpreadsheetParser(file).readColumn(
                sheetId,
                columnIndex,
                skipHeader,
                startRow,
                endRowInclusive,
                limit,
                onRowRead,
            )
            ContainerKind.OLE -> throw SpreadsheetReadException(
                SpreadsheetFailureReason.ENCRYPTED_FILE,
                "不支持加密的 Excel 文件或旧版 .xls 文件",
            )
            ContainerKind.UNKNOWN -> throw SpreadsheetReadException(
                SpreadsheetFailureReason.UNSUPPORTED_FORMAT,
                "仅支持 .xlsx、.xlsm、.csv 和 .tsv 文件",
            )
        }
    }

    private fun validateFile(file: File) {
        if (!file.isFile) {
            throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "无法读取所选文件")
        }
        if (file.length() > ImportLimits.MAX_FILE_BYTES) {
            throw SpreadsheetReadException(
                SpreadsheetFailureReason.FILE_TOO_LARGE,
                "文件不能超过 25 MiB",
            )
        }
        if (file.length() == 0L) {
            throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "文件内容为空")
        }
    }

    private fun detectContainer(file: File): ContainerKind {
        val signature = ByteArray(8)
        val count = FileInputStream(file).use { it.read(signature) }
        if (count >= 4 && signature[0] == 0x50.toByte() && signature[1] == 0x4b.toByte()) {
            return ContainerKind.XLSX
        }
        if (count == 8 && signature.contentEquals(OLE_SIGNATURE)) return ContainerKind.OLE
        if (looksLikeText(signature, count)) return ContainerKind.TEXT
        return ContainerKind.UNKNOWN
    }

    private fun looksLikeText(signature: ByteArray, count: Int): Boolean {
        if (count >= 2 && (
                signature[0] == 0xff.toByte() && signature[1] == 0xfe.toByte() ||
                    signature[0] == 0xfe.toByte() && signature[1] == 0xff.toByte()
                )
        ) return true
        return (0 until count).none { signature[it] == 0.toByte() }
    }

    private fun <T> guardedRead(block: () -> T): T = try {
        block()
    } catch (failure: SpreadsheetReadException) {
        throw failure
    } catch (failure: ZipException) {
        throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "Excel 压缩包已损坏", failure)
    } catch (failure: IOException) {
        throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "无法解析文件", failure)
    } catch (failure: RuntimeException) {
        throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "文件结构无效", failure)
    } catch (failure: Exception) {
        throw SpreadsheetReadException(SpreadsheetFailureReason.CORRUPT_FILE, "无法解析文件", failure)
    }

    private enum class ContainerKind { XLSX, TEXT, OLE, UNKNOWN }

    private companion object {
        val OLE_SIGNATURE = byteArrayOf(
            0xd0.toByte(), 0xcf.toByte(), 0x11, 0xe0.toByte(),
            0xa1.toByte(), 0xb1.toByte(), 0x1a, 0xe1.toByte(),
        )
    }
}
