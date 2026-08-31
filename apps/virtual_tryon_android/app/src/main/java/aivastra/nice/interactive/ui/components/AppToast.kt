package tryme.nice.interactive.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import kotlinx.coroutines.delay

/**
 * Toast/snackbar display type.
 */
enum class ToastType { SUCCESS, ERROR, WARNING }

/**
 * Reusable in-app snackbar-style notification.
 *
 * Place inside a Box aligned to [Alignment.BottomCenter] at the bottom of the screen (the
 * standard Material snackbar position) at a high z-index. Automatically dismisses after
 * [autoDismissMs] milliseconds, or on tapping the close icon.
 *
 * @param visible       Whether the snackbar is currently visible.
 * @param message       The text message to display.
 * @param type          Visual style: SUCCESS (green), ERROR (red), WARNING (amber).
 * @param autoDismissMs Auto-dismiss delay in milliseconds. 0 = never auto-dismiss.
 * @param onDismiss     Called when dismissed (by timer, close tap, or manually).
 */
@Composable
fun AppToast(
    visible: Boolean,
    message: String,
    type: ToastType = ToastType.SUCCESS,
    autoDismissMs: Long = 3000L,
    onDismiss: () -> Unit = {}
) {
    if (visible && autoDismissMs > 0L) {
        LaunchedEffect(message, visible) {
            delay(autoDismissMs)
            onDismiss()
        }
    }

    val (accentColor, iconTint, icon) = when (type) {
        ToastType.SUCCESS -> Triple(Color(0xFF4CAF50), Color(0xFF6FE187), Icons.Default.Check)
        ToastType.ERROR -> Triple(Color(0xFFE05252), Color(0xFFFF8A8A), Icons.Default.Close)
        ToastType.WARNING -> Triple(Color(0xFFE7A52C), Color(0xFFF3C669), Icons.Default.Warning)
    }

    AnimatedVisibility(
        visible = visible,
        enter = fadeIn() + slideInVertically(initialOffsetY = { it }),
        exit = fadeOut() + slideOutVertically(targetOffsetY = { it })
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = sdp(R.dimen._20sdp), vertical = sdp(R.dimen._12sdp))
                .shadow(
                    elevation = sdp(R.dimen._12sdp),
                    shape = RoundedCornerShape(sdp(R.dimen._14sdp)),
                    ambientColor = Color.Black.copy(alpha = 0.5f),
                    spotColor = Color.Black.copy(alpha = 0.5f)
                )
                .clip(RoundedCornerShape(sdp(R.dimen._14sdp)))
                .background(Color(0xFF1D2027))
                .height(IntrinsicSize.Min)
        ) {
            // Colored accent bar — carries the type's color without tinting the whole card.
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .width(sdp(R.dimen._4sdp))
                    .background(accentColor)
            )

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .weight(1f)
                    .padding(
                        start = sdp(R.dimen._14sdp),
                        end = sdp(R.dimen._10sdp),
                        top = sdp(R.dimen._14sdp),
                        bottom = sdp(R.dimen._14sdp)
                    )
            ) {
                Box(
                    modifier = Modifier
                        .size(sdp(R.dimen._30sdp))
                        .clip(CircleShape)
                        .background(accentColor.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        tint = iconTint,
                        modifier = Modifier.size(sdp(R.dimen._16sdp))
                    )
                }

                Spacer(modifier = Modifier.width(sdp(R.dimen._12sdp)))

                Text(
                    text = message,
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.Medium,
                    fontSize = ssp(R.dimen._13ssp),
                    color = Color.White,
                    modifier = Modifier.weight(1f)
                )

                Spacer(modifier = Modifier.width(sdp(R.dimen._6sdp)))

                Box(
                    modifier = Modifier
                        .size(sdp(R.dimen._26sdp))
                        .clip(CircleShape)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = onDismiss
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Dismiss",
                        tint = Color.White.copy(alpha = 0.45f),
                        modifier = Modifier.size(sdp(R.dimen._14sdp))
                    )
                }
            }
        }
    }
}
