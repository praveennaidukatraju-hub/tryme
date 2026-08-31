package tryme.nice.interactive.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import tryme.nice.interactive.ui.components.AppHeaderLogo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.layout.statusBars
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import tryme.nice.interactive.R
import tryme.nice.interactive.data.repository.KioskDownloadRepository
import tryme.nice.interactive.data.repository.KioskDownloadResult
import tryme.nice.interactive.ui.components.AppDialog
import tryme.nice.interactive.ui.components.ExitSessionDialog
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp

// Public web page (apps/catalogues-web/src/app/kiosk-download/page.tsx) that turns a
// batch of job IDs into a "download all as zip" flow.
private const val KIOSK_DOWNLOAD_BASE_URL = "https://app.tryme.com/kiosk-download"

@Composable
fun DownloadPage(
    resultsList: List<String>,
    jobIds: List<String> = emptyList(),
    onBack: () -> Unit,
    onDeleteSession: () -> Unit,
    onCreateNew: () -> Unit,
    onRetake: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val isPreview = LocalInspectionMode.current
    val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    var currentIndex by remember { mutableIntStateOf(0) }
    var showDeleteDialog by remember { mutableStateOf(false) }
    // "Create New" opens the same multi-way exit dialog used elsewhere in the try-on flow
    // (minus "Go to Downloads" — we're already on that screen) instead of jumping straight
    // to CategorySelection, since the customer may actually want to retake instead.
    var showExitDialog by remember { mutableStateOf(false) }
    val currentImageUrl = resultsList.getOrNull(currentIndex) ?: ""

    // Optimistically shows the QR from the locally-tracked job IDs immediately (no loading
    // flicker), then corrects it against GET /v1/kiosk-download/batch — the same endpoint a
    // scanning phone hits — so the QR never advertises jobs the server would actually reject
    // as expired/failed. A failed check (network hiccup) keeps the optimistic list rather than
    // blocking the QR: the phone that scans it re-validates for real anyway.
    var confirmedJobIds by remember { mutableStateOf(jobIds) }
    var batchChecked by remember { mutableStateOf(false) }
    LaunchedEffect(jobIds) {
        confirmedJobIds = jobIds
        batchChecked = false
        if (jobIds.isNotEmpty()) {
            when (val result = KioskDownloadRepository().getBatch(jobIds)) {
                is KioskDownloadResult.Success -> confirmedJobIds = result.data.map { it.jobId }
                is KioskDownloadResult.Failure -> Unit
            }
        }
        batchChecked = true
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
            .padding(
                start = sdp(R.dimen._18sdp),
                end = sdp(R.dimen._18sdp),
                top = statusBarH + sdp(R.dimen._10sdp),
                bottom = sdp(R.dimen._22sdp) + navBarH
            )
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = sdp(R.dimen._screen_container_width)),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // ── Top Header Bar ──────────────────────────────────────────────
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(sdp(R.dimen._45sdp))
                            .clip(CircleShape)
                            .background(Brush.linearGradient(listOf(Color(0xFFE7A52C), Color(0xFF9B5100))))
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = onBack
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._20sdp))
                        )
                    }

                    AppHeaderLogo()
                }

                Spacer(Modifier.height(sdp(R.dimen._16sdp)))

                // ── Title & Subtitle ─────────────────────────────────────────
                Text(
                    text = "Your Try-On is Ready!",
                    color = Color.White,
                    fontSize = ssp(R.dimen._24ssp),
                    fontWeight = FontWeight.Bold,
                    fontFamily = PoppinsFamily
                )
                Spacer(Modifier.height(sdp(R.dimen._4sdp)))
                Text(
                    text = "Scan the QR codes below to save your images",
                    color = Color.White.copy(alpha = 0.7f),
                    fontSize = ssp(R.dimen._13ssp),
                    fontFamily = PoppinsFamily
                )

                Spacer(Modifier.height(sdp(R.dimen._download_section_gap)))

                // ── Card 1: Single Image & Big QR Download ───────────────────────
                Box(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(sdp(R.dimen._download_card_height))
                            .clip(RoundedCornerShape(sdp(R.dimen._16sdp)))
                            .background(Color(0xFF1E1914))
                            .border(sdp(R.dimen._1sdp), Color(0xFF6E4E1C), RoundedCornerShape(sdp(R.dimen._16sdp)))
                            .padding(sdp(R.dimen._20sdp)),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._20sdp))
                    ) {
                        // Left Thumbnail Preview (Featured Image)
                        AsyncImage(
                            model = currentImageUrl,
                            contentDescription = "Result Image",
                            contentScale = ContentScale.Fit,
                            alignment = Alignment.Center,
                            modifier = Modifier
                                .weight(0.44f)
                                .height(sdp(R.dimen._download_image_height))
                                .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
                                .background(Color.Black)
                        )

                        // Right Big QR Code & Label Column
                        Column(
                            modifier = Modifier.weight(0.56f),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            if (currentImageUrl.isNotBlank()) {
                                QrCodeImage(
                                    content = currentImageUrl,
                                    modifier = Modifier.size(sdp(R.dimen._download_qr_size))
                                )
                            } else {
                                Image(
                                    painter = painterResource(R.drawable.placeholder),
                                    contentDescription = null,
                                    modifier = Modifier.size(sdp(R.dimen._download_qr_size))
                                )
                            }
                            Spacer(Modifier.height(sdp(R.dimen._12sdp)))
                            Text(
                                text = "Download this image",
                                color = Color.White,
                                fontSize = ssp(R.dimen._16ssp),
                                fontWeight = FontWeight.Bold,
                                fontFamily = PoppinsFamily
                            )
                        }
                    }

                    // Forward & Backward Navigation Chevrons on Card 1
                    val listSize = resultsList.size
                    if (listSize > 1) {
                        // Left Chevron Button (Previous Result)
                        Box(
                            modifier = Modifier
                                .align(Alignment.CenterStart)
                                .offset(x = (-sdp(R.dimen._16sdp)))
                                .size(sdp(R.dimen._36sdp))
                                .clip(CircleShape)
                                .background(
                                    Brush.linearGradient(
                                        listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                                    )
                                )
                                .clickable {
                                    currentIndex = if (currentIndex - 1 < 0) listSize - 1 else currentIndex - 1
                                },
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                Icons.Default.KeyboardArrowLeft,
                                contentDescription = "Previous Result",
                                tint = Color.White,
                                modifier = Modifier.size(sdp(R.dimen._22sdp))
                            )
                        }

                        // Right Chevron Button (Next Result)
                        Box(
                            modifier = Modifier
                                .align(Alignment.CenterEnd)
                                .offset(x = sdp(R.dimen._16sdp))
                                .size(sdp(R.dimen._36sdp))
                                .clip(CircleShape)
                                .background(
                                    Brush.linearGradient(
                                        listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                                    )
                                )
                                .clickable {
                                    currentIndex = (currentIndex + 1) % listSize
                                },
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                Icons.Default.KeyboardArrowRight,
                                contentDescription = "Next Result",
                                tint = Color.White,
                                modifier = Modifier.size(sdp(R.dimen._22sdp))
                            )
                        }
                    }
                }

                // ── Divider: OR ─────────────────────────────────────────────
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = sdp(R.dimen._download_divider_padding)),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        Modifier
                            .weight(1f)
                            .height(sdp(R.dimen._1sdp))
                            .background(Brush.horizontalGradient(listOf(Color.Transparent, Color(0xFF9A630C))))
                    )
                    Text("  OR  ", color = Color(0xFFF1A514), fontSize = ssp(R.dimen._12ssp), fontWeight = FontWeight.Bold)
                    Box(
                        Modifier
                            .weight(1f)
                            .height(sdp(R.dimen._1sdp))
                            .background(Brush.horizontalGradient(listOf(Color(0xFF9A630C), Color.Transparent)))
                    )
                }

                // ── Card 2: Download All Images Box (Larger size & vertically centered) ──────────
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(sdp(R.dimen._download_card_height))
                        .clip(RoundedCornerShape(sdp(R.dimen._16sdp)))
                        .background(Color(0xFF1E1914))
                        .border(sdp(R.dimen._1sdp), Color(0xFF6E4E1C), RoundedCornerShape(sdp(R.dimen._16sdp)))
                        .padding(sdp(R.dimen._20sdp)),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._20sdp))
                ) {
                    // Encodes job IDs (short) rather than the presigned result URLs
                    // (long, and growing per result) so this stays scannable as the
                    // session accumulates more try-on results.
                    val noneAvailable = batchChecked && confirmedJobIds.isEmpty()
                    val allImagesQrUrl = if (confirmedJobIds.isNotEmpty()) {
                        "$KIOSK_DOWNLOAD_BASE_URL?jobs=${confirmedJobIds.joinToString(",")}"
                    } else {
                        ""
                    }
                    if (allImagesQrUrl.isNotBlank()) {
                        QrCodeImage(
                            content = allImagesQrUrl,
                            modifier = Modifier.size(sdp(R.dimen._download_qr_size))
                        )
                    } else {
                        Image(
                            painter = painterResource(R.drawable.placeholder),
                            contentDescription = null,
                            modifier = Modifier.size(sdp(R.dimen._download_qr_size))
                        )
                    }

                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.Center
                    ) {
                        Text(
                            text = "Download All Images",
                            color = Color.White,
                            fontSize = ssp(R.dimen._18ssp),
                            fontWeight = FontWeight.Bold,
                            fontFamily = PoppinsFamily
                        )
                        Spacer(Modifier.height(sdp(R.dimen._4sdp)))
                        Box(
                            modifier = Modifier
                                .width(sdp(R.dimen._100sdp))
                                .height(sdp(R.dimen._2sdp))
                                .background(
                                    Brush.horizontalGradient(
                                        listOf(Color(0xFFE7A52C), Color(0xFF9B5100), Color.Transparent)
                                    )
                                )
                        )
                        Spacer(Modifier.height(sdp(R.dimen._8sdp)))
                        Text(
                            text = if (noneAvailable) {
                                "These results are no longer available to download (links expire 24h after generation)."
                            } else {
                                "Scan the QR code to download all try-on images from this session."
                            },
                            color = Color.White.copy(alpha = 0.7f),
                            fontSize = ssp(R.dimen._12ssp),
                            lineHeight = ssp(R.dimen._16ssp),
                            fontFamily = PoppinsFamily
                        )
                    }
                }

                Spacer(Modifier.height(sdp(R.dimen._download_bottom_gap)))
            }

            // ── Bottom Action Buttons ────────────────────────────────────────
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = sdp(R.dimen._screen_container_width))
                    .padding(bottom = sdp(R.dimen._12sdp)),
                horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._14sdp)),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Left Button: "Delete Session" (White pill with red text & trash icon)
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(sdp(R.dimen._bottom_action_button_height))
                        .clip(RoundedCornerShape(sdp(R.dimen._14sdp)))
                        .background(Color.White)
                        .clickable { showDeleteDialog = true },
                    contentAlignment = Alignment.Center
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.Delete,
                            contentDescription = "Delete Session",
                            tint = Color(0xFFD32F2F),
                            modifier = Modifier.size(sdp(R.dimen._22sdp))
                        )
                        Spacer(Modifier.width(sdp(R.dimen._8sdp)))
                        Text(
                            text = "Delete Session",
                            color = Color(0xFFD32F2F),
                            fontSize = ssp(R.dimen._15ssp),
                            fontWeight = FontWeight.Bold,
                            fontFamily = PoppinsFamily
                        )
                    }
                }

                // Right Button: "Create New" (Gold/Amber gradient with Home icon)
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(sdp(R.dimen._bottom_action_button_height))
                        .clip(RoundedCornerShape(sdp(R.dimen._14sdp)))
                        .background(
                            Brush.linearGradient(
                                listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                            )
                        )
                        .clickable { showExitDialog = true },
                    contentAlignment = Alignment.Center
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.Home,
                            contentDescription = "Create New",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._22sdp))
                        )
                        Spacer(Modifier.width(sdp(R.dimen._8sdp)))
                        Text(
                            text = "Create New",
                            color = Color.White,
                            fontSize = ssp(R.dimen._15ssp),
                            fontWeight = FontWeight.Bold,
                            fontFamily = PoppinsFamily
                        )
                    }
                }
            }
        }
    }

    // ── Delete Session Confirmation Dialog ──────────────────────────────────
    if (showDeleteDialog) {
        AppDialog(
            title = "Delete This Session?",
            message = "This will permanently delete all your try-on results and clear previous data.",
            subMessage = "You will be returned to the home screen and need to start the try-on process again.",
            icon = Icons.Default.Delete,
            warningText = "Once deleted, your images cannot be recovered.",
            confirmText = "Delete All",
            cancelText = "Cancel",
            onConfirm = {
                showDeleteDialog = false
                onDeleteSession()
            },
            onDismiss = {
                showDeleteDialog = false
            }
        )
    }

    // ── "Create New" Exit Dialog (no Downloads option — already here) ──────
    if (showExitDialog) {
        ExitSessionDialog(
            onGoHome = { showExitDialog = false; onCreateNew() },
            onGoToDownloads = null,
            onRetake = { showExitDialog = false; onRetake() },
            onDismiss = { showExitDialog = false }
        )
    }
}

