package com.company.callcenter.offline.importing

import java.io.IOException

enum class SpreadsheetFormat {
    XLSX,
    XLS,
    CSV,
    TSV,
}

data class SpreadsheetColumnPreview(
    val index: Int,
    val letter: String,
    val header: String?,
    val previewRows: List<SpreadsheetCellPreview>,
    val validPhoneCount: Int,
    val sampledValueCount: Int,
) {
    val samples: List<String>
        get() = previewRows.map { it.rawValue }

    val validRate: Double
        get() = if (sampledValueCount == 0) 0.0 else validPhoneCount.toDouble() / sampledValueCount

    val suggestsHeader: Boolean
        get() = previewRows.firstOrNull()?.normalizedPhone == null &&
            previewRows.drop(1).any { it.normalizedPhone != null }
}

data class SpreadsheetCellPreview(
    val rowNumber: Int,
    val rawValue: String,
) {
    val normalizedPhone: String?
        get() = PhoneNumberNormalizer.normalize(rawValue)
}

data class SpreadsheetSheetPreview(
    val id: String,
    val name: String,
    val rowCount: Int,
    val lastRowNumber: Int,
    val columns: List<SpreadsheetColumnPreview>,
)

data class SpreadsheetPreview(
    val format: SpreadsheetFormat,
    val sheets: List<SpreadsheetSheetPreview>,
)

data class SpreadsheetCellValue(
    val rowNumber: Int,
    val value: String,
)

data class SpreadsheetColumnData(
    val sheetId: String,
    val columnIndex: Int,
    val cells: List<SpreadsheetCellValue>,
)

enum class SpreadsheetFailureReason {
    FILE_TOO_LARGE,
    LIMIT_EXCEEDED,
    UNSUPPORTED_FORMAT,
    ENCRYPTED_FILE,
    CORRUPT_FILE,
    SHEET_NOT_FOUND,
    INVALID_COLUMN,
    INVALID_RANGE,
}

class SpreadsheetReadException(
    val reason: SpreadsheetFailureReason,
    message: String,
    cause: Throwable? = null,
) : IOException(message, cause)

internal fun columnLetter(index: Int): String {
    require(index in 0 until ImportLimits.MAX_COLUMNS)
    var remaining = index + 1
    return buildString {
        while (remaining > 0) {
            val digit = (remaining - 1) % 26
            append(('A'.code + digit).toChar())
            remaining = (remaining - 1) / 26
        }
    }.reversed()
}
