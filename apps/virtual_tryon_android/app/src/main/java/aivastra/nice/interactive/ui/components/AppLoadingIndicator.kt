package tryme.nice.interactive.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Reusable lightweight loading indicator.
 *
 * A thin wrapper around [CircularProgressIndicator] with project-standard defaults.
 *
 * @param size        Diameter of the spinner.
 * @param color       Track color of the spinner.
 * @param strokeWidth Width of the spinning arc.
 */
@Composable
fun AppLoadingIndicator(
    modifier: Modifier = Modifier,
    size: Dp = 24.dp,
    color: Color = Color(0xFFF2B53F),
    strokeWidth: Dp = 2.5.dp
) {
    CircularProgressIndicator(
        modifier = modifier.size(size),
        color = color,
        strokeWidth = strokeWidth,
        trackColor = color.copy(alpha = 0.25f)
    )
}
