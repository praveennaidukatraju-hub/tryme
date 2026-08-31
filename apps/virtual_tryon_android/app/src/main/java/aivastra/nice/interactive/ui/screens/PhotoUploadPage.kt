package tryme.nice.interactive.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import tryme.nice.interactive.utils.CrashReporter
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import tryme.nice.interactive.R
import tryme.nice.interactive.camera.InternalCameraView
import tryme.nice.interactive.camera.PhotoEditView
import tryme.nice.interactive.ui.components.GradientButton
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.components.AppHeaderLogo
import tryme.nice.interactive.ui.components.AppToast
import tryme.nice.interactive.ui.components.ToastType
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import tryme.nice.interactive.viewmodels.PhotoUploadViewModel

private enum class PhotoUploadScreenState {
    CHOICE_SELECTION,
    INTERNAL_CAMERA,
    EDIT_PHOTO
}

@Composable
fun PhotoUploadPage(
    onBack: () -> Unit,
    onUploadSuccess: (photoUri: String, r2Key: String) -> Unit = { _, _ -> },
    viewModel: PhotoUploadViewModel = viewModel(),
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val uiState by viewModel.uiState.collectAsState()
    var screenState by remember { mutableStateOf(PhotoUploadScreenState.CHOICE_SELECTION) }
    var capturedPhotoUri by remember { mutableStateOf<Uri?>(null) }
    var showSourceDialog by remember { mutableStateOf(false) }

    val isPreview = LocalInspectionMode.current
    val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    var photoSourceType by remember { mutableStateOf<String?>(null) }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            photoSourceType = "CAMERA"
            screenState = PhotoUploadScreenState.INTERNAL_CAMERA
        }
    }

    val galleryPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            photoSourceType = "GALLERY"
            capturedPhotoUri = uri
            screenState = PhotoUploadScreenState.EDIT_PHOTO
        }
    }

    val galleryPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        Manifest.permission.READ_MEDIA_IMAGES
    } else {
        Manifest.permission.READ_EXTERNAL_STORAGE
    }

    val galleryPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            galleryPickerLauncher.launch("image/*")
        }
    }

    val launchInternalCamera = {
        viewModel.stopPolling()
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            photoSourceType = "CAMERA"
            screenState = PhotoUploadScreenState.INTERNAL_CAMERA
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    val launchGalleryPicker = {
        viewModel.stopPolling()
        try {
            galleryPickerLauncher.launch("image/*")
        } catch (e: Exception) {
            CrashReporter.recordException(e, "PhotoUploadPage")
        }
    }

    LaunchedEffect(screenState) {
        if (screenState == PhotoUploadScreenState.CHOICE_SELECTION && photoSourceType == null) {
            viewModel.clearUploadedPhoto()
            viewModel.ensureActiveSession()
        }
    }

    LaunchedEffect(uiState.uploadedR2Key, uiState.capturedPhotoUri) {
        val r2Key = uiState.uploadedR2Key
        val photoUri = uiState.capturedPhotoUri
        if (r2Key != null && photoUri != null) {
            if (screenState == PhotoUploadScreenState.CHOICE_SELECTION && photoSourceType == null) {
                // Incoming QR upload from phone -> route to PhotoEditView first!
                photoSourceType = "QR"
                capturedPhotoUri = Uri.parse(photoUri)
                viewModel.clearUploadedPhoto()
                screenState = PhotoUploadScreenState.EDIT_PHOTO
            } else if (photoSourceType != null) {
                // User confirmed edit -> proceed to PhotoReviewPage!
                val finalR2Key = r2Key
                val finalUri = photoUri
                photoSourceType = null
                capturedPhotoUri = null
                viewModel.resetStateAndRefreshQr()
                onUploadSuccess(finalUri, finalR2Key)
            }
        }
    }

    BackHandler(enabled = true) {
        if (showSourceDialog) {
            showSourceDialog = false
        } else if (screenState != PhotoUploadScreenState.CHOICE_SELECTION) {
            photoSourceType = null
            capturedPhotoUri = null
            screenState = PhotoUploadScreenState.CHOICE_SELECTION
            viewModel.resetStateAndRefreshQr()
        } else {
            photoSourceType = null
            capturedPhotoUri = null
            viewModel.resetStateAndRefreshQr()
            onBack()
        }
    }

    Crossfade(targetState = screenState, label = "PhotoUploadCrossfade") { state ->
        when (state) {
            PhotoUploadScreenState.CHOICE_SELECTION -> {
                BoxWithConstraints(modifier = modifier.fillMaxSize().background(Color.Black)) {
                    // sdp scales with screen-width bucket but not enough to keep a flat height
                    // visually proportional from phone up to tablet/kiosk — a fixed card height
                    // that looks right on mobile ends up looking short on the much wider/taller
                    // tablet and kiosk screens. Size the card off the real measured width instead.
                    val isMobile = maxWidth < 500.dp
                    val choiceCardHeight = if (isMobile) sdp(R.dimen._160sdp) else sdp(R.dimen._220sdp)
                    val artworkSize = if (isMobile) sdp(R.dimen._120sdp) else sdp(R.dimen._170sdp)
                    val actionButtonHeight = if (isMobile) sdp(R.dimen._38sdp) else sdp(R.dimen._52sdp)
                    val actionIconSize = if (isMobile) sdp(R.dimen._18sdp) else sdp(R.dimen._24sdp)
                    val refreshIconSize = if (isMobile) sdp(R.dimen._12sdp) else sdp(R.dimen._16sdp)

                    Image(
                        painter = painterResource(R.drawable.new_app_bg),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize()
                    )

                    // Top warm spotlight beam light effect
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .fillMaxWidth()
                            .height(sdp(R.dimen._280sdp))
                            .background(
                                Brush.verticalGradient(
                                    colors = listOf(
                                        Color(0xFFF2B53F).copy(alpha = 0.24f),
                                        Color(0xFFD88A18).copy(alpha = 0.08f),
                                        Color.Transparent
                                    )
                                )
                            )
                    )

                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(
                                start = sdp(R.dimen._18sdp),
                                end = sdp(R.dimen._18sdp),
                                top = statusBarH + sdp(R.dimen._10sdp),
                                bottom = sdp(R.dimen._22sdp) + navBarH
                            ),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .widthIn(max = sdp(R.dimen._screen_container_width))
                        ) {
                            UploadTopBar(isMobile = isMobile) {
                                photoSourceType = null
                                capturedPhotoUri = null
                                viewModel.resetStateAndRefreshQr()
                                onBack()
                            }

                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth()
                                    .verticalScroll(rememberScrollState()),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.Center
                            ) {
                                Spacer(Modifier.height(sdp(R.dimen._16sdp)))
                                Text(
                                    "Upload Your Photo",
                                    color = Color.White,
                                    fontSize = ssp(R.dimen._20ssp),
                                    fontWeight = FontWeight.SemiBold,
                                    fontFamily = PoppinsFamily,
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Text(
                                    "Choose how you want to add your photo",
                                    color = Color.White.copy(alpha = 0.76f),
                                    fontSize = ssp(R.dimen._10ssp),
                                    fontFamily = PoppinsFamily,
                                    fontWeight = FontWeight.Medium,
                                    modifier = Modifier.fillMaxWidth()
                                )

                                Spacer(Modifier.height(sdp(R.dimen._30sdp)))
                                UploadChoiceCard(
                                    visual = {
                                        val qrUrl = uiState.qrUrl
                                        when {
                                            uiState.isQrLoading && !isPreview -> CircularProgressIndicator(
                                                color = Color(0xFFE6A01C),
                                                strokeWidth = sdp(R.dimen._2sdp),
                                                modifier = Modifier.size(sdp(R.dimen._28sdp))
                                            )
                                            qrUrl != null -> QrArtwork(
                                                content = qrUrl,
                                                modifier = Modifier.size(artworkSize),
                                                onRefresh = { viewModel.createQrSession() }
                                            )
                                            else -> Column(
                                                horizontalAlignment = Alignment.CenterHorizontally,
                                                verticalArrangement = Arrangement.Center
                                            ) {
                                                Text(
                                                    "QR Session Error",
                                                    color = Color.White.copy(alpha = 0.7f),
                                                    fontSize = ssp(R.dimen._10ssp),
                                                    fontFamily = PoppinsFamily
                                                )
                                                Spacer(Modifier.height(sdp(R.dimen._6sdp)))
                                                Box(
                                                    modifier = Modifier
                                                        .clip(RoundedCornerShape(sdp(R.dimen._6sdp)))
                                                        .background(Color(0xFFE7A52C))
                                                        .clickable { viewModel.createQrSession() }
                                                        .padding(horizontal = sdp(R.dimen._10sdp), vertical = sdp(R.dimen._6sdp))
                                                ) {
                                                    Text(
                                                        "Tap to Refresh QR",
                                                        color = Color.Black,
                                                        fontSize = ssp(R.dimen._10ssp),
                                                        fontWeight = FontWeight.SemiBold,
                                                        fontFamily = PoppinsFamily
                                                    )
                                                }
                                            }
                                        }
                                    },
                                    title = "Scan & Upload",
                                    cardHeight = choiceCardHeight,
                                    description = if (
                                        uiState.uploadedR2Key != null && uiState.capturedPhotoUri == null
                                    ) "Photo uploaded successfully." else
                                        "Scan the QR code with your phone\nto upload your photo securely.",
                                    action = if (uiState.qrUrl != null && !uiState.isQrLoading) {
                                        {
                                            Row(
                                                modifier = Modifier
                                                    .clip(RoundedCornerShape(sdp(R.dimen._6sdp)))
                                                    .background(Color.White.copy(alpha = 0.10f))
                                                    .clickable { viewModel.createQrSession() }
                                                    .padding(horizontal = sdp(R.dimen._8sdp), vertical = sdp(R.dimen._4sdp)),
                                                verticalAlignment = Alignment.CenterVertically
                                            ) {
                                                Icon(
                                                    Icons.Default.Refresh,
                                                    contentDescription = "Refresh QR",
                                                    tint = Color(0xFFF2B53F),
                                                    modifier = Modifier.size(refreshIconSize)
                                                )
                                                Spacer(Modifier.width(sdp(R.dimen._4sdp)))
                                                Text(
                                                    "Refresh QR Code",
                                                    color = Color(0xFFF2B53F),
                                                    fontSize = ssp(R.dimen._8ssp),
                                                    fontWeight = FontWeight.Medium,
                                                    fontFamily = PoppinsFamily
                                                )
                                            }
                                        }
                                    } else null
                                )

                                OrDivider()

                                UploadChoiceCard(
                                    visual = { CameraArtwork(size = artworkSize) },
                                    title = "Upload or Capture",
                                    cardHeight = choiceCardHeight,
                                    description = "Take a clear photo for the best results.",
                                    action = {
                                        GradientButton(
                                            onClick = { showSourceDialog = true },
                                            enabled = !uiState.isUploading,
                                            width = sdp(R.dimen._0sdp),
                                            height = actionButtonHeight,
                                            gradient = Brush.verticalGradient(
                                                listOf(
                                                    Color(0xFFF2B53F),
                                                    Color(0xFFD88A18),
                                                    Color(0xFFA55A06)
                                                )
                                            ),
                                            borderStroke = BorderStroke(sdp(R.dimen._1sdp), Color(0xFFF3C65E).copy(alpha = 0.7f)),
                                            modifier = Modifier.fillMaxWidth(),
                                            shape = RoundedCornerShape(sdp(R.dimen._8sdp))
                                        ) {
                                            Image(
                                                painter = painterResource(R.drawable.camera_icon_),
                                                contentDescription = null,
                                                colorFilter = ColorFilter.tint(Color.White),
                                                modifier = Modifier.size(actionIconSize)
                                            )
                                            if (uiState.isUploading) {
                                                CircularProgressIndicator(
                                                    color = Color.White,
                                                    strokeWidth = sdp(R.dimen._2sdp),
                                                    modifier = Modifier.size(actionIconSize)
                                                )
                                            } else {
                                                Text(
                                                    "Click",
                                                    color = Color.White,
                                                    fontSize = ssp(R.dimen._14ssp),
                                                    fontWeight = FontWeight.SemiBold,
                                                    fontFamily = PoppinsFamily
                                                )
                                            }
                                        }
                                    }
                                )

                                Spacer(Modifier.height(sdp(R.dimen._24sdp)))
                                PrivacyNotice()
                            }
                        }
                    }

                    // ── Snackbar overlay for upload/session API errors ──────────
                    val toastBottomInset = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .align(Alignment.BottomCenter)
                            .padding(bottom = sdp(R.dimen._12sdp) + toastBottomInset)
                    ) {
                        AppToast(
                            visible = uiState.errorMessage != null,
                            message = uiState.errorMessage.orEmpty(),
                            type = ToastType.ERROR,
                            autoDismissMs = 4000L,
                            onDismiss = { viewModel.clearError() }
                        )
                    }

                    if (showSourceDialog) {
                        PhotoSourceSelectionDialog(
                            onDismiss = { showSourceDialog = false },
                            onSelectCamera = {
                                showSourceDialog = false
                                launchInternalCamera()
                            },
                            onSelectGallery = {
                                showSourceDialog = false
                                launchGalleryPicker()
                            }
                        )
                    }

                    if (uiState.isUploading) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(Color.Black.copy(alpha = 0.80f))
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClick = {}
                                ),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator(
                                    color = Color(0xFFF2B53F),
                                    strokeWidth = sdp(R.dimen._3sdp),
                                    modifier = Modifier.size(sdp(R.dimen._40sdp))
                                )
                                Spacer(Modifier.height(sdp(R.dimen._14sdp)))
                                Text(
                                    "Uploading photo...",
                                    color = Color.White,
                                    fontSize = ssp(R.dimen._14ssp),
                                    fontWeight = FontWeight.SemiBold,
                                    fontFamily = PoppinsFamily
                                )
                            }
                        }
                    }
                }
            }

            PhotoUploadScreenState.INTERNAL_CAMERA -> {
                InternalCameraView(
                    onBack = { screenState = PhotoUploadScreenState.CHOICE_SELECTION },
                    onPhotoCaptured = { uri ->
                        capturedPhotoUri = uri
                        screenState = PhotoUploadScreenState.EDIT_PHOTO
                    }
                )
            }

            PhotoUploadScreenState.EDIT_PHOTO -> {
                val uri = capturedPhotoUri
                if (uri != null) {
                    PhotoEditView(
                        photoUri = uri,
                        isFromCamera = photoSourceType == "CAMERA",
                        onCancel = {
                            if (photoSourceType == "CAMERA") {
                                screenState = PhotoUploadScreenState.INTERNAL_CAMERA
                            } else {
                                photoSourceType = null
                                capturedPhotoUri = null
                                screenState = PhotoUploadScreenState.CHOICE_SELECTION
                                viewModel.resetStateAndRefreshQr()
                            }
                        },
                        onConfirmEdit = { editedUri ->
                            if (photoSourceType == null) photoSourceType = "EDIT"
                            capturedPhotoUri = editedUri
                            screenState = PhotoUploadScreenState.CHOICE_SELECTION
                            viewModel.uploadCapturedPhoto(editedUri)
                        }
                    )
                } else {
                    screenState = PhotoUploadScreenState.INTERNAL_CAMERA
                }
            }
        }
    }
}

