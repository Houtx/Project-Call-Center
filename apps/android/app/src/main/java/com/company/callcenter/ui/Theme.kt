package com.company.callcenter.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val CallCenterColors = lightColorScheme(
    primary = Color(0xFF155DA6),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD9E9FA),
    onPrimaryContainer = Color(0xFF123A5D),
    secondary = Color(0xFF2E6B57),
    onSecondary = Color.White,
    error = Color(0xFFB42318),
    background = Color(0xFFF5F7F9),
    surface = Color.White,
    surfaceVariant = Color(0xFFE9EEF2),
    outline = Color(0xFFBAC4CC),
)

@Composable
fun CallCenterTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = CallCenterColors, content = content)
}
