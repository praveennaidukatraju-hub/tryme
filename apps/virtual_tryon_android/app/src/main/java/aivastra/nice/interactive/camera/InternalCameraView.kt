package tryme.nice.interactive.camera

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Log
import android.util.Size
import android.view.Surface
import android.view.WindowManager
import android.hardware.camera2.CaptureRequest
import tryme.nice.interactive.utils.CrashReporter
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.Preview as CameraXPreview
import androidx.camera.extensions.ExtensionMode
import androidx.camera.extensions.ExtensionsManager
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.ui.components.AppHeaderLogo
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@Composable
fun InternalCameraView(
    onBack: () -> Unit,
    onPhotoCaptured: (Uri) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val isPreview = LocalInspectionMode.current
    val scope = rememberCoroutineScope()
    val statusBarH: Dp = if (isPreview) 28.dp else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    var settings by remember { mutableStateOf(CameraSessionSettings.current) }
    var showSettingsSheet by remember { mutableStateOf(false) }

    LaunchedEffect(settings) {
        CameraSessionSettings.current = settings
    }

    var lensFacing by remember { mutableIntStateOf(CameraSelector.LENS_FACING_BACK) }
    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }
    var boundCamera by remember { mutableStateOf<Camera?>(null) }
    var isCapturing by remember { mutableStateOf(false) }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }

    var countdown by remember { mutableIntStateOf(settings.countdownSeconds) }
    var availablePictureSizes by remember { mutableStateOf<List<Size>>(emptyList()) }
    var showTimerOptions by remember { mutableStateOf(false) }
    // Only auto-pick the highest resolution once per screen visit, so a user's later, explicit
    // "Auto" choice isn't silently overridden the next time the lens (front/back) is switched.
    var hasAppliedDefaultPictureSize by remember { mutableStateOf(false) }

    val previewView = remember {
        PreviewView(context).apply {
            // FILL_CENTER keeps framing consistent (no stretch/letterbox) across the very
            // different screen sizes phones vs. kiosk panels present.
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    LaunchedEffect(Unit) {
        if (!isPreview) {
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({
                try {
                    cameraProvider = future.get()
                } catch (e: Exception) {
                    Log.e("InternalCameraView", "Failed to obtain ProcessCameraProvider", e)
                }
            }, ContextCompat.getMainExecutor(context))
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            try {
                cameraProvider?.unbindAll()
            } catch (e: Exception) {
                Log.e("InternalCameraView", "Failed to unbind camera on dispose", e)
            }
        }
    }

    LaunchedEffect(settings.cameraFacing) {
        lensFacing = when (settings.cameraFacing) {
            CameraFacingOption.BACK -> CameraSelector.LENS_FACING_BACK
            CameraFacingOption.FRONT -> CameraSelector.LENS_FACING_FRONT
        }
    }

    LaunchedEffect(lensFacing) {
        if (isPreview) return@LaunchedEffect
        val sizes = withContext(Dispatchers.IO) { queryOutputPictureSizes(context, lensFacing) }
        availablePictureSizes = sizes
        // A resolution picked on the other lens may not exist on this one — fall back to auto
        // rather than silently applying a mismatched fallback size.
        if (settings.pictureSize != null && settings.pictureSize !in sizes) {
            settings = settings.copy(pictureSize = null)
        }
        // Default "Picture Resolution" to the highest size this camera actually reports,
        // instead of leaving it on the coarse Auto/quality-tier fallback.
        if (!hasAppliedDefaultPictureSize && settings.pictureSize == null && sizes.isNotEmpty()) {
            val highest = sizes.maxByOrNull { it.width.toLong() * it.height.toLong() }
            if (highest != null) {
                settings = settings.copy(pictureSize = highest)
            }
            hasAppliedDefaultPictureSize = true
        }
    }

    LaunchedEffect(
        cameraProvider,
        lensFacing,
        settings.hdrOption,
        settings.captureQuality,
        settings.resolutionRatio,
        settings.surfaceStreamType,
        settings.pictureSize
    ) {
        if (isPreview) return@LaunchedEffect
        val provider = cameraProvider ?: return@LaunchedEffect

        previewView.implementationMode = when (settings.surfaceStreamType) {
            SurfaceStreamTypeOption.SURFACE_VIEW -> PreviewView.ImplementationMode.PERFORMANCE
            SurfaceStreamTypeOption.TEXTURE_VIEW -> PreviewView.ImplementationMode.COMPATIBLE
        }

        val resolutionSelector = settings.toResolutionSelector()

        val preview = CameraXPreview.Builder()
            .setResolutionSelector(resolutionSelector)
            .build()
            .also { it.surfaceProvider = previewView.surfaceProvider }

        val jpegQuality = if (settings.pictureSize != null) 100 else settings.captureQuality.toJpegQuality()
        val captureBuilder = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setJpegQuality(jpegQuality)
            .setResolutionSelector(resolutionSelector)
            // Kiosk boxes are often fixed-mount with no accelerometer, so CameraX's own
            // rotation defaults can't be trusted — tell it the real display rotation explicitly.
            .setTargetRotation(currentSurfaceRotation(context))
        applyKioskCaptureTuning(context, captureBuilder)
        val capture = captureBuilder.build()
        imageCapture = capture

        var cameraSelector = CameraSelector.Builder()
            .requireLensFacing(lensFacing)
            .build()

        if (settings.hdrOption != HdrOption.HDR_OFF) {
            cameraSelector = resolveHdrCameraSelector(
                context = context,
                provider = provider,
                baseSelector = cameraSelector,
                forceHdr = settings.hdrOption == HdrOption.HDR_ON
            )
        }

        try {
            provider.unbindAll()
            val camera = provider.bindToLifecycle(
                lifecycleOwner,
                cameraSelector,
                preview,
                capture
            )
            boundCamera = camera
            applyDefaultExposure(camera)
        } catch (e: Exception) {
            Log.e("InternalCameraView", "Tuned camera binding failed, retrying with defaults", e)
            try {
                val fallbackCapture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                    .build()
                imageCapture = fallbackCapture
                provider.unbindAll()
                val camera = provider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.Builder().requireLensFacing(lensFacing).build(),
                    CameraXPreview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider },
                    fallbackCapture
                )
                boundCamera = camera
                applyDefaultExposure(camera)
            } catch (fallbackError: Exception) {
                Log.e("InternalCameraView", "Fallback camera binding failed", fallbackError)
            }
        }
    }

    LaunchedEffect(countdown) {
        if (countdown > 0 && !isPreview) {
            delay(1000)
            if (countdown == 1) {
                countdown = 0
                capturePhoto(
                    context = context,
                    scope = scope,
                    camera = boundCamera,
                    previewView = previewView,
                    imageCapture = imageCapture,
                    isFrontCamera = (lensFacing == CameraSelector.LENS_FACING_FRONT),
                    onStart = { isCapturing = true },
                    onCaptured = { uri ->
                        isCapturing = false
                        onPhotoCaptured(uri)
                    },
                    onError = {
                        isCapturing = false
                    }
                )
            } else {
                countdown -= 1
            }
        }
    }

    Box(modifier = modifier.fillMaxSize().background(Color.Black)) {
        if (isPreview) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xFF1B120B)),
                contentAlignment = Alignment.Center
            ) {
                Image(
                    painter = painterResource(R.drawable.take_photo_icon),
                    contentDescription = "Camera Preview Placeholder",
                    modifier = Modifier.size(sdp(R.dimen._120sdp))
                )
            }
        } else {
            AndroidView(
                factory = { previewView },
                modifier = Modifier.fillMaxSize()
            )
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    start = sdp(R.dimen._18sdp),
                    end = sdp(R.dimen._18sdp),
                    top = statusBarH + sdp(R.dimen._10sdp),
                    bottom = sdp(R.dimen._22sdp) + navBarH
                ),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Top Header Bar
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(sdp(R.dimen._38sdp))
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
                        modifier = Modifier.size(sdp(R.dimen._14sdp))
                    )
                }

                AppHeaderLogo()
            }

            // Banner Message & Countdown
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Text(
                    text = "Smile Your Virtual TryOn Begins Now",
                    color = Color.White,
                    fontSize = ssp(R.dimen._15ssp),
                    fontWeight = FontWeight.Medium,
                    fontFamily = PoppinsFamily
                )

                Spacer(Modifier.height(sdp(R.dimen._18sdp)))

                if (countdown > 0) {
                    Text(
                        text = countdown.toString(),
                        color = Color.White,
                        fontSize = ssp(R.dimen._55ssp),
                        fontWeight = FontWeight.Bold,
                        fontFamily = PoppinsFamily
                    )
                }
            }

            // Bottom Control Bar
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = sdp(R.dimen._20sdp)),
                horizontalArrangement = Arrangement.SpaceAround,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(sdp(R.dimen._12sdp)),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Timer: tap to pick a countdown duration; the selection stops/starts the
                    // pre-capture countdown immediately (Off cancels it, a duration restarts it).
                    Box {
                        Box(
                            modifier = Modifier
                                .size(sdp(R.dimen._camera_control_button_size))
                                .clip(CircleShape)
                                .background(Color.Black.copy(alpha = 0.5f))
                                .clickable { showTimerOptions = true },
                            contentAlignment = Alignment.Center
                        ) {
                            TimerIcon(
                                tint = Color.White,
                                modifier = Modifier.size(sdp(R.dimen._camera_control_timer_icon_size))
                            )
                            if (settings.timerOption != TimerOption.OFF) {
                                Text(
                                    text = "${settings.timerOption.seconds}",
                                    color = Color.White,
                                    fontSize = ssp(R.dimen._9ssp),
                                    fontWeight = FontWeight.Bold,
                                    fontFamily = PoppinsFamily,
                                    modifier = Modifier
                                        .align(Alignment.BottomEnd)
                                        .padding(bottom = sdp(R.dimen._3sdp), end = sdp(R.dimen._4sdp))
                                )
                            }
                        }

                        DropdownMenu(
                            expanded = showTimerOptions,
                            onDismissRequest = { showTimerOptions = false },
                            containerColor = Color(0xFF1B1E24)
                        ) {
                            TimerOption.values().forEach { option ->
                                val isSelected = settings.timerOption == option
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            text = option.label,
                                            color = if (isSelected) Color(0xFFE59B27) else Color.White,
                                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                            fontFamily = PoppinsFamily,
                                            fontSize = ssp(R.dimen._14ssp)
                                        )
                                    },
                                    onClick = {
                                        settings = settings.copy(
                                            timerOption = option,
                                            countdownSeconds = option.seconds
                                        )
                                        // Apply immediately: cancels an in-progress countdown when
                                        // Off is picked, or restarts it at the new duration.
                                        countdown = option.seconds
                                        showTimerOptions = false
                                    }
                                )
                            }
                        }
                    }

                    Box(
                        modifier = Modifier
                            .size(sdp(R.dimen._camera_control_button_size))
                            .clip(CircleShape)
                            .background(Color.Black.copy(alpha = 0.5f))
                            .clickable { showSettingsSheet = true },
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = "Camera & Texture Settings",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._camera_control_icon_size))
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .size(sdp(R.dimen._72sdp))
                        .clip(CircleShape)
                        .background(
                            Brush.linearGradient(
                                listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                            )
                        )
                        .border(sdp(R.dimen._3sdp), Color.White, CircleShape)
                        .clickable(enabled = !isCapturing) {
                            countdown = 0
                            capturePhoto(
                                context = context,
                                scope = scope,
                                camera = boundCamera,
                                previewView = previewView,
                                imageCapture = imageCapture,
                                isFrontCamera = (lensFacing == CameraSelector.LENS_FACING_FRONT),
                                onStart = { isCapturing = true },
                                onCaptured = { uri ->
                                    isCapturing = false
                                    onPhotoCaptured(uri)
                                },
                                onError = { isCapturing = false }
                            )
                        },
                    contentAlignment = Alignment.Center
                ) {
                    if (isCapturing) {
                        CircularProgressIndicator(
                            color = Color.White,
                            strokeWidth = sdp(R.dimen._3sdp),
                            modifier = Modifier.size(sdp(R.dimen._32sdp))
                        )
                    } else {
                        Image(
                            painter = painterResource(R.drawable.camera_icon_),
                            contentDescription = "Capture Photo",
                            colorFilter = ColorFilter.tint(Color.White),
                            modifier = Modifier.size(sdp(R.dimen._30sdp))
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .size(sdp(R.dimen._camera_control_button_size))
                        .clip(CircleShape)
                        .background(Color.Black.copy(alpha = 0.5f))
                        .clickable {
                            lensFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK) {
                                CameraSelector.LENS_FACING_FRONT
                            } else {
                                CameraSelector.LENS_FACING_BACK
                            }
                            settings = settings.copy(
                                cameraFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK)
                                    CameraFacingOption.BACK else CameraFacingOption.FRONT
                            )
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = "Switch Camera",
                        tint = Color.White,
                        modifier = Modifier.size(sdp(R.dimen._camera_control_icon_size))
                    )
                }
            }
        }

        AnimatedVisibility(
            visible = showSettingsSheet,
            enter = fadeIn(),
            exit = fadeOut()
        ) {
            CameraSettingsDialog(
                initialSettings = settings,
                availablePictureSizes = availablePictureSizes,
                onDismiss = { showSettingsSheet = false },
                onSaveSettings = { updated ->
                    settings = updated
                    countdown = updated.countdownSeconds
                    showSettingsSheet = false
                }
            )
        }
    }
}

