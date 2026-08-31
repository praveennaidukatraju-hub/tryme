package tryme.nice.interactive.ui.screens

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.provider.MediaStore
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.viewinterop.AndroidView
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.components.AppHeaderLogo
import tryme.nice.interactive.ui.components.AppLoadingIndicator
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import java.io.File

/**
 * Generic in-app WebView screen with a top navbar "Go to App" exit action.
 * Used to embed external web surfaces (e.g. the Try-On Library) without
 * leaving the app shell.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewPage(
    url: String,
    onExit: () -> Unit,
    modifier: Modifier = Modifier
) {
    val isPreview = LocalInspectionMode.current
    val context = LocalContext.current
    val currentOnExit by rememberUpdatedState(onExit)

    var webView by remember { mutableStateOf<WebView?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var hasError by remember { mutableStateOf(false) }
    var reloadTick by remember { mutableStateOf(0) }

    // Bridges WebView's file-input click to the system camera/gallery pickers —
    // stock WebView has no built-in file-chooser UI without this wiring.
    var pendingFileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    // Set from the HTML file-input's own `multiple` attribute (WebChromeClient's
    // FileChooserParams.mode) so the system gallery picker matches what the page asked
    // for — e.g. the bulk-upload page's multi-select input vs. a single-photo input.
    var pendingAllowMultiple by remember { mutableStateOf(false) }

    val filePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = pendingFileCallback
        pendingFileCallback = null
        val cameraUri = pendingCameraUri
        pendingCameraUri = null

        val resultUris = if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val clipData = data?.clipData
            when {
                // Multiple items selected from the gallery.
                clipData != null && clipData.itemCount > 0 ->
                    Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
                data?.data != null -> arrayOf(data.data!!)
                cameraUri != null -> arrayOf(cameraUri)
                else -> null
            }
        } else null

        callback?.onReceiveValue(resultUris)
    }

    // Builds and launches the gallery/camera chooser for the file-input click that's
    // already pending in pendingFileCallback. Camera is only offered when includeCamera
    // is true — callers gate that on the CAMERA runtime permission, since resolveActivity()
    // alone doesn't reflect whether the permission is actually granted, and firing
    // ACTION_IMAGE_CAPTURE without it silently fails to launch on many devices.
    val launchFileChooser: (includeCamera: Boolean) -> Unit = launchFileChooser@{ includeCamera ->
        val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
            if (pendingAllowMultiple) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }

        val chooserIntent = Intent.createChooser(galleryIntent, "Select or capture a photo").apply {
            if (includeCamera) {
                val photoFile = File(
                    context.cacheDir,
                    "webview_capture_${System.currentTimeMillis()}.jpg"
                )
                val photoUri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    photoFile
                )
                pendingCameraUri = photoUri

                val captureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                    putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
                    addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
                if (captureIntent.resolveActivity(context.packageManager) != null) {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(captureIntent))
                }
            }
        }

        filePickerLauncher.launch(chooserIntent)
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        // Only re-open the chooser if a file-input click is still waiting on us —
        // avoids relaunching the chooser from a stray/late permission callback.
        if (pendingFileCallback != null) {
            launchFileChooser(granted)
        }
    }

    // Stops the page, wipes navigation history so re-opening this screen starts
    // fresh, then hands control back to the caller — matches "clear webview, go app".
    val clearAndExit: () -> Unit = {
        webView?.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
        }
        currentOnExit()
    }

    BackHandler {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            clearAndExit()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                clearHistory()
                destroy()
            }
            webView = null
        }
    }

    val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding())

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        Spacer(Modifier.height(statusBarH))

        // ── Navbar: Go to App ──────────────────────────────────────────────
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF141210))
                .padding(horizontal = sdp(R.dimen._16sdp), vertical = sdp(R.dimen._10sdp))
        ) {
            AppHeaderLogo(modifier = Modifier.align(Alignment.CenterStart))

            Row(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .clip(RoundedCornerShape(sdp(R.dimen._8sdp)))
                    .background(
                        Brush.linearGradient(listOf(Color(0xFFE7A52C), Color(0xFF9B5100)))
                    )
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = clearAndExit
                    )
                    .padding(horizontal = sdp(R.dimen._12sdp), vertical = sdp(R.dimen._8sdp)),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Go to Virtual Try-on",
                    color = Color.White,
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = ssp(R.dimen._12ssp)
                )
                Spacer(Modifier.width(sdp(R.dimen._4sdp)))
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ExitToApp,
                    contentDescription = "Go to App",
                    tint = Color.White,
                    modifier = Modifier.width(sdp(R.dimen._16sdp))
                )
            }
        }

        // ── WebView content ───────────────────────────────────────────────
        Box(
            modifier = Modifier
                .fillMaxSize()
                .weight(1f)
        ) {
            if (!isPreview) {
                AndroidView(
                    factory = { ctx ->
                        WebView(ctx).apply {
                            layoutParams = ViewGroup.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT
                            )
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.useWideViewPort = true
                            settings.loadWithOverviewMode = true
                            settings.setSupportZoom(true)
                            settings.builtInZoomControls = true
                            settings.displayZoomControls = false
                            settings.mediaPlaybackRequiresUserGesture = false
                            webViewClient = object : WebViewClient() {
                                override fun onPageStarted(view: WebView?, loadedUrl: String?, favicon: Bitmap?) {
                                    isLoading = true
                                    hasError = false
                                }

                                override fun onPageFinished(view: WebView?, loadedUrl: String?) {
                                    isLoading = false
                                }

                                override fun onReceivedError(
                                    view: WebView?,
                                    request: WebResourceRequest?,
                                    error: WebResourceError?
                                ) {
                                    if (request == null || request.isForMainFrame) {
                                        isLoading = false
                                        hasError = true
                                    }
                                }
                            }
                            webChromeClient = object : WebChromeClient() {
                                override fun onShowFileChooser(
                                    view: WebView?,
                                    filePathCallback: ValueCallback<Array<Uri>>?,
                                    fileChooserParams: FileChooserParams?
                                ): Boolean {
                                    // Cancel any picker still awaiting a result before starting a new one.
                                    pendingFileCallback?.onReceiveValue(null)
                                    pendingFileCallback = filePathCallback
                                    pendingAllowMultiple =
                                        fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE

                                    val cameraGranted = ContextCompat.checkSelfPermission(
                                        context,
                                        Manifest.permission.CAMERA
                                    ) == PackageManager.PERMISSION_GRANTED

                                    if (cameraGranted) {
                                        launchFileChooser(true)
                                    } else {
                                        // Request permission first; the launcher's callback opens
                                        // the chooser once the result comes back (with camera
                                        // included if granted, gallery-only otherwise).
                                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                                    }
                                    return true
                                }
                            }
                            webView = this
                            loadUrl(url)
                        }
                    },
                    update = { view ->
                        // Only reacts to explicit retry taps — url/reloadTick don't
                        // change on recomposition otherwise, so this won't reload
                        // on every unrelated state change (e.g. isLoading flips).
                        if (reloadTick > 0) {
                            view.loadUrl(url)
                        }
                    },
                    modifier = Modifier.fillMaxSize()
                )
            }

            if (isLoading && !hasError) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black),
                    contentAlignment = Alignment.Center
                ) {
                    AppLoadingIndicator(size = sdp(R.dimen._32sdp), color = Color(0xFFE7A52C))
                }
            }

            if (hasError) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black)
                        .padding(sdp(R.dimen._24sdp)),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        modifier = Modifier.widthIn(max = sdp(R.dimen._screen_container_width)),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Warning,
                            contentDescription = null,
                            tint = Color(0xFFD88A18),
                            modifier = Modifier.width(sdp(R.dimen._36sdp))
                        )
                        Spacer(Modifier.height(sdp(R.dimen._12sdp)))
                        Text(
                            text = "Couldn't load this page. Please check your connection and try again.",
                            color = Color.White,
                            fontFamily = PoppinsFamily,
                            fontSize = ssp(R.dimen._13ssp),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                        Spacer(Modifier.height(sdp(R.dimen._20sdp)))
                        Row(
                            modifier = Modifier
                                .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
                                .background(
                                    Brush.linearGradient(listOf(Color(0xFFE7A52C), Color(0xFF9B5100)))
                                )
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClick = {
                                        hasError = false
                                        isLoading = true
                                        reloadTick += 1
                                    }
                                )
                                .padding(horizontal = sdp(R.dimen._24sdp), vertical = sdp(R.dimen._12sdp)),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center
                        ) {
                            Text(
                                text = "RETRY",
                                color = Color.White,
                                fontFamily = PoppinsFamily,
                                fontWeight = FontWeight.Bold,
                                fontSize = ssp(R.dimen._14ssp)
                            )
                        }
                    }
                }
            }
        }
    }
}
