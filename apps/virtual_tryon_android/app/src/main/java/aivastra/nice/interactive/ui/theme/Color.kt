package tryme.nice.interactive.ui.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

val Purple80 = Color(0xFFD0BCFF)
val PurpleGrey80 = Color(0xFFCCC2DC)
val Pink80 = Color(0xFFEFB8C8)

val Purple40 = Color(0xFF6650a4)
val PurpleGrey40 = Color(0xFF625b71)
val Pink40 = Color(0xFF7D5260)

// Button gradient colors
val ButtonGradientStart = Color(0xFFF2B53F)
val ButtonGradientCenter = Color(0xFFD88A18)
val ButtonGradientEnd = Color(0xFFA55A06)

// Reusable Linear Gradient Brush
val ButtonGradient = Brush.linearGradient(
    colors = listOf(
        ButtonGradientStart,
        ButtonGradientCenter,
        ButtonGradientEnd
    )
)

// Button border color: #F3C65E with 70% opacity
val ButtonBorderColor = Color(0xFFF3C65E).copy(alpha = 0.7f)

// ── Amber Gold Gradient Specs (#CE7C18 -> #6A3B0A) ──────────────────────
val AmberGradientStart = Color(0xFFCE7C18)
val AmberGradientEnd = Color(0xFF6A3B0A)

// Reusable Linear Gradient Brush (#CE7C18 -> #6A3B0A)
val AmberLinearGradient = Brush.linearGradient(
    colors = listOf(
        AmberGradientStart,
        AmberGradientEnd
    )
)

// Border color: #C28F59 with 50% opacity
val AmberBorderColor = Color(0xFFC28F59).copy(alpha = 0.5f)

// Shadow color: #C4741F with 20% opacity
val AmberShadowColor = Color(0xFFC4741F).copy(alpha = 0.2f)