package com.company.callcenter.offline.importing

internal object ImportLimits {
    const val MAX_FILE_BYTES = 25L * 1024L * 1024L
    const val MAX_ROWS = 100_000
    const val MAX_COLUMNS = 256
    const val MAX_CELL_CHARS = 4 * 1024
    const val MAX_ZIP_ENTRIES = 512
    const val MAX_UNCOMPRESSED_BYTES = 128L * 1024L * 1024L
    const val MAX_ZIP_COMPRESSION_RATIO = 200L
    const val PREVIEW_VALUE_LIMIT = 50
    const val PREVIEW_SAMPLE_LIMIT = 5
    const val MAX_PASTE_CHARS = 1 * 1024 * 1024
}