@Composable
private fun UploadTopBar(isMobile: Boolean, onBack: () -> Unit) {
    val buttonSize = if (isMobile) sdp(R.dimen._38sdp) else sdp(R.dimen._52sdp)
    val iconSize = if (isMobile) sdp(R.dimen._14sdp) else sdp(R.dimen._20sdp)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(buttonSize)
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
                modifier = Modifier.size(iconSize)
            )
        }
        AppHeaderLogo()
    }
}

@Composable
private fun UploadChoiceCard(
    visual: @Composable () -> Unit,
    title: String,
    description: String,
    modifier: Modifier = Modifier,
    cardHeight: Dp = sdp(R.dimen._160sdp),
    action: (@Composable () -> Unit)? = null
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(cardHeight)
            .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
            .background(
                Brush.linearGradient(
                    colors = listOf(
                        Color(0xFF382717).copy(alpha = 0.88f),
                        Color(0xFF19110A).copy(alpha = 0.92f)
                    )
                )
            )
            .border(
                width = sdp(R.dimen._1sdp),
                color = Color(0xFFB97A1E).copy(alpha = 0.70f),
                shape = RoundedCornerShape(sdp(R.dimen._12sdp))
            )
            .padding(horizontal = sdp(R.dimen._16sdp), vertical = sdp(R.dimen._14sdp)),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier.weight(0.44f),
            contentAlignment = Alignment.Center
        ) {
            visual()
        }
        Spacer(Modifier.width(sdp(R.dimen._14sdp)))
        Column(
            modifier = Modifier.weight(0.56f),
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                title,
                color = Color.White,
                fontSize = ssp(R.dimen._18ssp),
                fontWeight = FontWeight.Bold,
                fontFamily = PoppinsFamily
            )
            Spacer(Modifier.height(sdp(R.dimen._4sdp)))
            Box(
                modifier = Modifier
                    .width(sdp(R.dimen._50sdp))
                    .height(sdp(R.dimen._1sdp))
                    .background(
                        Brush.horizontalGradient(
                            listOf(Color(0xFFF2B53F), Color(0xFFD88A18), Color.Transparent)
                        )
                    )
            )
            Spacer(Modifier.height(sdp(R.dimen._10sdp)))
            Text(
                description,
                color = Color.White.copy(alpha = 0.76f),
                fontSize = ssp(R.dimen._10ssp),
                lineHeight = ssp(R.dimen._14ssp),
                fontFamily = PoppinsFamily
            )
            if (action != null) {
                Spacer(Modifier.height(sdp(R.dimen._12sdp)))
                action()
            }
        }
    }
}

