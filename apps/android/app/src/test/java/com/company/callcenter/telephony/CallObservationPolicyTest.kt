package com.company.callcenter.telephony

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallObservationPolicyTest {
    @Test
    fun `positive duration is connected`() {
        assertEquals("CONNECTED", CallObservationPolicy.classify(1))
        assertEquals("CONNECTED", CallObservationPolicy.classify(90))
    }

    @Test
    fun `zero and invalid negative duration are not connected`() {
        assertEquals("NOT_CONNECTED", CallObservationPolicy.classify(0))
        assertEquals("NOT_CONNECTED", CallObservationPolicy.classify(-1))
    }

    @Test
    fun `collection expires at the deadline`() {
        assertFalse(CallObservationPolicy.isCollectionExpired(999, 1_000))
        assertTrue(CallObservationPolicy.isCollectionExpired(1_000, 1_000))
        assertTrue(CallObservationPolicy.isCollectionExpired(1_001, 1_000))
    }
}