@Composable
private fun TimerIcon(tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val strokeWidth = size.minDimension * 0.1f
        val radius = size.minDimension / 2f - strokeWidth
        drawCircle(color = tint, radius = radius, style = Stroke(width = strokeWidth))
        drawLine(
            color = tint,
            start = center,
            end = Offset(center.x, center.y - radius * 0.55f),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round
        )
        drawLine(
            color = tint,
            start = center,
            end = Offset(center.x + radius * 0.4f, center.y),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round
        )
    }
}

private fun capturePhoto(
    context: Context,
    scope: CoroutineScope,
    camera: Camera?,
    previewView: PreviewView,
    imageCapture: ImageCapture?,
    isFrontCamera: Boolean,
    onStart: () -> Unit,
    onCaptured: (Uri) -> Unit,
    onError: () -> Unit
) {
    val capture = imageCapture ?: run {
        onError()
        return
    }
    onStart()

    scope.launch {
        try {
            // Kiosk/fixed-mount cameras often sit with AF/AE not yet converged between shots;
            // re-locking on the frame center right before the shutter is what actually fixes
            // the "blurry, washed out" kiosk captures (mirrors what the legacy CameraX activity did).
            lockFocusAndExposure(camera, previewView)
            capture.targetRotation = currentSurfaceRotation(context)

            val file = File(context.cacheDir, "camera_capture_${System.currentTimeMillis()}.jpg")
            val outputOptions = ImageCapture.OutputFileOptions.Builder(file).build()

            val savedUri = suspendCancellableCoroutine<Uri> { cont ->
                capture.takePicture(
                    outputOptions,
                    ContextCompat.getMainExecutor(context),
                    object : ImageCapture.OnImageSavedCallback {
                        override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                            cont.resume(outputFileResults.savedUri ?: Uri.fromFile(file))
                        }

                        override fun onError(exception: ImageCaptureException) {
                            cont.resumeWithException(exception)
                        }
                    }
                )
            }

            val fixedUri = fixImageRotationFromUri(
                context = context,
                imageUri = savedUri,
                cameraResultRotation = currentSurfaceRotation(context),
                isFrontCamera = isFrontCamera
            )

//            val fixedUri = fixImageRotationFromUri(
//                context = context,
//                imageUri = savedUri,
//                cameraResultRotation = 0,
//                isFrontCamera = isFrontCamera
//            )
            onCaptured(fixedUri)
        } catch (e: Exception) {
            Log.e("InternalCameraView", "Photo capture failed", e)
            onError()
        }
    }
}

