package com.company.callcenter.data.offline

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflinePasswordHasherTest {
    private val hasher = OfflinePasswordHasher()

    @Test
    fun `password verifier accepts the original and rejects a different value`() {
        val record = hasher.create("secure-123")

        assertTrue(hasher.verify("secure-123", record))
        assertFalse(hasher.verify("secure-124", record))
        assertFalse(hasher.verify("short", record))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `password must contain at least six characters`() {
        hasher.create("12345")
    }
}
