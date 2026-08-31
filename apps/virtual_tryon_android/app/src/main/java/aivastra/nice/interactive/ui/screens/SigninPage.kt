package tryme.nice.interactive.ui.screens

import tryme.nice.interactive.R
import tryme.nice.interactive.data.models.DeviceLoginResponse
import tryme.nice.interactive.ui.components.AppDialog
import tryme.nice.interactive.ui.components.AppHeaderLogo
import tryme.nice.interactive.ui.components.AppLoadingIndicator
import tryme.nice.interactive.ui.components.AppToast
import tryme.nice.interactive.ui.components.GradientButton
import tryme.nice.interactive.ui.components.ToastType
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.ButtonGradient
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import tryme.nice.interactive.viewmodels.LoginUiState
import tryme.nice.interactive.viewmodels.LoginViewModel
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel


// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Custom eye icons Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

private val VisibilityIcon: ImageVector = ImageVector.Builder(
    name = "Visibility", defaultWidth = 24.dp, defaultHeight = 24.dp,
    viewportWidth = 24f, viewportHeight = 24f
).apply {
    path(fill = SolidColor(Color.White)) {
        moveTo(12f, 4.5f)
        curveTo(7f, 4.5f, 2.73f, 7.61f, 1f, 12f)
        curveTo(2.73f, 16.39f, 7f, 19.5f, 12f, 19.5f)
        curveTo(17f, 19.5f, 21.27f, 16.39f, 23f, 12f)
        curveTo(21.27f, 7.61f, 17f, 4.5f, 12f, 4.5f)
        close()
        moveTo(12f, 17f)
        curveTo(9.24f, 17f, 7f, 14.76f, 7f, 12f)
        curveTo(7f, 9.24f, 9.24f, 7f, 12f, 7f)
        curveTo(14.76f, 7f, 17f, 9.24f, 17f, 12f)
        curveTo(17f, 14.76f, 14.76f, 17f, 12f, 17f)
        close()
        moveTo(12f, 9f)
        curveTo(10.34f, 9f, 9f, 10.34f, 9f, 12f)
        curveTo(9f, 13.66f, 10.34f, 15f, 12f, 15f)
        curveTo(13.66f, 15f, 15f, 13.66f, 15f, 12f)
        curveTo(15f, 10.34f, 13.66f, 9f, 12f, 9f)
        close()
    }
}.build()

private val VisibilityOffIcon: ImageVector = ImageVector.Builder(
    name = "VisibilityOff", defaultWidth = 24.dp, defaultHeight = 24.dp,
    viewportWidth = 24f, viewportHeight = 24f
).apply {
    path(fill = SolidColor(Color.White)) {
        moveTo(12f, 7f)
        curveTo(14.76f, 7f, 17f, 9.24f, 17f, 12f)
        lineTo(17f, 12.17f)
        lineTo(19.56f, 14.73f)
        curveTo(20.08f, 13.87f, 20.5f, 12.97f, 20.5f, 12f)
        curveTo(20.5f, 8.14f, 16.64f, 5f, 12f, 5f)
        curveTo(10.91f, 5f, 9.84f, 5.18f, 8.84f, 5.5f)
        lineTo(10.53f, 7.19f)
        curveTo(11.0f, 7.07f, 11.5f, 7f, 12f, 7f)
        close()
        moveTo(2f, 4.27f)
        lineTo(4.28f, 6.55f)
        lineTo(4.73f, 7f)
        curveTo(3.08f, 7.9f, 1.78f, 9.28f, 1f, 12f)
        curveTo(2.73f, 16.39f, 7f, 19.5f, 12f, 19.5f)
        curveTo(13.55f, 19.5f, 15.03f, 19.18f, 16.38f, 18.62f)
        lineTo(16.8f, 19.04f)
        lineTo(19.73f, 22f)
        lineTo(21f, 20.73f)
        lineTo(3.27f, 3f)
        close()
        moveTo(9f, 12f)
        curveTo(9f, 10.34f, 10.34f, 9f, 12f, 9f)
        lineTo(14.99f, 12f)
        lineTo(14.99f, 12.17f)
        lineTo(15.01f, 12.01f)
        curveTo(15.01f, 10.34f, 13.67f, 9f, 12f, 9f)
        lineTo(11.84f, 9.02f)
        close()
    }
}.build()

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Screen Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * SignInPage Ã¢â‚¬â€ premium, fully responsive sign-in screen with real-time Google Sign-In
 * and mandatory post-sign-in Business Details & Contact Form.
 */
