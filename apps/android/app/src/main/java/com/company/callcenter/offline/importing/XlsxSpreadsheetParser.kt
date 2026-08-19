package com.company.callcenter.offline.importing

import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.SAXException
import org.xml.sax.helpers.DefaultHandler
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.math.BigDecimal
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import javax.xml.XMLConstants
import javax.xml.parsers.SAXParserFactory

internal class XlsxSpreadsheetParser(private val file: File) {
    fun preview(): SpreadsheetPreview = withArchive { archive ->
        val sheets = readWorkbook(archive)
        val scans = sheets.map { sheet -> scanSheetForPreview(archive, sheet) }
        val totalRows = scans.sumOf { it.rowCount.toLong() }
        if (totalRows > ImportLimits.MAX_ROWS) {
            throw limitExceeded("一个文件最多支持 ${ImportLimits.MAX_ROWS} 行")
        }
        val sharedIndexes = scans.flatMapTo(linkedSetOf()) { it.sharedIndexes() }
        val sharedStrings = readSharedStrings(archive, sharedIndexes)
        SpreadsheetPreview(
            SpreadsheetFormat.XLSX,
            scans.map { it.build(sharedStrings) },
        )
    }

    fun readColumn(sheetId: String, columnIndex: Int, skipHeader: Boolean): SpreadsheetColumnData =
        withArchive { archive ->
            val sheet = readWorkbook(archive).firstOrNull { it.id == sheetId }
                ?: throw SpreadsheetReadException(SpreadsheetFailureReason.SHEET_NOT_FOUND, "找不到所选工作表")
            val tokens = ArrayList<RowToken>()
            var first = true
            parseSheet(archive, sheet) { rowNumber, cells, _ ->
                if (first && skipHeader) {
                    first = false
                } else {
                    first = false
                    tokens += RowToken(rowNumber, cells[columnIndex] ?: CellToken.Literal(""))
                }
            }
            val sharedStrings = readSharedStrings(
                archive,
                tokens.mapNotNullTo(linkedSetOf()) { (it.token as? CellToken.Shared)?.index },
            )
            SpreadsheetColumnData(
                sheetId = sheetId,
                columnIndex = columnIndex,
                cells = tokens.map { SpreadsheetCellValue(it.rowNumber, it.token.resolve(sharedStrings)) },
            )
        }

    private fun scanSheetForPreview(archive: ZipFile, sheet: SheetDescriptor): PreviewTokenScan {
        val scan = PreviewTokenScan(sheet)
        parseSheet(archive, sheet, scan::accept)
        return scan
    }

    private fun parseSheet(
        archive: ZipFile,
        sheet: SheetDescriptor,
        onRow: (Int, Map<Int, CellToken>, Set<Int>) -> Unit,
    ) {
        parseXml(openEntry(archive, sheet.path), SheetXmlHandler(onRow))
    }

    private fun readWorkbook(archive: ZipFile): List<SheetDescriptor> {
        validateContentTypes(archive)
        val workbookSheets = mutableListOf<WorkbookSheet>()
        parseXml(openEntry(archive, WORKBOOK_PATH), object : DefaultHandler() {
            override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes) {
                if (elementName(localName, qName) != "sheet") return
                val name = attributes.value("name")?.takeIf(String::isNotBlank)
                    ?: throw corrupt("工作表名称缺失")
                validateCell(name)
                val relationshipId = attributes.relationshipId() ?: throw corrupt("工作表关系缺失")
                workbookSheets += WorkbookSheet(relationshipId, name)
            }
        })
        if (workbookSheets.isEmpty()) throw corrupt("Excel 文件不包含工作表")

