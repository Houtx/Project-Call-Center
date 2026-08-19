package com.company.callcenter.offline.importing

import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.SAXException
import org.xml.sax.helpers.DefaultHandler
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.math.BigDecimal
import java.nio.charset.StandardCharsets
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

    fun readColumn(
        sheetId: String,
        columnIndex: Int,
        skipHeader: Boolean,
        startRow: Int,
        endRowInclusive: Int?,
        limit: Int?,
        onRowRead: (rowNumber: Int) -> Unit,
    ): SpreadsheetColumnData =
        withArchive { archive ->
            val sheet = readWorkbook(archive).firstOrNull { it.id == sheetId }
                ?: throw SpreadsheetReadException(SpreadsheetFailureReason.SHEET_NOT_FOUND, "找不到所选工作表")
            val tokens = ArrayList<RowToken>()
            var first = true
            parseSheet(archive, sheet) { rowNumber, cells, _ ->
                onRowRead(rowNumber)
                val skip = first && skipHeader
                first = false
                if (!skip && rowNumber >= startRow && (endRowInclusive == null || rowNumber <= endRowInclusive)) {
                    tokens += RowToken(rowNumber, cells[columnIndex] ?: CellToken.Literal(""))
                }
                (endRowInclusive == null || rowNumber < endRowInclusive) && (limit == null || tokens.size < limit)
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
        parseSheet(archive, sheet) { rowNumber, cells, columns ->
            scan.accept(rowNumber, cells, columns)
            true
        }
        return scan
    }

    private fun parseSheet(
        archive: ZipFile,
        sheet: SheetDescriptor,
        onRow: (Int, Map<Int, CellToken>, Set<Int>) -> Boolean,
    ) {
        try {
            parseXml(openEntry(archive, sheet.path), SheetXmlHandler(onRow))
        } catch (_: StopSheetParsing) {
            // The requested range or preview limit is complete.
        }
    }

    private fun readWorkbook(archive: ZipFile): List<SheetDescriptor> {
        validateContentTypes(archive)
        val workbookEntry = archive.workbookEntry() ?: throw corrupt("Excel 文件缺少工作簿组件")
        val workbookDirectory = workbookEntry.name.substringBeforeLast('/', missingDelimiterValue = "")
        val workbookSheets = mutableListOf<WorkbookSheet>()
        parseXml(openEntry(archive, workbookEntry), object : DefaultHandler() {
            override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes) {
                if (elementName(localName, qName) != "sheet") return
                val name = attributes.value("name")?.takeIf(String::isNotBlank)
                    ?: "工作表 ${workbookSheets.size + 1}"
                validateCell(name)
                workbookSheets += WorkbookSheet(
                    relationshipId = attributes.relationshipId(),
                    sheetId = attributes.value("sheetId"),
                    name = name,
                )
            }
        })
        if (workbookSheets.isEmpty()) throw corrupt("Excel 文件不包含工作表")

        val relationships = mutableMapOf<String, String>()
        val workbookRelationshipsPath = listOfNotNull(
            workbookDirectory.takeIf(String::isNotEmpty),
            "_rels",
            "${workbookEntry.name.substringAfterLast('/')}.rels",
        ).joinToString("/")
        archive.findEntry(workbookRelationshipsPath)?.let { relationshipsEntry ->
            parseXml(openEntry(archive, relationshipsEntry), object : DefaultHandler() {
                override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes) {
                    if (elementName(localName, qName) != "Relationship") return
                    val type = attributes.value("Type").orEmpty()
                    val target = attributes.value("Target").orEmpty()
                    if (!type.endsWith("/worksheet") && !target.contains("worksheet", ignoreCase = true)) return
                    if (attributes.value("TargetMode")?.equals("External", ignoreCase = true) == true) return
                    val id = attributes.value("Id") ?: return
                    if (target.isBlank()) return
                    relationships[id] = normalizeZipPath(workbookDirectory, target)
                }
            })
        }
        return workbookSheets.mapIndexedNotNull { index, sheet ->
            val candidates = listOfNotNull(
                sheet.relationshipId?.let(relationships::get),
                sheet.sheetId?.let { "$workbookDirectory/worksheets/sheet$it.xml".trimStart('/') },
                "$workbookDirectory/worksheets/sheet${index + 1}.xml".trimStart('/'),
            ).distinct()
            val entry = candidates.firstNotNullOfOrNull { archive.findEntry(it) } ?: return@mapIndexedNotNull null
            SheetDescriptor(sheet.relationshipId ?: sheet.sheetId ?: entry.name, sheet.name, entry.name)
        }.ifEmpty {
            throw corrupt("Excel 文件不包含可读取的工作表")
        }
    }

    private fun validateContentTypes(archive: ZipFile) {
        val entry = archive.findEntry(CONTENT_TYPES_PATH) ?: return
        var workbookIsXml = false
        parseXml(openEntry(archive, entry), object : DefaultHandler() {
            override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes) {
                if (elementName(localName, qName) != "Override") return
                if (!attributes.value("PartName").orEmpty().trimStart('/').equals(WORKBOOK_PATH, ignoreCase = true)) return
                val contentType = attributes.value("ContentType").orEmpty()
                workbookIsXml = contentType.endsWith("+xml", ignoreCase = true)
            }
        })
        if (!workbookIsXml && archive.workbookEntry() == null) {
            throw corrupt("不是可读取的 Excel XML 工作簿")
        }
    }

    private fun readSharedStrings(archive: ZipFile, requested: Set<Int>): Map<Int, String> {
        if (requested.isEmpty()) return emptyMap()
        val entry = archive.findEntry(SHARED_STRINGS_PATH)
            ?: archive.entries().asSequence().firstOrNull { it.name.endsWith("/sharedStrings.xml", ignoreCase = true) }
            ?: return emptyMap()
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
                throw limitExceeded("Excel 解压内容不能超过 512 MiB")
            }
            if (size > ZIP_RATIO_CHECK_THRESHOLD && (
                    compressed == 0L || size / compressed.coerceAtLeast(1L) > ImportLimits.MAX_ZIP_COMPRESSION_RATIO
                )
            ) {
                throw limitExceeded("Excel 压缩比异常，文件可能不安全")
            }
        }
        if (archive.workbookEntry() == null) throw corrupt("Excel 文件缺少工作簿组件")
    }

    private fun openEntry(archive: ZipFile, path: String): InputStream {
        val entry = archive.findEntry(path) ?: throw corrupt("Excel 组件缺失：$path")
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

    private class DoctypeRejectingInputStream(input: InputStream) : FilterInputStream(input) {
        private val matches = IntArray(DOCTYPE_MARKERS.size)

        override fun read(): Int {
            val value = super.read()
            if (value != -1) inspect(value.toByte())
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            val count = super.read(buffer, offset, length)
            if (count > 0) {
                for (index in offset until offset + count) inspect(buffer[index])
            }
            return count
        }

        private fun inspect(value: Byte) {
            DOCTYPE_MARKERS.forEachIndexed { index, marker ->
                val matched = matches[index]
                matches[index] = when {
                    value == marker[matched] -> matched + 1
                    value == marker[0] -> 1
                    else -> 0
                }
                if (matches[index] == marker.size) throw corrupt("Excel XML 不允许 DOCTYPE")
            }
        }
    }

    private data class WorkbookSheet(val relationshipId: String?, val sheetId: String?, val name: String)
    private data class SheetDescriptor(val id: String, val name: String, val path: String)
    private data class RowToken(val rowNumber: Int, val token: CellToken)

    private sealed interface CellToken {
        data class Literal(val value: String) : CellToken
        data class Shared(val index: Int) : CellToken

        fun resolve(sharedStrings: Map<Int, String>): String = when (this) {
            is Literal -> value
            is Shared -> sharedStrings[index].orEmpty()
        }
    }

    private class PreviewTokenScan(private val sheet: SheetDescriptor) {
        private val seen = linkedSetOf<Int>()
        private val previewRows = mutableListOf<Pair<Int, Map<Int, CellToken>>>()
        var rowCount: Int = 0
            private set
        var lastRowNumber: Int = 0
            private set

        fun accept(rowNumber: Int, cells: Map<Int, CellToken>, presentColumns: Set<Int>) {
            rowCount += 1
            lastRowNumber = maxOf(lastRowNumber, rowNumber)
            seen += presentColumns
            if (previewRows.size < ImportLimits.PREVIEW_SAMPLE_LIMIT) previewRows += rowNumber to cells.toMap()
        }

        fun sharedIndexes(): Set<Int> = buildSet {
            previewRows.forEach { (_, cells) ->
                cells.values.forEach { if (it is CellToken.Shared) add(it.index) }
            }
        }

        fun build(sharedStrings: Map<Int, String>): SpreadsheetSheetPreview {
            val headings = previewRows.firstOrNull()?.second.orEmpty()
            val columns = seen.sorted().map { index ->
                val firstValue = headings[index]?.resolve(sharedStrings).orEmpty()
                val firstIsPhone = PhoneNumberNormalizer.normalize(firstValue) != null
                val header = firstValue.takeIf { it.isNotBlank() && !firstIsPhone }
                val sampled = previewRows.mapNotNull { (_, cells) ->
                    cells[index]?.resolve(sharedStrings)?.takeIf(String::isNotBlank)
                }
                SpreadsheetColumnPreview(
                    index = index,
                    letter = columnLetter(index),
                    header = header,
                    previewRows = previewRows.map { (rowNumber, cells) ->
                        SpreadsheetCellPreview(rowNumber, cells[index]?.resolve(sharedStrings).orEmpty())
                    },
                    validPhoneCount = sampled.count { PhoneNumberNormalizer.normalize(it) != null },
                    sampledValueCount = sampled.size,
                )
            }
            return SpreadsheetSheetPreview(sheet.id, sheet.name, rowCount, lastRowNumber, columns)
        }
    }

    private class SheetXmlHandler(
        private val onRow: (Int, Map<Int, CellToken>, Set<Int>) -> Boolean,
    ) : DefaultHandler() {
        private var rowNumber = 0
        private var parsedRowCount = 0
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
                    parsedRowCount += 1
                    if (parsedRowCount > ImportLimits.MAX_ROWS) throw limitExceeded("工作表最多支持 ${ImportLimits.MAX_ROWS} 行")
                    val explicitRow = attributes.value("r")?.toIntOrNull()
                    rowNumber = explicitRow
                        ?.takeIf { it in (rowNumber + 1)..ImportLimits.MAX_PHYSICAL_ROW }
                        ?: (rowNumber + 1)
                    cells = linkedMapOf()
                    presentColumns = linkedSetOf()
                    nextImplicitColumn = 0
                }
                "c" -> {
                    if (cells == null) throw corrupt("单元格不属于任何行")
                    cellColumn = attributes.value("r")
                        ?.let { reference -> runCatching { parseColumnReference(reference) }.getOrNull() }
                        ?: nextImplicitColumn
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
                    val continueReading = onRow(rowNumber, completedCells, presentColumns.orEmpty())
                    cells = null
                    presentColumns = null
                    if (!continueReading) throw StopSheetParsing()
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
                    raw.toIntOrNull()?.takeIf { it >= 0 }?.let { CellToken.Shared(it) } ?: CellToken.Literal(raw)
                }
                "inlineStr" -> CellToken.Literal(inline.orEmpty())
                "b" -> CellToken.Literal(if (raw == "1") "TRUE" else if (raw == "0") "FALSE" else raw)
                "str", "e", "d" -> CellToken.Literal(raw)
                else -> CellToken.Literal(canonicalNumericValue(raw))
            }
        }
    }

    private class StopSheetParsing : RuntimeException(null, null, false, false)

    private companion object {
        const val CONTENT_TYPES_PATH = "[Content_Types].xml"
        const val WORKBOOK_PATH = "xl/workbook.xml"
        const val SHARED_STRINGS_PATH = "xl/sharedStrings.xml"
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
                if (character == '$') return@forEach
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
                    runCatching { isXIncludeAware = false }
                    setFeatureIfSupported(XMLConstants.FEATURE_SECURE_PROCESSING, true)
                    setFeatureIfSupported("http://apache.org/xml/features/disallow-doctype-decl", true)
                    setFeatureIfSupported("http://xml.org/sax/features/external-general-entities", false)
                    setFeatureIfSupported("http://xml.org/sax/features/external-parameter-entities", false)
                }
                val reader = factory.newSAXParser().xmlReader
                reader.entityResolver = org.xml.sax.EntityResolver { _, _ ->
                    throw SAXException("External entities are not allowed")
                }
                reader.contentHandler = handler
                reader.errorHandler = handler
                reader.parse(InputSource(DoctypeRejectingInputStream(it)))
            }
        }

        fun normalizeZipPath(parent: String, target: String): String {
            if (target.contains('\\')) throw corrupt("ZIP 路径无效")
            val segments = ArrayDeque<String>()
            if (!target.startsWith('/')) {
                parent.split('/').filter(String::isNotBlank).forEach(segments::addLast)
            }
            target.trimStart('/').split('/').forEach { part ->
                when (part) {
                    "", "." -> Unit
                    ".." -> if (segments.isEmpty()) throw corrupt("ZIP 路径越界") else segments.removeLast()
                    else -> segments.addLast(part)
                }
            }
            val normalized = segments.joinToString("/")
            if (normalized.isBlank()) throw corrupt("ZIP 路径无效")
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
            .firstOrNull {
                getLocalName(it) == "id" &&
                    (getQName(it) == "r:id" || getURI(it).orEmpty().contains("relationships"))
            }
            ?.let(::getValue)

        fun SAXParserFactory.setFeatureIfSupported(name: String, value: Boolean) {
            runCatching { setFeature(name, value) }
        }

        val DOCTYPE_MARKERS = listOf(
            "<!DOCTYPE".toByteArray(StandardCharsets.US_ASCII),
            "<!DOCTYPE".toByteArray(StandardCharsets.UTF_16BE),
            "<!DOCTYPE".toByteArray(StandardCharsets.UTF_16LE),
        )

        fun ZipFile.findEntry(path: String): ZipEntry? = getEntry(path) ?: entries().asSequence()
            .firstOrNull { it.name.equals(path, ignoreCase = true) }

        fun ZipFile.workbookEntry(): ZipEntry? = findEntry(WORKBOOK_PATH) ?: entries().asSequence()
            .firstOrNull { entry ->
                !entry.isDirectory &&
                    (entry.name.equals("workbook.xml", ignoreCase = true) ||
                        entry.name.endsWith("/workbook.xml", ignoreCase = true))
            }
    }
}
