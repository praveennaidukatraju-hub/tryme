package tryme.nice.interactive.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import tryme.nice.interactive.ui.theme.ButtonBorderColor
import tryme.nice.interactive.ui.theme.ButtonGradient

/**
 * Reusable gradient button styled to project design specifications.
 *
 * The [modifier] is applied FIRST so callers can override dimensions via
 * [Modifier.weight] or [Modifier.fillMaxWidth] in parent layouts.
 * [width] and [height] are then chained after, making them defaults only
 * when the caller does not constrain the size.
 *
 * @param width  Fixed width. Ignored when caller applies weight/fillMaxWidth.
 * @param height Fixed height. Always applied as minimum.
 */
@Composable
fun GradientButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(8.dp),
    gradient: Brush = ButtonGradient,
    borderStroke: BorderStroke? = BorderStroke(1.dp, ButtonBorderColor),
    contentPadding: PaddingValues = PaddingValues(horizontal = 10.dp),
    width: Dp = 858.dp,
    height: Dp = 108.dp,
    content: @Composable RowScope.() -> Unit
) {
    // Apply caller modifier first, then size defaults, then gradient+border
    val sizeModifier = if (width > 0.dp) Modifier.width(width).height(height) else Modifier.fillMaxWidth().height(height)
    val resolvedModifier = modifier
        .then(sizeModifier)
        .background(brush = gradient, shape = shape)
        .then(
            if (borderStroke != null) Modifier.border(borderStroke, shape) else Modifier
        )

    Button(
        onClick = onClick,
        modifier = resolvedModifier,
        enabled = enabled,
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent.copy(alpha = 0.5f)
        ),
        contentPadding = contentPadding
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically
        ) {
            content()
        }
    }
}
