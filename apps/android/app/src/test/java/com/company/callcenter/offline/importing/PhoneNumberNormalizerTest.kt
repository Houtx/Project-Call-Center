package com.company.callcenter.offline.importing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneNumberNormalizerTest {
    @Test
    fun `normalizes supported mainland mobile forms`() {
        val expected = "13800138000"
        listOf(
            expected,
            "+86 138 0013 8000",
            "0086-138-0013-8000",
            "（138）0013-8000",
            "１３８００１３８０００",
            "1.3800138E10",
        ).forEach { assertEquals(it, expected, PhoneNumberNormalizer.normalize(it)) }
    }

    @Test
    fun `rejects non-mobile and ambiguous values`() {
        listOf(
            "12800138000",
            "010-88888888",
            "1380013800",
            "138001380000",
            "+1 3800138000",
            "13800138000.5",
            "13800138000 转 2",
            "13800138000 13900139000",
            "1E999999",
        ).forEach { assertNull(it, PhoneNumberNormalizer.normalize(it)) }
    }
}
