package com.company.callcenter.offline.importing

internal class PreviewAccumulator(
    private val sheetId: String,
    private val sheetName: String,
) {
    private val seenColumns = linkedSetOf<Int>()
    private val previewRows = mutableListOf<Pair<Int, List<String>>>()
    private var rows = 0
    private var lastRowNumber = 0

    fun accept(values: List<String>) = accept(rows + 1, values)

    fun accept(rowNumber: Int, values: List<String>) {
        rows += 1
        lastRowNumber = maxOf(lastRowNumber, rowNumber)
        if (rows > ImportLimits.MAX_ROWS) {
            throw limitExceeded("工作表最多支持 ${ImportLimits.MAX_ROWS} 行")
        }
        if (values.size > ImportLimits.MAX_COLUMNS) {
            throw limitExceeded("工作表最多支持 ${ImportLimits.MAX_COLUMNS} 列")
        }
        values.forEachIndexed { index, value ->
            validateCell(value)
            seenColumns += index
        }
        if (previewRows.size < ImportLimits.PREVIEW_SAMPLE_LIMIT) {
            previewRows += rows to values.toList()
        }
    }

    fun build(): SpreadsheetSheetPreview {
        val firstRow = previewRows.firstOrNull()?.second.orEmpty()
        val columns = seenColumns.sorted().map { index ->
            val firstValue = firstRow.getOrNull(index).orEmpty()
            val firstIsPhone = PhoneNumberNormalizer.normalize(firstValue) != null
            val sampled = previewRows.mapNotNull { (_, values) ->
                values.getOrNull(index)?.takeIf(String::isNotBlank)
            }
            SpreadsheetColumnPreview(
                index = index,
                letter = columnLetter(index),
                header = firstValue.takeIf { it.isNotBlank() && !firstIsPhone },
                previewRows = previewRows.map { (rowNumber, values) ->
                    SpreadsheetCellPreview(rowNumber, values.getOrNull(index).orEmpty())
                },
                validPhoneCount = sampled.count { PhoneNumberNormalizer.normalize(it) != null },
                sampledValueCount = sampled.size,
            )
        }
        return SpreadsheetSheetPreview(sheetId, sheetName, rows, lastRowNumber, columns)
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