private fun applyDefaultExposure(camera: Camera) {
    try {
        val exposureState = camera.cameraInfo.exposureState
        if (!exposureState.isExposureCompensationSupported) return
        val range = exposureState.exposureCompensationRange
        if (range.lower <= 0 && range.upper >= 0) {
            camera.cameraControl.setExposureCompensationIndex(0)
        }
    } catch (e: Exception) {
        Log.e("InternalCameraView", "Failed to reset exposure", e)
    }
}

private suspend fun lockFocusAndExposure(camera: Camera?, previewView: PreviewView) {
    val cam = camera ?: return
    if (previewView.width == 0 || previewView.height == 0) return
    try {
        val factory = previewView.meteringPointFactory
        val point = factory.createPoint(previewView.width / 2f, previewView.height / 2f)
        val action = FocusMeteringAction.Builder(
            point,
            FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE or FocusMeteringAction.FLAG_AWB
        ).setAutoCancelDuration(5, TimeUnit.SECONDS).build()

        suspendCancellableCoroutine<Unit> { cont ->
            val future = cam.cameraControl.startFocusAndMetering(action)
            future.addListener(
                { if (cont.isActive) cont.resume(Unit) },
                ContextCompat.getMainExecutor(previewView.context)
            )
        }
    } catch (e: Exception) {
        Log.e("InternalCameraView", "Focus/exposure lock failed", e)
    }
}

