package tryme.nice.interactive.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import tryme.nice.interactive.ui.theme.PoppinsFamily

/**
 * Universal project dialog component.
 *
 * Renders a dark-themed modal dialog that adapts fully based on the
 * supplied parameters — no dialog-specific subclasses needed.
 *
 * @param title           Bold heading text.
 * @param message         Primary body message. Null = hidden.
 * @param subMessage      Secondary body line shown below [message]. Null = hidden.
 * @param icon            Optional icon rendered in the gold circle at the top.
 * @param warningText     If non-null, renders a gold warning banner below the body.
 * @param confirmText     Label for the gradient confirm button. Default "Confirm".
 * @param cancelText      Label for the secondary cancel button. Null = no cancel button.
 * @param onConfirm       Called when the confirm button is tapped.
 * @param onDismiss       Called when cancel is tapped or dialog is dismissed.
 * @param isLoading       Replaces confirm button content with a spinner while true.
 * @param dismissOnBack   Whether back-press / outside tap closes the dialog.
 */
@Composable
fun AppDialog(
    title: String,
    message: String? = null,
    subMessage: String? = null,
    icon: ImageVector? = null,
    warningText: String? = null,
    confirmText: String = "Confirm",
    cancelText: String? = "Cancel",
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    isLoading: Boolean = false,
    dismissOnBack: Boolean = true
) {
    Dialog(
        onDismissRequest = { if (!isLoading && dismissOnBack) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(0.85f)
                .clip(RoundedCornerShape(20.dp))
                .background(Color(0xFF1A1A1A))
                .padding(horizontal = 24.dp, vertical = 28.dp),
            contentAlignment = Alignment.TopCenter
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {

                // ── Icon circle (optional) ──────────────────────────────────
                if (icon != null) {
                    Box(
                        modifier = Modifier
                            .size(58.dp)
                            .clip(CircleShape)
                            .background(Color(0xFF1E1609))
                            .border(1.5.dp, Color(0xFFE7A52C).copy(alpha = 0.6f), CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = icon,
                            contentDescription = null,
                            tint = Color(0xFFE7A52C),
                            modifier = Modifier.size(26.dp)
                        )
                    }
                    Spacer(modifier = Modifier.height(16.dp))
                }

                // ── Title ───────────────────────────────────────────────────
                Text(
                    text = title,
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.Bold,
                    fontSize = 20.sp,
                    color = Color.White,
                    textAlign = TextAlign.Center
                )

                // ── Body messages ───────────────────────────────────────────
                if (message != null) {
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        text = message,
                        fontFamily = PoppinsFamily,
                        fontWeight = FontWeight.Normal,
                        fontSize = 13.sp,
                        color = Color.White.copy(alpha = 0.8f),
                        textAlign = TextAlign.Center
                    )
                }

                if (subMessage != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = subMessage,
                        fontFamily = PoppinsFamily,
                        fontWeight = FontWeight.Normal,
                        fontSize = 13.sp,
                        color = Color.White.copy(alpha = 0.8f),
                        textAlign = TextAlign.Center
                    )
                }

                // ── Warning banner (optional) ───────────────────────────────
                if (warningText != null) {
                    Spacer(modifier = Modifier.height(16.dp))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFF1C170E))
                            .border(1.dp, Color(0xFF6E4E1C), RoundedCornerShape(8.dp))
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Warning,
                            contentDescription = null,
                            tint = Color(0xFFE7A52C),
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = warningText,
                            fontFamily = PoppinsFamily,
                            fontWeight = FontWeight.Normal,
                            fontSize = 12.sp,
                            color = Color(0xFFE7A52C)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(22.dp))

                // ── Buttons ─────────────────────────────────────────────────
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    // Cancel (optional)
                    if (cancelText != null) {
                        TextButton(
                            onClick = { if (!isLoading) onDismiss() },
                            enabled = !isLoading,
                            modifier = Modifier
                                .weight(1f)
                                .height(48.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(Color.White)
                        ) {
                            Text(
                                text = cancelText,
                                fontFamily = PoppinsFamily,
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp,
                                color = Color(0xFF424242)
                            )
                        }
                    }

                    // Confirm — gradient
                    GradientButton(
                        onClick = { if (!isLoading) onConfirm() },
                        enabled = !isLoading,
                        width = 0.dp,          // 0 = let weight control width
                        height = 46.dp,
                        modifier = Modifier.weight(1f)
                    ) {
                        if (isLoading) {
                            AppLoadingIndicator(size = 20.dp, color = Color.White, strokeWidth = 2.dp)
                        } else {
                            Text(
                                text = confirmText,
                                fontFamily = PoppinsFamily,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                                color = Color.White
                            )
                        }
                    }
                }
            }
        }
    }
}