private enum class SignInAttempt {
    None,
    Password,
    Google,
    ForceLogout
}

@Composable
fun SignInPage(
    onLoginSuccess: (DeviceLoginResponse) -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: LoginViewModel = viewModel()
) {
    val context = LocalContext.current
    // Stable per-physical-device identity for the backend's device-login/session-limit system.
    // Every install must send a distinct id here Ã¢â‚¬â€ a shared/hardcoded value makes the backend
    // treat all kiosks as one device, so any of them logging in silently rotates (and kills)
    // whichever other kiosk was already using that "device"'s session.
    val deviceId = remember {
        android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID)
            ?.takeIf { it.isNotBlank() }
            ?: java.util.UUID.randomUUID().toString()
    }
    val deviceName = remember {
        "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}".trim().ifBlank { "TryMe Kiosk" }
    }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    // Tracks which action triggered the shared uiState.Loading so only the
    // matching control renders a spinner.
    var signInAttempt by remember { mutableStateOf(SignInAttempt.None) }

    // Toast local state
    var toastVisible by remember { mutableStateOf(false) }
    var toastMessage by remember { mutableStateOf("") }
    var toastType by remember { mutableStateOf(ToastType.SUCCESS) }

    val uiState by viewModel.uiState.collectAsState()
    val isLoading = uiState is LoginUiState.Loading
    val isDeviceLimitReached = uiState is LoginUiState.DeviceLimitReached

    // React to state changes (success / error toasts)
    LaunchedEffect(uiState) {
        when (val state = uiState) {
            is LoginUiState.Success -> {
                signInAttempt = SignInAttempt.None
                toastMessage = "Welcome back, ${state.response.user.displayName}!"
                toastType = ToastType.SUCCESS
                toastVisible = true
                onLoginSuccess(state.response)
            }
            is LoginUiState.Error -> {
                signInAttempt = SignInAttempt.None
                toastMessage = state.message
                toastType = ToastType.ERROR
                toastVisible = true
            }
            is LoginUiState.Idle -> signInAttempt = SignInAttempt.None
            else -> Unit
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // Background
        Image(
            painter = painterResource(id = R.drawable.new_app_bg),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
        )

        // Root content: logo pinned at the top, everything else centered
        // vertically in the remaining space and scrollable so it can move
        // above the keyboard when a field is focused.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = sdp(R.dimen._24sdp)),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Status bar safe area
            val isPreview = LocalInspectionMode.current
            val statusBarHeight: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)

            // Ã¢â€â‚¬Ã¢â€â‚¬ Logo (excluded from vertical centering, always pinned at top) Ã¢â€â‚¬Ã¢â€â‚¬
            Column(
                modifier = Modifier
                    .widthIn(max = sdp(R.dimen._screen_container_width))
                    .fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.height(statusBarHeight))
                Spacer(modifier = Modifier.height(sdp(R.dimen._20sdp)))

                AppHeaderLogo(
                    modifier = Modifier.size(
                        width = sdp(R.dimen._250sdp),
                        height = sdp(R.dimen._65sdp)
                    )
                )
            }

            // Ã¢â€â‚¬Ã¢â€â‚¬ Everything else: vertically centered, scrolls above the keyboard Ã¢â€â‚¬Ã¢â€â‚¬
            Column(
                modifier = Modifier
                    .weight(1f)
                    .widthIn(max = sdp(R.dimen._screen_container_width))
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .imePadding(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Spacer(modifier = Modifier.height(sdp(R.dimen._30sdp)))

                // Title
                Text(
                    text = buildAnnotatedString {
                        withStyle(SpanStyle(color = Color.White)) { append("SIGN ") }
                        withStyle(SpanStyle(brush = ButtonGradient)) { append("IN") }
                    },
                    fontSize = ssp(R.dimen._32ssp),
                    fontWeight = FontWeight.Bold,
                    fontFamily = PoppinsFamily
                )

                Spacer(modifier = Modifier.height(sdp(R.dimen._6sdp)))

                Text(
                    text = "Enter your details to access your virtual\ntry-on experience",
                    color = Color.White.copy(alpha = 0.7f),
                    fontSize = ssp(R.dimen._13ssp),
                    fontFamily = PoppinsFamily,
                    textAlign = TextAlign.Center,
                    fontWeight = FontWeight.Normal
                )

                Spacer(modifier = Modifier.height(sdp(R.dimen._8sdp)))

                // Separator
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = sdp(R.dimen._12sdp))
                ) {
                    fun lineGradient() = Brush.horizontalGradient(
                        listOf(Color.Transparent, Color(0xFFD88A18), Color.Transparent)
                    )
                    Box(Modifier.weight(1f).height(sdp(R.dimen._1sdp)).background(lineGradient()))
                    Image(
                        painter = painterResource(R.drawable.star_icon),
                        contentDescription = null,
                        modifier = Modifier
                            .padding(horizontal = sdp(R.dimen._8sdp))
                            .size(sdp(R.dimen._18sdp))
                    )
                    Box(Modifier.weight(1f).height(sdp(R.dimen._1sdp)).background(lineGradient()))
                }

                Spacer(modifier = Modifier.height(sdp(R.dimen._8sdp)))

                // Ã¢â€â‚¬Ã¢â€â‚¬ Email field Ã¢â€â‚¬Ã¢â€â‚¬
                FieldLabel(text = "USER NAME / EMAIL")
                Spacer(modifier = Modifier.height(sdp(R.dimen._4sdp)))
                AuthTextField(
                    value = email,
                    onValueChange = { email = it },
                    enabled = !isLoading,
                    placeholder = "Enter email",
                    leadingIcon = {
                        Icon(Icons.Default.Person, null, tint = Color(0xFFD88A18))
                    }
                )

                Spacer(modifier = Modifier.height(sdp(R.dimen._16sdp)))

                // Ã¢â€â‚¬Ã¢â€â‚¬ Password field Ã¢â€â‚¬Ã¢â€â‚¬
                FieldLabel(text = "PASSWORD")
                Spacer(modifier = Modifier.height(sdp(R.dimen._4sdp)))
                AuthTextField(
                    value = password,
                    onValueChange = { password = it },
                    enabled = !isLoading,
                    placeholder = "Enter password",
                    leadingIcon = {
                        Icon(Icons.Default.Lock, null, tint = Color(0xFFD88A18))
                    },
                    trailingIcon = {
                        IconButton(onClick = { passwordVisible = !passwordVisible }) {
                            Icon(
                                imageVector = if (passwordVisible) VisibilityIcon else VisibilityOffIcon,
                                contentDescription = null,
                                tint = Color(0xFFD88A18)
                            )
                        }
                    },
                    visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation()
                )

                Spacer(modifier = Modifier.height(sdp(R.dimen._8sdp)))

