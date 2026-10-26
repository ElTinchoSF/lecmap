package com.notasia.clone

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Bg = Color(0xFF0B1220)
val Surface1 = Color(0xFF111A2B)
val Surface2 = Color(0xFF16223A)
val BorderCol = Color(0xFF243149)
val TextPrimary = Color(0xFFE6EDF7)
val TextSecondary = Color(0xFF9FB0C9)
val Accent = Color(0xFF38BDF8)
val Accent2 = Color(0xFF818CF8)
val GreenOk = Color(0xFF34D399)
val Danger = Color(0xFFF87171)
val OnAccent = Color(0xFF08111F)

val BranchColors = listOf(
  Color(0xFF38BDF8),
  Color(0xFF818CF8),
  Color(0xFF34D399),
  Color(0xFFFBBF24),
  Color(0xFFF472B6),
  Color(0xFF22D3EE),
)

@Composable
fun inputColors() = OutlinedTextFieldDefaults.colors(
  focusedBorderColor = Accent,
  unfocusedBorderColor = BorderCol,
  focusedTextColor = TextPrimary,
  unfocusedTextColor = TextPrimary,
  focusedLabelColor = Accent,
  unfocusedLabelColor = TextSecondary,
  cursorColor = Accent,
  focusedContainerColor = Surface1,
  unfocusedContainerColor = Surface1,
)

@Composable
fun LecmapTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = darkColorScheme(
      primary = Accent,
      onPrimary = OnAccent,
      secondary = Accent2,
      onSecondary = OnAccent,
      background = Bg,
      onBackground = TextPrimary,
      surface = Surface1,
      onSurface = TextPrimary,
      surfaceVariant = Surface2,
      onSurfaceVariant = TextSecondary,
      error = Danger,
    ),
    content = content,
  )
}