@OptIn(ExperimentalCamera2Interop::class)
private fun applyKioskCaptureTuning(context: Context, builder: ImageCapture.Builder) {
    // Generic kiosk/USB camera HALs default to fast, low-quality JPEG encode and noise
    // reduction to save CPU. Forcing these Camera2 request keys to HIGH_QUALITY is what
    // actually raises captured quality on those boxes; phones already default to this.
    if (!hasUsbCamera(context) && !isKioskDevice(context)) return
    try {
        val extender = Camera2Interop.Extender(builder)
        extender.setCaptureRequestOption(CaptureRequest.JPEG_QUALITY, 100.toByte())
        extender.setCaptureRequestOption(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY)
        extender.setCaptureRequestOption(
            CaptureRequest.NOISE_REDUCTION_MODE,
            CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY
        )
        extender.setCaptureRequestOption(
            CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE,
            CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE_HIGH_QUALITY
        )
        extender.setCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
        extender.setCaptureRequestOption(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
    } catch (e: Exception) {
        Log.e("InternalCameraView", "Camera2Interop tuning unsupported on this device", e)
    }
}

private suspend fun resolveHdrCameraSelector(
    context: Context,
    provider: ProcessCameraProvider,
    baseSelector: CameraSelector,
    forceHdr: Boolean
): CameraSelector {
    val extensionsManager = awaitExtensionsManager(context, provider) ?: return baseSelector
    return try {
        when {
            extensionsManager.isExtensionAvailable(baseSelector, ExtensionMode.HDR) ->
                extensionsManager.getExtensionEnabledCameraSelector(baseSelector, ExtensionMode.HDR)
            !forceHdr && extensionsManager.isExtensionAvailable(baseSelector, ExtensionMode.AUTO) ->
                extensionsManager.getExtensionEnabledCameraSelector(baseSelector, ExtensionMode.AUTO)
            else -> baseSelector
        }
    } catch (e: Exception) {
        Log.e("InternalCameraView", "HDR extension selection failed", e)
        baseSelector
    }
}

private suspend fun awaitExtensionsManager(
    context: Context,
    provider: ProcessCameraProvider
): ExtensionsManager? = suspendCancellableCoroutine { cont ->
    val future = ExtensionsManager.getInstanceAsync(context, provider)
    future.addListener(
        {
            try {
                cont.resume(future.get())
            } catch (e: Exception) {
                Log.e("InternalCameraView", "Failed to obtain ExtensionsManager", e)
                cont.resume(null)
            }
        },
        ContextCompat.getMainExecutor(context)
    )
}

fun isKioskDevice(context: Context): Boolean {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val isLockTask = am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_LOCKED

    val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    val isDeviceOwner = dpm.isDeviceOwnerApp(context.packageName)

    val isTv = context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)

    val manufacturer = Build.MANUFACTURER.lowercase()
    val model = Build.MODEL.lowercase()
    val device = Build.DEVICE.lowercase()
    val product = Build.PRODUCT.lowercase()

    val isCustomKiosk =
        manufacturer.contains("rockchip") ||
        manufacturer.contains("amlogic") ||
        manufacturer.contains("allwinner") ||
        model.contains("rk") ||
        model.contains("box") ||
        model.contains("tv") ||
        device.contains("box") ||
        device.contains("tv") ||
        device.contains("kiosk") ||
        product.contains("box") ||
        product.contains("tv")

    return isLockTask || isDeviceOwner || isTv || isCustomKiosk
}