//                // Forgot Password
//                Text(
//                    text = "Forgot Password?",
//                    color = Color(0xFFD88A18),
//                    fontSize = ssp(R.dimen._12ssp),
//                    fontWeight = FontWeight.Medium,
//                    fontFamily = PoppinsFamily,
//                    modifier = Modifier
//                        .align(Alignment.End)
//                        .clickable(enabled = !isLoading) { /* Forgot password handler */ }
//                )

                Spacer(modifier = Modifier.height(sdp(R.dimen._20sdp)))

                // Login Button
                GradientButton(
                    onClick = {
                        signInAttempt = SignInAttempt.Password
                        viewModel.login(email, password, deviceId = deviceId, deviceName = deviceName)
                    },
                    enabled = !isLoading,
                    width = sdp(R.dimen._0sdp),
                    height = sdp(R.dimen._action_button_height),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    if (isLoading && signInAttempt == SignInAttempt.Password) {
                        AppLoadingIndicator(size = sdp(R.dimen._22sdp), color = Color.White)
                    } else {
                        Text(
                            text = "LOGIN",
                            color = Color.White,
                            fontFamily = PoppinsFamily,
                            fontWeight = FontWeight.Bold,
                            fontSize = ssp(R.dimen._16ssp)
                        )
                        Spacer(modifier = Modifier.size(sdp(R.dimen._8sdp)))
                        Icon(
                            imageVector = Icons.Default.ArrowForward,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._18sdp))
                        )
                    }
                }

                Spacer(modifier = Modifier.height(sdp(R.dimen._16sdp)))

                // Ã¢â€â‚¬Ã¢â€â‚¬ "OR" separator Ã¢â€â‚¬Ã¢â€â‚¬
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Box(Modifier.weight(1f).height(1.dp).background(Color.White.copy(alpha = 0.15f)))
                    Text(
                        text = "OR",
                        color = Color.White.copy(alpha = 0.5f),
                        fontSize = ssp(R.dimen._11ssp),
                        fontFamily = PoppinsFamily,
                        modifier = Modifier.padding(horizontal = sdp(R.dimen._12sdp))
                    )
                    Box(Modifier.weight(1f).height(1.dp).background(Color.White.copy(alpha = 0.15f)))
                }

                Spacer(modifier = Modifier.height(sdp(R.dimen._16sdp)))

                // Ã¢â€â‚¬Ã¢â€â‚¬ Google Sign-In button Ã¢â€â‚¬Ã¢â€â‚¬
                GoogleSignInButton(
                    enabled = !isLoading,
                    isLoading = isLoading && signInAttempt == SignInAttempt.Google,
                    onClick = {
                        signInAttempt = SignInAttempt.Google
                        viewModel.loginWithGoogle(context, deviceId = deviceId, deviceName = deviceName)
                    }
                )

                val navBarHeight: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                Spacer(modifier = Modifier.height(sdp(R.dimen._24sdp) + navBarHeight))
            }
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Snackbar overlay Ã¢â€â‚¬Ã¢â€â‚¬
        val toastBottomInset = if (LocalInspectionMode.current) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .padding(bottom = sdp(R.dimen._12sdp) + toastBottomInset)
        ) {
            AppToast(
                visible = toastVisible,
                message = toastMessage,
                type = toastType,
                autoDismissMs = 3500L,
                onDismiss = {
                    toastVisible = false
                    if (toastType == ToastType.ERROR) viewModel.dismissError()
                }
            )
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Device Limit Dialog Ã¢â€â‚¬Ã¢â€â‚¬
        if (isDeviceLimitReached) {
            val state = uiState as LoginUiState.DeviceLimitReached
            AppDialog(
                title = "Device Limit Reached",
                message = "This account is already active on ${state.maxActiveDevices} other ${if (state.maxActiveDevices == 1) "device" else "devices"}.",
                subMessage = "You will be signed out on all other devices and signed in here.",
                icon = Icons.Default.Delete,
                warningText = "Other sessions will be permanently terminated.",
                confirmText = "Logout",
                cancelText = "Cancel",
                onConfirm = { viewModel.forceLogin(state.forceLogoutToken) },
                onDismiss = { viewModel.resetToIdle() },
                isLoading = isLoading
            )
        }
    }
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Reusable sub-components Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