@Composable
private fun OrDivider() {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = sdp(R.dimen._27sdp)),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.weight(1f).height(sdp(R.dimen._1sdp)).background(Brush.horizontalGradient(listOf(Color.Transparent, Color(0xFF9A630C)))))
        Text("  OR  ", color = Color(0xFFF1A514), fontSize = ssp(R.dimen._9ssp), fontWeight = FontWeight.SemiBold)
        Box(Modifier.weight(1f).height(sdp(R.dimen._1sdp)).background(Brush.horizontalGradient(listOf(Color(0xFF9A630C), Color.Transparent))))
    }
}

@Composable
private fun CameraArtwork(size: Dp = sdp(R.dimen._120sdp)) {
    Image(
        painter = painterResource(R.drawable.take_photo_icon),
        contentDescription = "Take photo",
        contentScale = ContentScale.Fit,
        modifier = Modifier.size(size)
    )
}

@Composable
private fun QrArtwork(
    content: String,
    modifier: Modifier = Modifier,
    onRefresh: (() -> Unit)? = null
) {
    val bitmapState by produceState<ImageBitmap?>(initialValue = null, key1 = content) {
        value = withContext(Dispatchers.IO) {
            try {
                val size = 512
                val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size)
                val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
                val pixels = IntArray(size * size)
                for (y in 0 until size) {
                    val offset = y * size
                    for (x in 0 until size) {
                        pixels[offset + x] = if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
                    }
                }
                bmp.setPixels(pixels, 0, size, 0, 0, size, size)
                bmp.asImageBitmap()
            } catch (e: Exception) {
                CrashReporter.recordException(e, "PhotoUploadPage")
                null
            }
        }
    }

    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center
    ) {
        val bmp = bitmapState
        if (bmp != null) {
            Image(
                bitmap = bmp,
                contentDescription = "Scan QR code to upload",
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
                    .background(Color.White)
                    .padding(sdp(R.dimen._4sdp))
                    .then(
                        if (onRefresh != null) Modifier.clickable { onRefresh() } else Modifier
                    )
            )
        } else {
            CircularProgressIndicator(
                color = Color(0xFFE6A01C),
                strokeWidth = sdp(R.dimen._2sdp),
                modifier = Modifier.size(sdp(R.dimen._28sdp))
            )
        }
    }
}

