package com.company.callcenter.data.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ApiProblemParserTest {
    @Test
    fun `parses service problem details`() {
        val problem = ApiProblemParser.parse(
            """{"code":"DEVICE_NOT_ALLOWLISTED","detail":"该品牌、型号和 Android 版本未通过兼容性验证"}""",
        )

        assertEquals("DEVICE_NOT_ALLOWLISTED", problem.code)
        assertEquals("该品牌、型号和 Android 版本未通过兼容性验证", problem.detail)
    }

    @Test
    fun `ignores non-json error pages`() {
        val problem = ApiProblemParser.parse("<html>Forbidden</html>")

        assertNull(problem.code)
        assertNull(problem.detail)
    }

    @Test
    fun `rejects oversized details and uses the known code message`() {
        val problem = ApiProblemParser.parse(
            """{"code":"DEVICE_NOT_ALLOWLISTED","detail":"${"x".repeat(501)}"}""",
        )

        assertNull(problem.detail)
        assertEquals(
            "当前机型未通过兼容性验证",
            ApiProblemParser.userMessage(statusCode = 403, problem),
        )
    }
}
