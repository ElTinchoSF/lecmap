package com.notasia.clone

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Paleta alineada con web/src/App.css (:root) para que ambas superficies se vean iguales.
val Bg = Color(0xFF0F172A)
val Surface1 = Color(0xFF1E293B)
val Surface2 = Color(0xFF334155)
val BorderCol = Color(0xFF334155)
val TextPrimary = Color(0xFFF1F5F9)
val TextSecondary = Color(0xFF94A3B8)
val Accent = Color(0xFF38BDF8)
val Accent2 = Color(0xFF818CF8)
val GreenOk = Color(0xFF34D399)
val Danger = Color(0xFFF87171)
val OnAccent = Color(0xFF08111F)

/** Mismo degradado que `linear-gradient(135deg, var(--accent), var(--accent2))` en la web. */
val AccentGradient = listOf(Accent, Accent2)

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

// Los tres estilos de botón de la web: .btn-primary (gradiente), .btn-secondary
// (gris) y .btn-danger (rojo). Radio 10px igual que .btn en App.css.

@Composable
fun PrimaryButton(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    shape = RoundedCornerShape(10.dp),
    colors = ButtonDefaults.buttonColors(
      containerColor = Color.Transparent,
      contentColor = OnAccent,
      disabledContainerColor = Color.Transparent,
      disabledContentColor = OnAccent.copy(alpha = 0.45f),
    ),
    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
    modifier = modifier.background(Brush.linearGradient(AccentGradient), RoundedCornerShape(10.dp)),
  ) {
    Text(text, fontSize = 14.sp, fontWeight = FontWeight.Bold)
  }
}

@Composable
fun SecondaryButton(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    shape = RoundedCornerShape(10.dp),
    colors = ButtonDefaults.buttonColors(
      containerColor = Surface2,
      contentColor = TextPrimary,
      disabledContainerColor = Surface2,
      disabledContentColor = TextSecondary,
    ),
    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
    modifier = modifier,
  ) {
    Text(text, fontSize = 14.sp, fontWeight = FontWeight.Bold)
  }
}

@Composable
fun DangerButton(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    shape = RoundedCornerShape(10.dp),
    colors = ButtonDefaults.buttonColors(
      containerColor = Danger,
      contentColor = Color.Black,
      disabledContainerColor = Danger.copy(alpha = 0.35f),
      disabledContentColor = Color.Black,
    ),
    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
    modifier = modifier,
  ) {
    Text(text, fontSize = 14.sp, fontWeight = FontWeight.Bold)
  }
}
