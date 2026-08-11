package com.company.callcenter.data

import com.company.callcenter.data.local.AssignedCustomerEntity

object AssignmentQueuePolicy {
    fun order(items: List<AssignedCustomerEntity>): List<AssignedCustomerEntity> =
        items.sortedWith(
            compareBy<AssignedCustomerEntity> { it.lastCalledAt != null }
                .thenBy { it.lastCalledAt ?: Long.MIN_VALUE }
                .thenByDescending { it.updatedAt },
        )
}
