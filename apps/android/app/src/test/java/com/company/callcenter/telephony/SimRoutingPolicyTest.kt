package com.company.callcenter.telephony

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SimRoutingPolicyTest {
    @Test
    fun `numeric Samsung phone account id maps directly to active subscription`() {
        assertEquals(
            4,
            SimRoutingPolicy.matchPhoneAccountSubscriptionId("4", setOf(4, 2)),
        )
        assertNull(SimRoutingPolicy.matchPhoneAccountSubscriptionId("9", setOf(4, 2)))
        assertNull(SimRoutingPolicy.matchPhoneAccountSubscriptionId("not-a-subscription", setOf(4, 2)))
    }

    @Test
    fun `returns no route when no SIM is available`() {
        assertNull(SimRoutingPolicy.select(SimDialMode.SIM_1, emptyList(), 0))
        assertEquals(false, SimDialState().canDial)
        assertEquals(true, SimDialState(systemManagedRouting = true).canDial)
    }

    @Test
    fun `single SIM always uses the only available slot`() {
        listOf(0, 1).forEach { onlySlot ->
            SimDialMode.entries.forEach { mode ->
                val decision = SimRoutingPolicy.select(mode, listOf(onlySlot), 0)
                assertEquals(onlySlot, decision?.slotIndex)
            }
        }
    }

    @Test
    fun `fixed modes select their matching physical slots`() {
        assertEquals(0, SimRoutingPolicy.select(SimDialMode.SIM_1, listOf(0, 1), 1)?.slotIndex)
        assertEquals(1, SimRoutingPolicy.select(SimDialMode.SIM_2, listOf(0, 1), 0)?.slotIndex)
    }

    @Test
    fun `alternate mode switches the next slot after each selection`() {
        val first = SimRoutingPolicy.select(SimDialMode.ALTERNATE, listOf(0, 1), 0)
        val second = SimRoutingPolicy.select(
            SimDialMode.ALTERNATE,
            listOf(0, 1),
            first!!.nextAlternateSlotIndex,
        )

        assertEquals(0, first.slotIndex)
        assertEquals(1, first.nextAlternateSlotIndex)
        assertEquals(1, second?.slotIndex)
        assertEquals(0, second?.nextAlternateSlotIndex)
    }

    @Test
    fun `invalid saved mode falls back to SIM 1`() {
        assertEquals(SimDialMode.SIM_1, SimDialMode.fromStorage("invalid"))
    }
}
