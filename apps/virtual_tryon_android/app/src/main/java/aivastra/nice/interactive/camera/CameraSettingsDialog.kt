package tryme.nice.interactive.camera

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CameraSettingsDialog(
    initialSettings: CameraSettings,
    onDismiss: () -> Unit,
    onSaveSettings: (CameraSettings) -> Unit,
    availablePictureSizes: List<android.util.Size> = emptyList(),
    modifier: Modifier = Modifier
) {
    var draftSettings by remember { mutableStateOf(initialSettings) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = Color(0xFF1B1E24),
        scrimColor = Color.Black.copy(alpha = 0.65f),
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(vertical = sdp(R.dimen._10sdp))
                    .width(sdp(R.dimen._48sdp))
                    .height(sdp(R.dimen._5sdp))
                    .clip(CircleShape)
                    .background(Color(0xFF5E6575))
            )
        },
        shape = RoundedCornerShape(topStart = sdp(R.dimen._24sdp), topEnd = sdp(R.dimen._24sdp)),
        modifier = modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = sdp(R.dimen._20sdp), vertical = sdp(R.dimen._8sdp))
        ) {
            // ── Top Sheet Header ─────────────────────────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Camera & Texture Settings",
                        color = Color.White,
                        fontSize = ssp(R.dimen._18ssp),
                        fontWeight = FontWeight.Bold,
                        fontFamily = PoppinsFamily
                    )
                    Spacer(Modifier.padding(horizontal = sdp(R.dimen._4sdp)))
                    Icon(
                        Icons.Default.Settings,
                        contentDescription = null,
                        tint = Color(0xFF6B99C4),
                        modifier = Modifier.size(sdp(R.dimen._18sdp))
                    )
                }

                Box(
                    modifier = Modifier
                        .size(sdp(R.dimen._32sdp))
                        .clip(CircleShape)
                        .clickable(onClick = onDismiss),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = "Close Settings",
                        tint = Color(0xFFE59B27),
                        modifier = Modifier.size(sdp(R.dimen._22sdp))
                    )
                }
            }

            Spacer(Modifier.height(sdp(R.dimen._12sdp)))

            // ── Scrollable Settings Options (Fills 70% Sheet Flexibly) ───────
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(sdp(R.dimen._16sdp))
            ) {
                // 1. Capture Quality
                SettingSectionTitle("Capture Quality")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._10sdp))
                ) {
                    CaptureQualityOption.values().forEach { option ->
                        val isSelected = draftSettings.captureQuality == option && draftSettings.pictureSize == null
                        SettingChip(
                            label = option.label,
                            isSelected = isSelected,
                            onClick = {
                                // An exact picture size (below) always overrides this tier, so
                                // picking a tier here means "go back to automatic sizing".
                                draftSettings = draftSettings.copy(captureQuality = option, pictureSize = null)
                            }
                        )
                    }
                }

                // 1b. Picture Resolution — exact sizes this camera actually reports support
                // for, queried live via Camera2 so kiosk/box cameras (whose native
                // resolutions vary a lot by hardware) aren't limited to the fixed quality tiers.
                if (availablePictureSizes.isNotEmpty()) {
                    SettingSectionTitle("Picture Resolution")
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._10sdp))
                    ) {
                        SettingChip(
                            label = "Auto",
                            isSelected = draftSettings.pictureSize == null,
                            onClick = {
                                draftSettings = draftSettings.copy(pictureSize = null)
                            }
                        )
                        availablePictureSizes.forEach { size ->
                            val isSelected = draftSettings.pictureSize == size
                            SettingChip(
                                label = "${size.width} x ${size.height}",
                                isSelected = isSelected,
                                onClick = {
                                    draftSettings = draftSettings.copy(pictureSize = size)
                                }
                            )
                        }
                    }
                }

                // 2. Resolution Ratio
                SettingSectionTitle("Resolution Ratio")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._10sdp))
                ) {
                    ResolutionRatioOption.values().forEach { option ->
                        val isSelected = draftSettings.resolutionRatio == option
                        SettingChip(
                            label = option.label,
                            isSelected = isSelected,
                            onClick = {
                                draftSettings = draftSettings.copy(resolutionRatio = option)
                            }
                        )
                    }
                }

                // 3. Surface Stream Type
                SettingSectionTitle("Surface Stream Type")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._10sdp))
                ) {
                    SurfaceStreamTypeOption.values().forEach { option ->
                        val isSelected = draftSettings.surfaceStreamType == option
                        SettingChip(
                            label = "${option.label} ${option.detail}",
                            isSelected = isSelected,
                            onClick = {
                                draftSettings = draftSettings.copy(surfaceStreamType = option)
                            }
                        )
                    }
                }

                // 4. HDR (High Dynamic Range)
                SettingSectionTitle("HDR (High Dynamic Range)")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._10sdp))
                ) {
                    HdrOption.values().forEach { option ->
                        val isSelected = draftSettings.hdrOption == option
                        SettingChip(
                            label = option.label,
                            isSelected = isSelected,
                            onClick = {
                                draftSettings = draftSettings.copy(hdrOption = option)
                            }
                        )
                    }
                }

                // 5. Skin & Texture Filter
                SettingSectionTitle("Skin & Texture Filter")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._10sdp))
                ) {
                    SkinFilterOption.values().forEach { option ->
                        val isSelected = draftSettings.skinFilter == option
                        SettingChip(
                            label = option.label,
                            isSelected = isSelected,
                            onClick = {
                                draftSettings = draftSettings.copy(skinFilter = option)
                            }
                        )
                    }
                }

                // 6. Camera Facing
                SettingSectionTitle("Supported Cameras")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._10sdp))
                ) {
                    CameraFacingOption.values().forEach { option ->
                        val isSelected = draftSettings.cameraFacing == option
                        SettingChip(
                            label = option.label,
                            isSelected = isSelected,
                            onClick = {
                                draftSettings = draftSettings.copy(cameraFacing = option)
                            }
                        )
                    }
                }

                Spacer(Modifier.height(sdp(R.dimen._10sdp)))
            }

            Spacer(Modifier.height(sdp(R.dimen._12sdp)))

            // ── Save Settings Button ──────────────────────────────────────────
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(sdp(R.dimen._48sdp))
                    .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
                    .background(
                        Brush.linearGradient(
                            listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                        )
                    )
                    .clickable {
                        onSaveSettings(draftSettings)
                    },
                contentAlignment = Alignment.Center
            ) {
                Text(
                    "SAVE SETTINGS",
                    color = Color.White,
                    fontSize = ssp(R.dimen._15ssp),
                    fontWeight = FontWeight.Bold,
                    fontFamily = PoppinsFamily
                )
            }
            Spacer(Modifier.height(sdp(R.dimen._16sdp)))
        }
    }
}

@Composable
private fun SettingSectionTitle(title: String) {
    Text(
        text = title,
        color = Color(0xFF9EA6B8),
        fontSize = ssp(R.dimen._13ssp),
        fontWeight = FontWeight.Medium,
        fontFamily = PoppinsFamily,
        modifier = Modifier.padding(bottom = sdp(R.dimen._6sdp))
    )
}

@Composable
private fun SettingChip(
    label: String,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    val backgroundColor = if (isSelected) Color(0xFFE59B27) else Color(0xFF262A33)
    val textColor = if (isSelected) Color(0xFF14171D) else Color(0xFFD6DBE5)
    val borderColor = if (isSelected) Color(0xFFE59B27) else Color(0xFF383E4B)

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
            .background(backgroundColor)
            .border(sdp(R.dimen._1sdp), borderColor, RoundedCornerShape(sdp(R.dimen._12sdp)))
            .clickable(onClick = onClick)
            .padding(horizontal = sdp(R.dimen._16sdp), vertical = sdp(R.dimen._10sdp)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = label,
            color = textColor,
            fontSize = ssp(R.dimen._13ssp),
            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
            fontFamily = PoppinsFamily
        )
    }
}
