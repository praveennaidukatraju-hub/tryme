package tryme.nice.interactive.ui.screens

import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.widget.VideoView
import tryme.nice.interactive.utils.CrashReporter
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import tryme.nice.interactive.ui.components.AppDialog
import tryme.nice.interactive.ui.components.AppHeaderLogo
import tryme.nice.interactive.ui.components.AppToast
import tryme.nice.interactive.ui.components.ToastType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import kotlinx.coroutines.delay

/**
 * Custom VideoView subclass that forces layout measurement to occupy 100% of available parent container,
 * ensuring full-bleed edge-to-edge video rendering when paired with VIDEO_SCALING_MODE_SCALE_TO_FIT_WITH_CROPPING.
 */
private class FullScreenVideoView(context: Context) : VideoView(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = getDefaultSize(0, widthMeasureSpec)
        val height = getDefaultSize(0, heightMeasureSpec)
        setMeasuredDimension(width, height)
    }
}

// Rotates under the headline while the AI generation call is in flight, so the wait feels
// active rather than stalled on one static line.
private val processingStatusMessages = listOf(
    "Analyzing your photo...",
    "Matching the garment drape...",
    "Blending fabric textures...",
    "Applying AI styling...",
    "Adding finishing touches..."
)

@Composable
fun TryOnProcessingPage(
    videoUri: Uri?,
    elapsedSeconds: Int,
    errorMessage: String?,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onCancel: () -> Unit = onBack,
    modifier: Modifier = Modifier
) {
    TryOnProcessingContent(
        videoUri = videoUri,
        elapsedSeconds = elapsedSeconds,
        errorMessage = errorMessage,
        onBack = onBack,
        onRetry = onRetry,
        onCancel = onCancel,
        modifier = modifier
    )
}

