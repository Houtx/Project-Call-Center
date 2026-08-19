package com.company.callcenter.offline.importing

data class PastePhoneParseResult(
    val numbers: List<String>,
    val invalidCount: Int,
    val blankCount: Int,
    val duplicateCount: Int,
) {
    val validCount: Int get() = numbers.size
}

object PastePhoneParser {
    fun parse(input: String): PastePhoneParseResult {
        require(input.length <= ImportLimits.MAX_PASTE_CHARS) {
            "粘贴内容不能超过 ${ImportLimits.MAX_PASTE_CHARS} 个字符"
        }
        val unique = LinkedHashSet<String>()
        var invalid = 0
        var blank = 0
        var duplicate = 0

        tokenize(input).forEach { token ->
            val trimmed = token.trim()
            if (trimmed.isEmpty()) {
                blank += 1
                return@forEach
            }
            val phone = PhoneNumberNormalizer.normalize(trimmed)
            if (phone == null) {
                invalid += 1
            } else if (!unique.add(phone)) {
                duplicate += 1
            }
        }
        return PastePhoneParseResult(unique.toList(), invalid, blank, duplicate)
    }

    private fun tokenize(input: String): Sequence<String> = sequence {
        val token = StringBuilder()
        var index = 0
        while (index < input.length) {
            val character = input[index]
            if (isDelimiter(character)) {
                yield(token.toString())
                token.setLength(0)
                if (character == '\r' && input.getOrNull(index + 1) == '\n') index += 1
            } else {
                token.append(character)
            }
            index += 1
        }
        yield(token.toString())
    }

    private fun isDelimiter(character: Char): Boolean = when (character) {
        '\r', '\n', '\t', ',', ';', '，', '；', '、' -> true
        else -> false
    }
}