@Composable
private fun PrivacyNotice() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Image(
            painter = painterResource(R.drawable.privacy_lock_icon),
            contentDescription = null,
            modifier = Modifier.size(sdp(R.dimen._22sdp))
        )
        Spacer(Modifier.width(sdp(R.dimen._7sdp)))
        Column {
            Text(
                "Try-On images are stored only for this session.",
                color = Color.White.copy(alpha = 0.62f),
                fontSize = ssp(R.dimen._7ssp),
                lineHeight = ssp(R.dimen._10ssp),
                fontWeight = FontWeight.Medium,
                fontFamily = PoppinsFamily
            )
            Text(
                "You can delete all Try-On results after completing the session.",
                color = Color.White.copy(alpha = 0.38f),
                fontSize = ssp(R.dimen._6ssp),
                lineHeight = ssp(R.dimen._9ssp),
                fontFamily = PoppinsFamily,
                modifier = Modifier.offset(y = (-sdp(R.dimen._1sdp)))
            )
        }
    }
}

@Composable
private fun PhotoSourceSelectionDialog(
    onDismiss: () -> Unit,
    onSelectCamera: () -> Unit,
    onSelectGallery: () -> Unit
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnClickOutside = true,
            dismissOnBackPress = true
        )
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.60f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onDismiss
                ),
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .widthIn(max = sdp(R.dimen._320sdp))
                    .fillMaxWidth(0.90f)
                    .clip(RoundedCornerShape(sdp(R.dimen._16sdp)))
                    .background(
                        Brush.verticalGradient(
                            listOf(
                                Color(0xFF382717).copy(alpha = 0.98f),
                                Color(0xFF19110A).copy(alpha = 0.98f)
                            )
                        )
                    )
                    .border(
                        width = sdp(R.dimen._1sdp),
                        color = Color(0xFFB97A1E).copy(alpha = 0.75f),
                        shape = RoundedCornerShape(sdp(R.dimen._16sdp))
                    )
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {}
                    )
                    .padding(sdp(R.dimen._20sdp))
            ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            "Select Photo Source",
                            color = Color.White,
                            fontSize = ssp(R.dimen._18ssp),
                            fontWeight = FontWeight.Bold,
                            fontFamily = PoppinsFamily
                        )
                        Spacer(Modifier.height(sdp(R.dimen._2sdp)))
                        Text(
                            "Choose how you want to add your photo",
                            color = Color.White.copy(alpha = 0.70f),
                            fontSize = ssp(R.dimen._10ssp),
                            fontFamily = PoppinsFamily
                        )
                    }
                    Box(
                        modifier = Modifier
                            .size(sdp(R.dimen._30sdp))
                            .clip(CircleShape)
                            .background(Color.White.copy(alpha = 0.12f))
                            .clickable(onClick = onDismiss),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.Close,
                            contentDescription = "Close",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._16sdp))
                        )
                    }
                }

                Spacer(Modifier.height(sdp(R.dimen._14sdp)))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(sdp(R.dimen._1sdp))
                        .background(
                            Brush.horizontalGradient(
                                listOf(Color(0xFFF2B53F), Color(0xFFD88A18), Color.Transparent)
                            )
                        )
                )
                Spacer(Modifier.height(sdp(R.dimen._18sdp)))

                PhotoSourceOptionCard(
                    icon = {
                        Image(
                            painter = painterResource(R.drawable.camera_icon_),
                            contentDescription = null,
                            colorFilter = ColorFilter.tint(Color(0xFFF2B53F)),
                            modifier = Modifier.size(sdp(R.dimen._22sdp))
                        )
                    },
                    title = "Camera",
                    subtitle = "Capture photo using device camera",
                    onClick = onSelectCamera
                )

                Spacer(Modifier.height(sdp(R.dimen._12sdp)))

                PhotoSourceOptionCard(
                    icon = {
                        Icon(
                            Icons.Default.Add,
                            contentDescription = null,
                            tint = Color(0xFFF2B53F),
                            modifier = Modifier.size(sdp(R.dimen._22sdp))
                        )
                    },
                    title = "Gallery",
                    subtitle = "Select an existing photo from device gallery",
                    onClick = onSelectGallery
                )
            }
        }
    }
}
}