fun hasUsbCamera(context: Context): Boolean {
    try {
        val cameraManager =
            context.getSystemService(Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager

        for (cameraId in cameraManager.cameraIdList) {
            val characteristics = cameraManager.getCameraCharacteristics(cameraId)
            val lensFacing = characteristics.get(
                android.hardware.camera2.CameraCharacteristics.LENS_FACING
            )

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val capabilities = characteristics.get(
                    android.hardware.camera2.CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES
                )
                if (capabilities?.contains(android.hardware.camera2.CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_SYSTEM_CAMERA) == true) {
                    return true
                }
            }

            if (lensFacing == null) return true
        }
        return false
    } catch (e: Exception) {
        CrashReporter.recordException(e, "InternalCameraView")
        return false
    }
}

private fun currentSurfaceRotation(context: Context): Int {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        context.display?.rotation ?: Surface.ROTATION_0
    } else {
        @Suppress("DEPRECATION")
        (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation
    }
}

// CameraX's CameraSelector.LENS_FACING_* constants are numerically identical to
// CameraCharacteristics.LENS_FACING_* (both FRONT=0, BACK=1), so lensFacing can be
// compared against LENS_FACING directly without translation.
fun queryOutputPictureSizes(context: Context, lensFacing: Int): List<Size> {
    return try {
        val cameraManager =
            context.getSystemService(Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager

        val matchingCameraId = cameraManager.cameraIdList.firstOrNull { cameraId ->
            val characteristics = cameraManager.getCameraCharacteristics(cameraId)
            characteristics.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING) == lensFacing
        } ?: cameraManager.cameraIdList.firstOrNull() ?: return emptyList()

        val characteristics = cameraManager.getCameraCharacteristics(matchingCameraId)
        val streamMap = characteristics.get(
            android.hardware.camera2.CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP
        ) ?: return emptyList()

        streamMap.getOutputSizes(android.graphics.ImageFormat.JPEG)
            ?.distinct()
            ?.sortedByDescending { it.width.toLong() * it.height.toLong() }
            ?: emptyList()
    } catch (e: Exception) {
        Log.e("InternalCameraView", "Failed to query device picture sizes", e)
        emptyList()
    }
}

