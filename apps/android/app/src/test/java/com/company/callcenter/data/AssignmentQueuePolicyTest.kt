package com.company.callcenter.data

import com.company.callcenter.data.local.AssignedCustomerEntity
import org.junit.Assert.assertEquals
import org.junit.Test

class AssignmentQueuePolicyTest {
    @Test
    fun `an unsuccessful call moves behind every uncalled task`() {
        val result = AssignmentQueuePolicy.order(
            listOf(
                assignment("called-now", lastCalledAt = 3_000),
                assignment("uncalled-new", updatedAt = 2_000),
                assignment("called-before", lastCalledAt = 1_000),
                assignment("uncalled-old", updatedAt = 1_000),
            ),
        )

        assertEquals(
            listOf("uncalled-new", "uncalled-old", "called-before", "called-now"),
            result.map { it.assignmentId },
        )
    }

    private fun assignment(
        id: String,
        lastCalledAt: Long? = null,
        updatedAt: Long = 0,
    ) = AssignedCustomerEntity(
        assignmentId = id,
        customerId = "customer-$id",
        name = id,
        phoneMasked = "138****0000",
        batchName = null,
        province = null,
        city = null,
        carrier = null,
        notes = null,
        tags = "",
        attemptCount = if (lastCalledAt == null) 0 else 1,
        nextCallAllowedAt = null,
        lastCalledAt = lastCalledAt,
        state = "READY",
        updatedAt = updatedAt,
    )
}
