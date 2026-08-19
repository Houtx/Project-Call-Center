package com.company.callcenter.offline.importing

import java.math.BigDecimal
import java.text.Normalizer

object PhoneNumberNormalizer {
    private val elevenDigits = Regex("^\\d{11}$")
    private val numericCell = Regex("^(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$")

    /** Returns an 11-digit phone number, or null when the normalized value has another length. */
    fun normalize(value: String): String? {
        if (value.isBlank() || value.length > ImportLimits.MAX_CELL_CHARS) return null
        val normalized = Normalizer.normalize(value, Normalizer.Form.NFKC)
        val compact = buildString(normalized.length) {
            normalized.forEach { character ->
                when {
                    character.isWhitespace() || Character.isSpaceChar(character) -> Unit
                    character == '-' || character == '(' || character == ')' -> Unit
                    else -> append(character)
                }
            }
        }
        val withoutCountryCode = when {
            compact.startsWith("+86") -> compact.drop(3)
            compact.startsWith("0086") -> compact.drop(4)
            else -> compact
        }
        val digits = when {
            withoutCountryCode.all { it in '0'..'9' } -> withoutCountryCode
            numericCell.matches(withoutCountryCode) -> integralNumericValue(withoutCountryCode) ?: return null
            else -> return null
        }
        return digits.takeIf(elevenDigits::matches)
    }

    private fun integralNumericValue(value: String): String? {
        if (value.length > 64) return null
        return runCatching {
            val decimal = BigDecimal(value).stripTrailingZeros()
            if (decimal.scale() > 0 || decimal.scale() < -16 || decimal.signum() < 0) return null
            decimal.toPlainString().takeIf { it.length <= 16 }
        }.getOrNull()
    }
}
