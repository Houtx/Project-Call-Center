package com.company.callcenter.offline.importing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PastePhoneParserTest {
    @Test
    fun `parses mixed delimiters deduplicates and preserves first order`() {
        val result = PastePhoneParser.parse(
            "13800138000\n+86 13900139000\t无效，138-0013-8000；",
        )

        assertEquals(listOf("13800138000", "13900139000"), result.numbers)
        assertEquals(2, result.validCount)
        assertEquals(1, result.invalidCount)
        assertEquals(1, result.duplicateCount)
        assertEquals(1, result.blankCount)
    }

    @Test
    fun `counts consecutive and empty tokens`() {
        val result = PastePhoneParser.parse("\r\n,；")
        assertEquals(emptyList<String>(), result.numbers)
        assertEquals(0, result.invalidCount)
        assertEquals(4, result.blankCount)
    }

    @Test
    fun `rejects oversized paste before parsing`() {
        assertThrows(IllegalArgumentException::class.java) {
            PastePhoneParser.parse("1".repeat(ImportLimits.MAX_PASTE_CHARS + 1))
        }
    }
}