suspend fun fixImageRotationFromUri(
    context: Context,
    imageUri: Uri,
    cameraResultRotation: Int = 0,
    isFrontCamera: Boolean = false,
    // Only camera captures have the "landscape raw buffer with no/unreliable EXIF" problem
    // that the width>height fallback below works around. Gallery- and QR-sourced images can
    // be legitimately landscape, so applying that fallback to them force-rotates otherwise
    // correct photos — this is what caused kiosk gallery/QR uploads to come out sideways.
    applyOrientationFallback: Boolean = true
): Uri = withContext(Dispatchers.IO) {
    try {
        val inputStream = context.contentResolver.openInputStream(imageUri) ?: return@withContext imageUri

        val tempFile = File(context.cacheDir, "fixed_${System.currentTimeMillis()}.jpg")
        FileOutputStream(tempFile).use { out ->
            inputStream.copyTo(out)
        }
        inputStream.close()

        val exif = ExifInterface(tempFile.absolutePath)
        val orientation = exif.getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL
        )

        val isUsbOrKiosk = hasUsbCamera(context) || isKioskDevice(context)

        var rotationDegrees = when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270 -> 270
            else -> 0
        }

        // This app only ever wants portrait photos out of the camera. A landscape-shaped raw
        // buffer gets straightened to portrait when EXIF gives no rotation hint — some kiosk/USB
        // camera HALs report no orientation metadata at all. Trust the EXIF value CameraX wrote
        // (the standard interpretation) and only guess via buffer shape when EXIF gave nothing
        // to work with. Checked via a bounds-only decode (reads just the JPEG header, no pixel
        // data) since at this point we don't yet know whether a transform is even needed.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(tempFile.absolutePath, bounds)
        if (rotationDegrees == 0 && applyOrientationFallback && bounds.outWidth > bounds.outHeight) {
            rotationDegrees = 90
        }

        val shouldMirror = isFrontCamera && !isUsbOrKiosk

        if (rotationDegrees == 0 && !shouldMirror) {
            return@withContext FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                tempFile
            )
        }

        // Only pay for a full pixel decode once a transform is actually needed — this is the
        // expensive step, and scales with the capture resolution.
        val bitmap = BitmapFactory.decodeFile(tempFile.absolutePath) ?: return@withContext imageUri

        val matrix = Matrix()

        if (rotationDegrees != 0) {
            matrix.postRotate(rotationDegrees.toFloat())
        }

        if (shouldMirror) {
            matrix.postScale(
                -1f,
                1f,
                bitmap.width / 2f,
                bitmap.height / 2f
            )
        }

        val fixedBitmap = Bitmap.createBitmap(
            bitmap,
            0,
            0,
            bitmap.width,
            bitmap.height,
            matrix,
            true
        )

        FileOutputStream(tempFile).use { out ->
            fixedBitmap.compress(Bitmap.CompressFormat.JPEG, 100, out)
        }

        val newExif = ExifInterface(tempFile.absolutePath)
        newExif.setAttribute(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL.toString()
        )
        newExif.saveAttributes()

        FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            tempFile
        )

    } catch (t: Throwable) {
        CrashReporter.recordException(t, "InternalCameraView")
        imageUri
    }
}

@Preview(name = "Internal Camera - Phone", showBackground = true, widthDp = 375, heightDp = 667)
@Composable
private fun InternalCameraViewPreview() {
    TryMeTheme {
        InternalCameraView(onBack = {}, onPhotoCaptured = {})
    }
}
