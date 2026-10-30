package com.clawdbot.android.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

@Composable
fun MoltbotTheme(content: @Composable () -> Unit) {
  val context = LocalContext.current
  val isDark = isSystemInDarkTheme()
  val colorScheme =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (isDark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else if (isDark) {
      darkColorScheme(
        primary = Color(0xFFFFD36E),
        onPrimary = Color(0xFF1C1200),
        background = Color(0xFF050403),
        onBackground = Color(0xFFFFF7E8),
        surface = Color(0xFF17120B),
        onSurface = Color(0xFFFFF7E8),
        surfaceVariant = Color(0xFF2A2114),
        onSurfaceVariant = Color(0xFFD3C3A1),
      )
    } else {
      lightColorScheme(
        primary = Color(0xFF7B4C0B),
        onPrimary = Color.White,
        background = Color(0xFFFFFBF3),
        onBackground = Color(0xFF17120B),
        surface = Color(0xFFFFF5DE),
        onSurface = Color(0xFF17120B),
        surfaceVariant = Color(0xFFE9D8B8),
        onSurfaceVariant = Color(0xFF4D402B),
      )
    }

  MaterialTheme(colorScheme = colorScheme, content = content)
}

@Composable
fun overlayContainerColor(): Color {
  val scheme = MaterialTheme.colorScheme
  val isDark = isSystemInDarkTheme()
  val base = if (isDark) scheme.surfaceContainerLow else scheme.surfaceContainerHigh
  // Light mode: background stays dark (canvas), so clamp overlays away from pure-white glare.
  return if (isDark) base else base.copy(alpha = 0.88f)
}

@Composable
fun overlayIconColor(): Color {
  return MaterialTheme.colorScheme.onSurfaceVariant
}
