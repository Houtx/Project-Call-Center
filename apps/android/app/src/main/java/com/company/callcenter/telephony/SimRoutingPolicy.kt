package com.company.callcenter.telephony

enum class SimDialMode(val storageValue: String) {
    SIM_1("SIM_1"),
    SIM_2("SIM_2"),
    ALTERNATE("ALTERNATE");

    companion object {
        fun fromStorage(value: String?): SimDialMode =
            entries.firstOrNull { it.storageValue == value } ?: SIM_1
    }
}

data class SimRouteDecision(
    val slotIndex: Int,
    val nextAlternateSlotIndex: Int,
)

object SimRoutingPolicy {
    fun matchPhoneAccountSubscriptionId(
        phoneAccountId: String,
        activeSubscriptionIds: Set<Int>,
    ): Int? = phoneAccountId.toIntOrNull()?.takeIf { it in activeSubscriptionIds }

    fun select(
        mode: SimDialMode,
        availableSlotIndexes: List<Int>,
        nextAlternateSlotIndex: Int,
    ): SimRouteDecision? {
        val available = availableSlotIndexes.distinct().filter { it >= 0 }.sorted()
        if (available.isEmpty()) return null
        if (available.size == 1) {
            return SimRouteDecision(available.single(), nextAlternateSlotIndex)
        }

        val selectedSlot = when (mode) {
            SimDialMode.SIM_1 -> available.firstOrNull { it == 0 } ?: available.first()
            SimDialMode.SIM_2 -> available.firstOrNull { it == 1 } ?: available.first()
            SimDialMode.ALTERNATE -> {
                available.firstOrNull { it == nextAlternateSlotIndex } ?: available.first()
            }
        }
        val nextSlot = if (mode == SimDialMode.ALTERNATE) {
            available.first { it != selectedSlot }
        } else {
            nextAlternateSlotIndex
        }
        return SimRouteDecision(selectedSlot, nextSlot)
    }
}