        val relationships = mutableMapOf<String, String>()
        parseXml(openEntry(archive, WORKBOOK_RELS_PATH), object : DefaultHandler() {
            override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes) {
                if (elementName(localName, qName) != "Relationship") return
                val type = attributes.value("Type").orEmpty()
                if (!type.endsWith("/worksheet")) return
                if (attributes.value("TargetMode")?.equals("External", ignoreCase = true) == true) {
                    throw corrupt("工作表不能引用外部文件")
                }
                val id = attributes.value("Id") ?: throw corrupt("工作表关系 ID 缺失")
                val target = attributes.value("Target") ?: throw corrupt("工作表目标缺失")
                relationships[id] = normalizeZipPath("xl", target)
            }
        })
        return workbookSheets.map { sheet ->
            val path = relationships[sheet.relationshipId] ?: throw corrupt("工作表关系无法解析")
            if (archive.getEntry(path) == null) throw corrupt("工作表文件缺失")
            SheetDescriptor(sheet.relationshipId, sheet.name, path)
        }
    }

    private fun validateContentTypes(archive: ZipFile) {
        var validWorkbook = false
        var macroWorkbook = false
        parseXml(openEntry(archive, CONTENT_TYPES_PATH), object : DefaultHandler() {
            override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes) {
                if (elementName(localName, qName) != "Override") return
                if (attributes.value("PartName") != "/xl/workbook.xml") return
                val contentType = attributes.value("ContentType").orEmpty()
                validWorkbook = contentType == XLSX_WORKBOOK_CONTENT_TYPE
                macroWorkbook = contentType.contains("macroEnabled", ignoreCase = true)
            }
        })
        if (macroWorkbook) {
            throw SpreadsheetReadException(SpreadsheetFailureReason.UNSUPPORTED_FORMAT, "不支持包含宏的 Excel 文件")
        }
        if (!validWorkbook) throw corrupt("不是有效的 .xlsx 工作簿")
    }

    private fun readSharedStrings(archive: ZipFile, requested: Set<Int>): Map<Int, String> {
        if (requested.isEmpty()) return emptyMap()
        val entry = archive.getEntry(SHARED_STRINGS_PATH) ?: throw corrupt("共享字符串表缺失")
        val result = mutableMapOf<Int, String>()
        var currentIndex = -1
        var insideItem = false
        var textDepth = 0
        var phoneticDepth = 0
        var currentLength = 0
        var current: StringBuilder? = null
        parseXml(openEntry(archive, entry), object : DefaultHandler() {
            override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes?) {
                when (elementName(localName, qName)) {
                    "si" -> {
                        currentIndex += 1
                        insideItem = true
                        currentLength = 0
                        current = if (currentIndex in requested) StringBuilder() else null
                    }
                    "rPh" -> if (insideItem) phoneticDepth += 1
                    "t" -> if (insideItem && phoneticDepth == 0) textDepth += 1
                }
            }

            override fun characters(ch: CharArray, start: Int, length: Int) {
                if (!insideItem || textDepth == 0 || phoneticDepth > 0) return
                currentLength += length
                if (currentLength > ImportLimits.MAX_CELL_CHARS) {
                    throw limitExceeded("单元格内容不能超过 ${ImportLimits.MAX_CELL_CHARS} 个字符")
                }
                current?.append(ch, start, length)
            }

            override fun endElement(uri: String?, localName: String?, qName: String?) {
                when (elementName(localName, qName)) {
                    "t" -> if (textDepth > 0) textDepth -= 1
                    "rPh" -> if (phoneticDepth > 0) phoneticDepth -= 1
                    "si" -> {
                        current?.let { result[currentIndex] = it.toString() }
                        current = null
                        insideItem = false
                    }
                }
            }
        })
        if (!result.keys.containsAll(requested)) throw corrupt("共享字符串索引越界")
        return result
    }

    private fun <T> withArchive(block: (ZipFile) -> T): T = ZipFile(file).use { archive ->
        validateArchive(archive)
        block(archive)
    }

    private fun validateArchive(archive: ZipFile) {
        var entries = 0
        var uncompressed = 0L
        val iterator = archive.entries()
        while (iterator.hasMoreElements()) {
            val entry = iterator.nextElement()
            entries += 1
            if (entries > ImportLimits.MAX_ZIP_ENTRIES) {
                throw limitExceeded("Excel 压缩包最多允许 ${ImportLimits.MAX_ZIP_ENTRIES} 个文件")
            }
            validateEntryPath(entry.name)
            if (entry.isDirectory) continue
            val size = entry.size
            val compressed = entry.compressedSize
            if (size < 0L || compressed < 0L) throw corrupt("Excel 压缩包大小信息无效")
            uncompressed = try {
                Math.addExact(uncompressed, size)
            } catch (_: ArithmeticException) {
                throw limitExceeded("Excel 解压内容过大")
            }
            if (uncompressed > ImportLimits.MAX_UNCOMPRESSED_BYTES) {
                throw limitExceeded("Excel 解压内容不能超过 128 MiB")
            }
            if (size > ZIP_RATIO_CHECK_THRESHOLD && (
                    compressed == 0L || size / compressed.coerceAtLeast(1L) > ImportLimits.MAX_ZIP_COMPRESSION_RATIO
                )
            ) {
                throw limitExceeded("Excel 压缩比异常，文件可能不安全")
            }
        }
        listOf(CONTENT_TYPES_PATH, WORKBOOK_PATH, WORKBOOK_RELS_PATH).forEach { required ->
            if (archive.getEntry(required) == null) throw corrupt("Excel 文件缺少必要组件")
        }
    }

    private fun openEntry(archive: ZipFile, path: String): InputStream {
        val entry = archive.getEntry(path) ?: throw corrupt("Excel 组件缺失：$path")
        return openEntry(archive, entry)
    }

    private fun openEntry(archive: ZipFile, entry: ZipEntry): InputStream =
        SizeLimitedInputStream(archive.getInputStream(entry), entry.size)

    private class SizeLimitedInputStream(input: InputStream, private val expectedSize: Long) : FilterInputStream(input) {
        private var count = 0L

        override fun read(): Int {
            val value = super.read()
            if (value != -1) checkedIncrement(1)
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            val read = super.read(buffer, offset, length)
            if (read > 0) checkedIncrement(read.toLong())
            return read
        }

        private fun checkedIncrement(amount: Long) {
            count += amount
            if (count > expectedSize || count > ImportLimits.MAX_UNCOMPRESSED_BYTES) {
                throw limitExceeded("Excel 组件解压大小异常")
            }
        }
    }

    private data class WorkbookSheet(val relationshipId: String, val name: String)
    private data class SheetDescriptor(val id: String, val name: String, val path: String)
    private data class RowToken(val rowNumber: Int, val token: CellToken)

    private sealed interface CellToken {
        data class Literal(val value: String) : CellToken
        data class Shared(val index: Int) : CellToken

        fun resolve(sharedStrings: Map<Int, String>): String = when (this) {
            is Literal -> value
            is Shared -> sharedStrings[index] ?: throw corrupt("共享字符串索引越界")
        }
    }

    private class PreviewTokenScan(private val sheet: SheetDescriptor) {
        private var firstRow: Map<Int, CellToken>? = null
        private val seen = BooleanArray(ImportLimits.MAX_COLUMNS)
        private val values = Array(ImportLimits.MAX_COLUMNS) { mutableListOf<CellToken>() }
        var rowCount: Int = 0
            private set

        @Suppress("UNUSED_PARAMETER")
        fun accept(rowNumber: Int, cells: Map<Int, CellToken>, presentColumns: Set<Int>) {
            rowCount += 1
            presentColumns.forEach { seen[it] = true }
            if (firstRow == null) {
                firstRow = cells.toMap()
                return
            }
            cells.forEach { (column, token) ->
                if (token is CellToken.Literal && token.value.isBlank()) return@forEach
                if (values[column].size < ImportLimits.PREVIEW_VALUE_LIMIT) values[column] += token
            }
        }

        fun sharedIndexes(): Set<Int> = buildSet {
            firstRow.orEmpty().values.forEach { if (it is CellToken.Shared) add(it.index) }
            values.forEach { tokens -> tokens.forEach { if (it is CellToken.Shared) add(it.index) } }
        }

        fun build(sharedStrings: Map<Int, String>): SpreadsheetSheetPreview {
            val headings = firstRow.orEmpty()
            val columns = seen.indices.filter { seen[it] }.map { index ->
                val firstValue = headings[index]?.resolve(sharedStrings).orEmpty()
                val firstIsPhone = PhoneNumberNormalizer.normalize(firstValue) != null
                val header = firstValue.takeIf { it.isNotBlank() && !firstIsPhone }
                val sampled = buildList {
                    if (firstIsPhone) add(firstValue)
                    values[index].asSequence()
                        .map { it.resolve(sharedStrings) }
                        .filter(String::isNotBlank)
                        .take(ImportLimits.PREVIEW_VALUE_LIMIT)
                        .forEach(::add)
                }.take(ImportLimits.PREVIEW_VALUE_LIMIT)
                SpreadsheetColumnPreview(
                    index = index,
                    letter = columnLetter(index),
                    header = header,
                    samples = sampled.take(ImportLimits.PREVIEW_SAMPLE_LIMIT),
                    validPhoneCount = sampled.count { PhoneNumberNormalizer.normalize(it) != null },
                    sampledValueCount = sampled.size,
                )
            }
            return SpreadsheetSheetPreview(sheet.id, sheet.name, rowCount, columns)
        }
    }

    private class SheetXmlHandler(
        private val onRow: (Int, Map<Int, CellToken>, Set<Int>) -> Unit,
    ) : DefaultHandler() {
        private var rowNumber = 0
        private var previousRowNumber = 0
        private var cells: MutableMap<Int, CellToken>? = null
        private var presentColumns: MutableSet<Int>? = null
        private var cellColumn = -1
        private var nextImplicitColumn = 0
        private var cellType: String? = null
        private var valueText: StringBuilder? = null
        private var inlineText: StringBuilder? = null
        private var capturingValue = false
        private var inlineDepth = 0
        private var inlineTextDepth = 0

        override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes) {
            when (elementName(localName, qName)) {
                "row" -> {
                    if (cells != null) throw corrupt("工作表行嵌套无效")
                    rowNumber = attributes.value("r")?.toIntOrNull() ?: (previousRowNumber + 1)
                    if (rowNumber <= previousRowNumber || rowNumber > ImportLimits.MAX_ROWS) {
                        throw limitExceeded("工作表行号超过限制或顺序无效")
                    }
                    cells = linkedMapOf()
                    presentColumns = linkedSetOf()
                    nextImplicitColumn = 0
                }
                "c" -> {
                    if (cells == null) throw corrupt("单元格不属于任何行")
                    cellColumn = attributes.value("r")?.let(::parseColumnReference) ?: nextImplicitColumn
                    if (cellColumn !in 0 until ImportLimits.MAX_COLUMNS) {
                        throw limitExceeded("工作表最多支持 ${ImportLimits.MAX_COLUMNS} 列")
                    }
                    nextImplicitColumn = cellColumn + 1
                    presentColumns?.add(cellColumn)
                    cellType = attributes.value("t")
                    valueText = null
                    inlineText = null
                    capturingValue = false
                    inlineDepth = 0
                    inlineTextDepth = 0
                }
                "v" -> if (cellColumn >= 0) {
                    valueText = StringBuilder()
                    capturingValue = true
                }
                "is" -> if (cellColumn >= 0) {
                    inlineDepth += 1
                    if (inlineText == null) inlineText = StringBuilder()
                }
                "t" -> if (cellColumn >= 0 && inlineDepth > 0) inlineTextDepth += 1
            }
        }

        override fun characters(ch: CharArray, start: Int, length: Int) {
            when {
                capturingValue -> appendChecked(valueText, ch, start, length)
                inlineTextDepth > 0 -> appendChecked(inlineText, ch, start, length)
            }
        }

        override fun endElement(uri: String?, localName: String?, qName: String?) {
            when (elementName(localName, qName)) {
                "v" -> capturingValue = false
                "t" -> if (inlineTextDepth > 0) inlineTextDepth -= 1
                "is" -> if (inlineDepth > 0) inlineDepth -= 1
                "c" -> {
                    cells?.set(cellColumn, createToken(cellType, valueText?.toString(), inlineText?.toString()))
                    cellColumn = -1
                }
                "row" -> {
                    val completedCells = cells ?: throw corrupt("工作表行结构无效")
                    onRow(rowNumber, completedCells, presentColumns.orEmpty())
                    previousRowNumber = rowNumber
                    cells = null
                    presentColumns = null
                }
            }
        }

        private fun appendChecked(builder: StringBuilder?, chars: CharArray, start: Int, length: Int) {
            builder ?: return
            if (builder.length + length > ImportLimits.MAX_CELL_CHARS) {
                throw limitExceeded("单元格内容不能超过 ${ImportLimits.MAX_CELL_CHARS} 个字符")
            }
            builder.append(chars, start, length)
        }

        private fun createToken(type: String?, rawValue: String?, inline: String?): CellToken {
            val raw = rawValue.orEmpty().trim()
            return when (type) {
                "s" -> {
                    val index = raw.toIntOrNull()?.takeIf { it >= 0 } ?: throw corrupt("共享字符串索引无效")
                    CellToken.Shared(index)
                }
                "inlineStr" -> CellToken.Literal(inline.orEmpty())
                "b" -> CellToken.Literal(if (raw == "1") "TRUE" else if (raw == "0") "FALSE" else raw)
                "str", "e", "d" -> CellToken.Literal(raw)
                else -> CellToken.Literal(canonicalNumericValue(raw))
            }
        }
    }

    private companion object {
        const val CONTENT_TYPES_PATH = "[Content_Types].xml"
        const val WORKBOOK_PATH = "xl/workbook.xml"
        const val WORKBOOK_RELS_PATH = "xl/_rels/workbook.xml.rels"
        const val SHARED_STRINGS_PATH = "xl/sharedStrings.xml"
        const val XLSX_WORKBOOK_CONTENT_TYPE =
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
        const val ZIP_RATIO_CHECK_THRESHOLD = 1L * 1024L * 1024L

        fun canonicalNumericValue(raw: String): String {
            if (raw.isBlank() || raw.length > 64) return raw
            return runCatching {
                val number = BigDecimal(raw).stripTrailingZeros()
                if (number.scale() > 0 || number.scale() < -16) raw
                else number.toPlainString().takeIf { it.length <= 16 } ?: raw
            }.getOrDefault(raw)
        }

        fun parseColumnReference(reference: String): Int {
            var value = 0
            var letters = 0
            var digitsStarted = false
            reference.forEach { character ->
                if (character in 'A'..'Z' || character in 'a'..'z') {
                    if (digitsStarted) throw corrupt("单元格引用无效")
                    if (letters > 0 && value >= ImportLimits.MAX_COLUMNS) throw limitExceeded("列号超过限制")
                    value = value * 26 + (character.uppercaseChar() - 'A' + 1)
                    letters += 1
                } else if (character in '0'..'9') {
                    digitsStarted = true
                } else {
                    throw corrupt("单元格引用无效")
                }
            }
            if (letters == 0 || !digitsStarted) throw corrupt("单元格引用无效")
            return value - 1
        }

        fun parseXml(input: InputStream, handler: DefaultHandler) {
            input.use {
                val factory = SAXParserFactory.newInstance().apply {
                    isNamespaceAware = true
                    isXIncludeAware = false
                    setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
                    setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
                    setFeature("http://xml.org/sax/features/external-general-entities", false)
                    setFeature("http://xml.org/sax/features/external-parameter-entities", false)
                }
                val reader = factory.newSAXParser().xmlReader
                reader.entityResolver = org.xml.sax.EntityResolver { _, _ ->
                    throw SAXException("External entities are not allowed")
                }
                reader.contentHandler = handler
                reader.errorHandler = handler
                reader.parse(InputSource(it))
            }
        }

        fun normalizeZipPath(parent: String, target: String): String {
            if (target.contains('\\')) throw corrupt("ZIP 路径无效")
            val source = if (target.startsWith('/')) target.drop(1) else "$parent/$target"
            val segments = ArrayDeque<String>()
            source.split('/').forEach { part ->
                when (part) {
                    "", "." -> Unit
                    ".." -> throw corrupt("ZIP 路径越界")
                    else -> segments.addLast(part)
                }
            }
            val normalized = segments.joinToString("/")
            if (!normalized.startsWith("xl/")) throw corrupt("工作表路径越界")
            return normalized
        }

        fun validateEntryPath(path: String) {
            if (path.startsWith('/') || path.contains('\\')) throw corrupt("ZIP 路径无效")
            path.split('/').forEach { part ->
                when (part) {
                    "", "." -> Unit
                    ".." -> throw corrupt("ZIP 路径越界")
                    else -> Unit
                }
            }
        }

        fun corrupt(message: String): SpreadsheetReadException = SpreadsheetReadException(
            SpreadsheetFailureReason.CORRUPT_FILE,
            message,
        )

        fun elementName(localName: String?, qName: String?): String =
            localName?.takeIf(String::isNotEmpty) ?: qName.orEmpty().substringAfter(':')

        fun Attributes.value(name: String): String? = getValue(name) ?: (0 until length)
            .firstOrNull { getLocalName(it) == name || getQName(it) == name }
            ?.let(::getValue)

        fun Attributes.relationshipId(): String? = (0 until length)
            .firstOrNull { getLocalName(it) == "id" && (getQName(it) == "r:id" || getURI(it).contains("relationships")) }
            ?.let(::getValue)
    }
}