@Composable
private fun GoogleSignInButton(
    enabled: Boolean,
    isLoading: Boolean,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(sdp(R.dimen._action_button_height))
            .clip(RoundedCornerShape(12.dp))
            .background(Color.White)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = sdp(R.dimen._16sdp)),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (isLoading) {
            AppLoadingIndicator(size = sdp(R.dimen._20sdp), color = Color(0xFF4285F4))
        } else {
            Text(
                text = "G",
                color = Color(0xFF4285F4),
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.Bold,
                fontSize = ssp(R.dimen._16ssp)
            )
            Spacer(modifier = Modifier.size(sdp(R.dimen._10sdp)))
            Text(
                text = "Sign in with Google",
                color = Color(0xFF1F1F1F),
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.Medium,
                fontSize = ssp(R.dimen._14ssp)
            )
        }
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text,
        color = Color(0xFFD99A2D),
        fontSize = ssp(R.dimen._12ssp),
        fontWeight = FontWeight.Bold,
        fontFamily = PoppinsFamily,
        modifier = Modifier.fillMaxWidth()
    )
}

@Composable
private fun AuthTextField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    placeholder: String,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        placeholder = {
            Text(placeholder, color = Color.White.copy(alpha = 0.4f), fontFamily = PoppinsFamily)
        },
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        singleLine = true,
        visualTransformation = visualTransformation,
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = Color.White,
            unfocusedTextColor = Color.White,
            disabledTextColor = Color.White.copy(alpha = 0.6f),
            focusedBorderColor = Color(0xFFD88A18),
            unfocusedBorderColor = Color(0xFFD88A18).copy(alpha = 0.5f),
            disabledBorderColor = Color(0xFFD88A18).copy(alpha = 0.3f),
            focusedPlaceholderColor = Color.White.copy(alpha = 0.4f),
            unfocusedPlaceholderColor = Color.White.copy(alpha = 0.4f)
        )
    )
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Preview Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

@Preview(
    name = "Sign In - Phone",
    showBackground = true,
    showSystemUi = true,
    device = "spec:width=411dp,height=891dp,dpi=420"
)
@Composable
private fun SignInPagePreview() {
    TryMeTheme {
        SignInPage(onLoginSuccess = {})
    }
}