@Composable
private fun QrCodeImage(content: String, modifier: Modifier = Modifier) {
    // QRCodeWriter throws WriterException when content is too large to encode (e.g. the
    // "download all" QR grows with every result added to the session) — never let that
    // propagate as an uncaught crash; fall back to the same placeholder used for blank content.
    val bitmap = remember(content) {
        runCatching {
            val size = 256
            val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size)
            android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.RGB_565).apply {
                for (y in 0 until size) {
                    for (x in 0 until size) {
                        setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
                    }
                }
            }.asImageBitmap()
        }.getOrNull()
    }

    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = "QR Code",
            contentScale = ContentScale.Fit,
            modifier = modifier
                .clip(RoundedCornerShape(sdp(R.dimen._10sdp)))
                .background(Color.White)
                .padding(sdp(R.dimen._8sdp))
        )
    } else {
        Image(
            painter = painterResource(R.drawable.placeholder),
            contentDescription = null,
            modifier = modifier
        )
    }
}

@Preview(name = "Download Page - Phone", showBackground = true, widthDp = 375, heightDp = 667)
@Composable
private fun DownloadPagePreview() {
    TryMeTheme {
        DownloadPage(
            resultsList = listOf("https://storage-server.com/generated-image.jpg"),
            onBack = {},
            onDeleteSession = {},
            onCreateNew = {}
        )
    }
}