@Composable
fun TryOnProcessingContent(
    videoUri: Uri? = null,
    elapsedSeconds: Int = 0,
    errorMessage: String?,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onCancel: () -> Unit = onBack,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val isPreview = LocalInspectionMode.current
    val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    // There is no cancel-generation API yet - the job keeps running server-side regardless,
    // so back/gesture navigation during an active generation must not leave the screen (it
    // would strand the user with no way back to a job that's still processing). Once it has
    // failed (errorMessage != null) there's nothing left to protect against, so let it through.
    var showLeaveWarningToast by remember { mutableStateOf(false) }
    BackHandler {
        if (errorMessage == null) {
            showLeaveWarningToast = true
        } else {
            onCancel()
        }
    }

    var hasVideoError by remember { mutableStateOf(false) }

    // Fake-but-reassuring progress: climbs fast at first, then eases off and caps below 100%
    // while still generating, so it never looks "stuck" - real completion navigates away
    // before it would matter.
    var messageIndex by remember { mutableIntStateOf(0) }
    LaunchedEffect(errorMessage) {
        if (errorMessage != null) return@LaunchedEffect
        while (true) {
            delay(2600)
            messageIndex = (messageIndex + 1) % processingStatusMessages.size
        }
    }
    val targetProgress = remember(elapsedSeconds) {
        (1f - 1f / (1f + elapsedSeconds / 12f)).times(0.92f).coerceIn(0.06f, 0.92f)
    }
    val animatedProgress by animateFloatAsState(
        targetValue = targetProgress,
        animationSpec = tween(durationMillis = 900),
        label = "tryOnProgress"
    )

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // Layer 1: Full-Screen Background Video Player (Loaded from API config)
        if (videoUri != null && !hasVideoError && errorMessage == null) {
            AndroidView(
                factory = { ctx ->
                    FullScreenVideoView(ctx).apply {
                        setVideoURI(videoUri)
                        setOnPreparedListener { mediaPlayer ->
                            mediaPlayer.isLooping = true
                            try {
                                mediaPlayer.setVolume(0f, 0f)
                                mediaPlayer.setVideoScalingMode(MediaPlayer.VIDEO_SCALING_MODE_SCALE_TO_FIT_WITH_CROPPING)
                            } catch (e: Exception) {
                                CrashReporter.recordException(e, "TryOnProcessingPage")
                            }
                            mediaPlayer.start()
                        }
                        setOnErrorListener { _, what, extra ->
                            Log.e("TryOnProcessingPage", "VideoView error: what=$what, extra=$extra")
                            hasVideoError = true
                            true // Return true to suppress system "Can't play this video" popup
                        }
                    }
                },
                modifier = Modifier.fillMaxSize()
            )
        } else {
            Image(
                painter = painterResource(R.drawable.new_app_bg),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize()
            )
        }

        // Layer 1b: Warm Amber Wash - ties the video into the app's gold theme
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFE7A52C).copy(alpha = 0.12f))
        )

        // Layer 2: Top & Bottom Gradient Scrims for Readability
        // Top Gradient Scrim
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(sdp(R.dimen._180sdp))
                .align(Alignment.TopCenter)
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            Color.Black.copy(alpha = 0.85f),
                            Color.Black.copy(alpha = 0.45f),
                            Color.Transparent
                        )
                    )
                )
        )

        // Bottom Gradient Scrim
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(sdp(R.dimen._220sdp))
                .align(Alignment.BottomCenter)
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            Color.Transparent,
                            Color.Black.copy(alpha = 0.5f),
                            Color.Black.copy(alpha = 0.9f)
                        )
                    )
                )
        )

        // Layer 3: Floating UI Content
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    start = sdp(R.dimen._18sdp),
                    end = sdp(R.dimen._18sdp),
                    top = statusBarH + sdp(R.dimen._10sdp),
                    bottom = navBarH + sdp(R.dimen._16sdp)
                ),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Header & Headline Container (Constrained width for tablets)
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = sdp(R.dimen._screen_container_width)),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Top Header Bar (Centered Logo without back button)
                Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.Center
                ) {
                    AppHeaderLogo()
                }

                Spacer(Modifier.height(sdp(R.dimen._18sdp)))

                // Headline & Subtitle
                Text(
                    "Generating Your AI Try-On...",
                    color = Color.White,
                    fontSize = ssp(R.dimen._20ssp),
                    fontWeight = FontWeight.Bold,
                    fontFamily = PoppinsFamily,
                    textAlign = TextAlign.Center
                )

            }

            // Progress Container
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = sdp(R.dimen._screen_container_width)),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Rotating status text and progress bar - hidden once the error dialog takes over.
                if (errorMessage == null) {
                    // Rotating status line - keeps the wait feeling active
                    AnimatedContent(
                        targetState = messageIndex,
                        transitionSpec = {
                            (fadeIn(tween(400)) + slideInVertically(tween(400)) { it / 3 }) togetherWith
                                (fadeOut(tween(250)) + slideOutVertically(tween(250)) { -it / 3 })
                        },
                        contentAlignment = Alignment.Center,
                        label = "processingStatusMessage"
                    ) { idx ->
                        Text(
                            processingStatusMessages[idx],
                            color = Color.White.copy(alpha = 0.85f),
                            fontSize = ssp(R.dimen._15ssp),
                            fontWeight = FontWeight.Medium,
                            fontFamily = PoppinsFamily,
                            textAlign = TextAlign.Center
                        )
                    }

                    Spacer(Modifier.height(sdp(R.dimen._12sdp)))

                    // Progress Bar (gold gradient, matches app theme)
                    Row(
                        modifier = Modifier.fillMaxWidth(0.7f),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            "Processing",
                            color = Color.White.copy(alpha = 0.7f),
                            fontSize = ssp(R.dimen._11ssp),
                            fontFamily = PoppinsFamily,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            "${(animatedProgress * 100).toInt()}%",
                            color = Color(0xFFE7A52C),
                            fontSize = ssp(R.dimen._11ssp),
                            fontFamily = PoppinsFamily,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Spacer(Modifier.height(sdp(R.dimen._6sdp)))
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(0.7f)
                            .height(sdp(R.dimen._6sdp))
                            .clip(RoundedCornerShape(50))
                            .background(Color.White.copy(alpha = 0.18f))
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxHeight()
                                .fillMaxWidth(animatedProgress)
                                .clip(RoundedCornerShape(50))
                                .background(
                                    Brush.horizontalGradient(
                                        listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                                    )
                                )
                        )
                    }

                    // Keeps the progress bar clear of the device's gesture-navigation area,
                    // independent of the outer Column's bottom padding.
                    Spacer(Modifier.height(sdp(R.dimen._28sdp)))
                }
            }
        }

        // Leave-during-generation warning: shown instead of navigating away, since there is
        // no cancel-generation API to actually stop the in-flight job.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .padding(bottom = navBarH + sdp(R.dimen._12sdp))
        ) {
            AppToast(
                visible = showLeaveWarningToast,
                message = "Please wait — your Try-On is still generating.",
                type = ToastType.WARNING,
                autoDismissMs = 3000L,
                onDismiss = { showLeaveWarningToast = false }
            )
        }

        // Error Dialog: shown on any generation / API failure
        errorMessage?.let { msg ->
            val cleanMsg = tryme.nice.interactive.utils.ErrorParser.parseErrorMessage(msg, msg)
            val isSessionExpired = cleanMsg.contains("expired", ignoreCase = true) || cleanMsg.contains("not owned", ignoreCase = true)
            val isInsufficientCredits = cleanMsg.contains("insufficient credit", ignoreCase = true)

            if (isInsufficientCredits) {
                // Play Store treats in-app "buy credits" prompts as a digital-goods purchase
                // flow, which must go through Play Billing - so this dialog only points the
                // user to the AI Vastra account site instead of naming a price or "buy" action.
                AppDialog(
                    title = "Credits Unavailable",
                    message = "Your account doesn't have enough credits to complete this request. Please sign in to your AI Vastra account to manage your account.",
                    icon = Icons.Default.Warning,
                    confirmText = "Open AI Vastra",
                    cancelText = "Close",
                    onConfirm = {
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://app.tryme.com")))
                        } catch (e: Exception) {
                            CrashReporter.recordException(e, "TryOnProcessingPage")
                        }
                    },
                    onDismiss = onCancel
                )
            } else {
                val displayText = if (isSessionExpired) {
                    "Your photo upload session expired. Please re-upload your photo to continue."
                } else {
                    cleanMsg
                }
                AppDialog(
                    title = "Try-On Failed",
                    message = displayText,
                    icon = Icons.Default.Warning,
                    confirmText = if (isSessionExpired) "Re-upload Photo" else "Retry Try-On",
                    cancelText = "Cancel",
                    onConfirm = onRetry,
                    onDismiss = onCancel
                )
            }
        }
    }
}



