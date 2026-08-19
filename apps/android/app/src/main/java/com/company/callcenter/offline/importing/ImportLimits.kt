package com.company.callcenter.offline.importing

internal object ImportLimits {
    const val MAX_FILE_BYTES = 25L * 1024L * 1024L
    const val MAX_ROWS = 100_000
    const val MAX_PHYSICAL_ROW = 1_048_576
    const val MAX_COLUMNS = 16_384
    const val MAX_CELL_CHARS = 4 * 1024
    const val MAX_ZIP_ENTRIES = 4_096
    const val MAX_UNCOMPRESSED_BYTES = 512L * 1024L * 1024L
    const val MAX_ZIP_COMPRESSION_RATIO = 1_000L
    const val PREVIEW_SAMPLE_LIMIT = 20
    const val MAX_PASTE_CHARS = 1 * 1024 * 1024
}
