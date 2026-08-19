package com.company.callcenter.offline.importing

internal class PreviewAccumulator(
    private val sheetId: String,
    private val sheetName: String,
) {
    private var firstRow: List<String>? = null
    private val seenColumns = BooleanArray(ImportLimits.MAX_COLUMNS)
    private val previewValues = Array(ImportLimits.MAX_COLUMNS) { mutableListOf<String>() }
    private var rows = 0

    fun accept(values: List<String>) {
        rows += 1
        if (rows > ImportLimits.MAX_ROWS) {
            throw limitExceeded("工作表最多支持 ${ImportLimits.MAX_ROWS} 行")
        }
        if (values.size > ImportLimits.MAX_COLUMNS) {
            throw limitExceeded("工作表最多支持 ${ImportLimits.MAX_COLUMNS} 列")
        }
        values.forEachIndexed { index, value ->
            validateCell(value)
            seenColumns[index] = true
        }
        if (firstRow == null) {
            firstRow = values.toList()
            return
        }
        values.forEachIndexed { index, value ->
            if (value.isNotBlank() && previewValues[index].size < ImportLimits.PREVIEW_VALUE_LIMIT) {
                previewValues[index] += value
            }
        }
    }

    fun build(): SpreadsheetSheetPreview {
        val heading = firstRow.orEmpty()
        val columns = seenColumns.indices.filter { seenColumns[it] }.map { index ->
            val firstValue = heading.getOrNull(index).orEmpty()
            val firstIsPhone = PhoneNumberNormalizer.normalize(firstValue) != null
            val header = firstValue.takeIf { it.isNotBlank() && !firstIsPhone }
            val sampled = buildList {
                if (firstIsPhone) add(firstValue)
                addAll(previewValues[index])
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
        return SpreadsheetSheetPreview(sheetId, sheetName, rows, columns)
    }
}

internal fun validateCell(value: String) {
    if (value.length > ImportLimits.MAX_CELL_CHARS) {
        throw limitExceeded("单元格内容不能超过 ${ImportLimits.MAX_CELL_CHARS} 个字符")
    }
}

internal fun limitExceeded(message: String): SpreadsheetReadException = SpreadsheetReadException(
    SpreadsheetFailureReason.LIMIT_EXCEEDED,
    message,
)