@Composable
private fun PhotoSourceOptionCard(
    icon: @Composable () -> Unit,
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
            .background(Color(0xFF2B1E10).copy(alpha = 0.85f))
            .border(
                width = sdp(R.dimen._1sdp),
                color = Color(0xFFB97A1E).copy(alpha = 0.55f),
                shape = RoundedCornerShape(sdp(R.dimen._12sdp))
            )
            .clickable(onClick = onClick)
            .padding(horizontal = sdp(R.dimen._14sdp), vertical = sdp(R.dimen._14sdp)),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(sdp(R.dimen._42sdp))
                .clip(CircleShape)
                .background(Color(0xFFE7A52C).copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            icon()
        }
        Spacer(Modifier.width(sdp(R.dimen._14sdp)))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                title,
                color = Color.White,
                fontSize = ssp(R.dimen._15ssp),
                fontWeight = FontWeight.SemiBold,
                fontFamily = PoppinsFamily
            )
            Spacer(Modifier.height(sdp(R.dimen._2sdp)))
            Text(
                subtitle,
                color = Color.White.copy(alpha = 0.70f),
                fontSize = ssp(R.dimen._9ssp),
                fontFamily = PoppinsFamily
            )
        }
    }
}

@Preview(name = "Photo Upload - Phone", showBackground = true, widthDp = 375, heightDp = 667)
@Composable
private fun PhotoUploadPagePreview() {
    TryMeTheme {
        PhotoUploadPage(onBack = {})
    }
}
