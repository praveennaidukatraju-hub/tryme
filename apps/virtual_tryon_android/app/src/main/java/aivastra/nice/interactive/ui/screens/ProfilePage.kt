package tryme.nice.interactive.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.MailOutline
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import tryme.nice.interactive.ui.components.AppHeaderLogo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import tryme.nice.interactive.R
import tryme.nice.interactive.data.repository.ContactRepository
import tryme.nice.interactive.data.repository.ContactResult
import tryme.nice.interactive.data.repository.UserRepository
import tryme.nice.interactive.data.session.SessionManager
import tryme.nice.interactive.ui.components.AppDialog
import tryme.nice.interactive.ui.components.AppLoadingIndicator
import tryme.nice.interactive.ui.components.AppToast
import tryme.nice.interactive.ui.components.GradientButton
import tryme.nice.interactive.ui.components.ToastType
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.ButtonGradient
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import kotlinx.coroutines.launch

/**
 * Dedicated Profile Page displaying uneditable User Name, Email Address,
 * and a Log Out action matching the exact luxury Ai Vastra design system.
 */
@Composable
fun ProfilePage(
    onBack: () -> Unit,
    onLogoutSuccess: () -> Unit,
    modifier: Modifier = Modifier
) {
    BackHandler(onBack = onBack)

    val scope = rememberCoroutineScope()
    val userRepository = remember { UserRepository() }

    // Retrieve User Email & User Name from SessionManager or fallbacks
    val savedEmail = remember { SessionManager.userEmail ?: "tryme@gmail.com" }
    val savedUserName = remember {
        SessionManager.userName
            ?: savedEmail.substringBefore("@").replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
            .ifBlank { "TryMe" }
    }

    var showLogoutDialog by remember { mutableStateOf(false) }
    var isLoggingOut by remember { mutableStateOf(false) }

    var showContactDialog by remember { mutableStateOf(false) }
    var toastVisible by remember { mutableStateOf(false) }
    var toastMessage by remember { mutableStateOf("") }
    var toastType by remember { mutableStateOf(ToastType.SUCCESS) }

    val isPreview = LocalInspectionMode.current
    val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // App Background
        Image(
            painter = painterResource(id = R.drawable.new_app_bg),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
        )

        // Scrollable Content
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = sdp(R.dimen._20sdp))
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = sdp(R.dimen._screen_container_width))
                    .fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(Modifier.height(statusBarH))

                // ── Top Bar (Back Arrow + Logo Header) ──────────────────────
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = sdp(R.dimen._10sdp))
                ) {
                    // Back Button
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .size(sdp(R.dimen._38sdp))
                            .clip(CircleShape)
                            .background(
                                Brush.linearGradient(
                                    listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                                )
                            )
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = onBack
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._20sdp))
                        )
                    }

                    // Logo Center
                    AppHeaderLogo(modifier = Modifier.align(Alignment.Center))
                }

                Spacer(Modifier.height(sdp(R.dimen._20sdp)))

                // ── Page Title ────────────────────────────────────────────────
                Text(
                    text = buildAnnotatedString {
                        withStyle(SpanStyle(color = Color.White)) { append("My ") }
                        withStyle(SpanStyle(brush = ButtonGradient)) { append("Profile") }
                    },
                    fontSize = ssp(R.dimen._22ssp),
                    fontWeight = FontWeight.Bold,
                    fontFamily = PoppinsFamily
                )
                Spacer(Modifier.height(sdp(R.dimen._4sdp)))
                Text(
                    text = "Manage your account details",
                    color = Color.White.copy(alpha = 0.55f),
                    fontSize = ssp(R.dimen._12ssp),
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.Normal
                )

                Spacer(Modifier.height(sdp(R.dimen._24sdp)))

                // ── Large Glowing Circular Profile Avatar ───────────────────
                Box(
                    modifier = Modifier
                        .size(sdp(R.dimen._145sdp))
                        .shadow(
                            elevation = sdp(R.dimen._14sdp),
                            shape = CircleShape,
                            ambientColor = Color(0xFFE7A52C).copy(alpha = 0.6f),
                            spotColor = Color(0xFFE7A52C).copy(alpha = 0.6f)
                        )
                        .clip(CircleShape)
                        .background(Color(0xFF231F1C))
                        .border(
                            width = sdp(R.dimen._2sdp),
                            brush = Brush.linearGradient(
                                listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                            ),
                            shape = CircleShape
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Image(
                        painter = painterResource(id = R.drawable.profile_icon),
                        contentDescription = "User Avatar",
                        modifier = Modifier
                            .fillMaxSize()
                            .clip(CircleShape),
                        contentScale = ContentScale.Crop
                    )
                }

                Spacer(Modifier.height(sdp(R.dimen._36sdp)))

                // ── Field 1: USERNAME (Uneditable) ──────────────────────────
                FieldLabel(text = "USERNAME")
                Spacer(Modifier.height(sdp(R.dimen._6sdp)))
                UneditableAuthTextField(
                    value = savedUserName,
                    leadingIcon = Icons.Default.Person
                )

                Spacer(Modifier.height(sdp(R.dimen._20sdp)))

                // ── Field 2: EMAIL ADDRESS (Uneditable) ──────────────────────
                FieldLabel(text = "EMAIL ADDRESS")
                Spacer(Modifier.height(sdp(R.dimen._6sdp)))
                UneditableAuthTextField(
                    value = savedEmail,
                    leadingIcon = Icons.Default.Email
                )

                Spacer(Modifier.height(sdp(R.dimen._20sdp)))

                // ── Action Button: LOG OUT ────────────────────────────────────
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(sdp(R.dimen._50sdp))
                        .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
                        .background(
                            Brush.linearGradient(
                                listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                            )
                        )
                        .clickable(enabled = !isLoggingOut) {
                            showLogoutDialog = true
                        },
                    contentAlignment = Alignment.Center
                ) {
                    if (isLoggingOut) {
                        AppLoadingIndicator(size = sdp(R.dimen._22sdp), color = Color.White)
                    } else {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ExitToApp,
                                contentDescription = "Log Out",
                                tint = Color.White,
                                modifier = Modifier.size(sdp(R.dimen._22sdp))
                            )
                            Spacer(Modifier.width(sdp(R.dimen._10sdp)))
                            Text(
                                text = "Log Out",
                                color = Color.White,
                                fontFamily = PoppinsFamily,
                                fontWeight = FontWeight.Bold,
                                fontSize = ssp(R.dimen._16ssp)
                            )
                        }
                    }
                }

                // Reserves space so the fixed Contact Us footer never overlaps the
                // last scrollable field/button.
                Spacer(Modifier.height(sdp(R.dimen._100sdp)))
            }
        }

        // ── Fixed Footer: CONTACT US ──────────────────────────────────────────
        // Glass finish — same treatment as the credits pill / 3-dot menu button
        // elsewhere in the app: translucent white fill + a barely-there white
        // border, not a filled gradient. Log Out above stays the page's one
        // solid-fill CTA; a second identical gradient pill here would read as
        // two equally-weighted primary actions on the same screen.
        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .widthIn(max = sdp(R.dimen._screen_container_width))
                .fillMaxWidth()
                .padding(horizontal = sdp(R.dimen._20sdp))
                .padding(bottom = sdp(R.dimen._20sdp) + navBarH)
                .shadow(
                    elevation = sdp(R.dimen._6sdp),
                    shape = RoundedCornerShape(percent = 50),
                    ambientColor = Color.Black.copy(alpha = 0.5f),
                    spotColor = Color.Black.copy(alpha = 0.5f)
                )
                .clip(RoundedCornerShape(percent = 50))
                .background(Color.White.copy(alpha = 0.08f))
                .border(sdp(R.dimen._1sdp), Color.White.copy(alpha = 0.16f), RoundedCornerShape(percent = 50))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null
                ) { showContactDialog = true }
                .height(sdp(R.dimen._55sdp)),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            Icon(
                imageVector = Icons.Default.MailOutline,
                contentDescription = null,
                tint = Color(0xFFD88A18),
                modifier = Modifier.size(sdp(R.dimen._18sdp))
            )
            Spacer(Modifier.width(sdp(R.dimen._10sdp)))
            Text(
                text = "Contact Us",
                color = Color(0xFFD88A18),
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.Bold,
                fontSize = ssp(R.dimen._16ssp)
            )
        }

        // ── Logout Confirmation Dialog ──────────────────────────────────────
        if (showLogoutDialog) {
            AppDialog(
                title = "Logout Confirmation",
                message = "Are you sure you want to log out of your Ai Vastra account?",
                icon = Icons.AutoMirrored.Filled.ExitToApp,
                warningText = "You will need to sign in again to access virtual try-on.",
                confirmText = "Logout",
                cancelText = "Cancel",
                isLoading = isLoggingOut,
                onConfirm = {
                    isLoggingOut = true
                    scope.launch {
                        val token = SessionManager.refreshToken
                        if (!token.isNullOrBlank()) {
                            userRepository.logoutDevice(token)
                        }
                        SessionManager.clear()
                        isLoggingOut = false
                        showLogoutDialog = false
                        onLogoutSuccess()
                    }
                },
                onDismiss = {
                    if (!isLoggingOut) showLogoutDialog = false
                }
            )
        }

        // ── Contact Us Form Dialog ────────────────────────────────────────────
        if (showContactDialog) {
            ContactFormDialog(
                initialName = savedUserName,
                onDismiss = { showContactDialog = false },
                onSent = { successMessage ->
                    showContactDialog = false
                    toastType = ToastType.SUCCESS
                    toastMessage = successMessage
                    toastVisible = true
                }
            )
        }

        // Sits above the fixed Contact Us footer rather than under the status-bar
        // inset the other screens' toasts use, since that footer would otherwise
        // cover it.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .padding(bottom = sdp(R.dimen._20sdp) + navBarH + sdp(R.dimen._55sdp) + sdp(R.dimen._12sdp))
        ) {
            AppToast(
                visible = toastVisible,
                message = toastMessage,
                type = toastType,
                autoDismissMs = 3500L,
                onDismiss = { toastVisible = false }
            )
        }
    }
}

// ─── Contact Us Form Dialog ─────────────────────────────────────────────────

/**
 * Name + Message only, by design — email comes from the session and phone from the
 * merchant's onboarding record (mandatory during onboarding, so every logged-in user
 * has one) inside [ContactRepository], so the user isn't asked to retype either.
 */
@Composable
private fun ContactFormDialog(
    initialName: String,
    onDismiss: () -> Unit,
    onSent: (successMessage: String) -> Unit
) {
    val scope = rememberCoroutineScope()
    val repository = remember { ContactRepository() }

    var name by remember { mutableStateOf(initialName) }
    var message by remember { mutableStateOf("") }
    var isSending by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    val canSend = !isSending && name.isNotBlank()

    Dialog(
        onDismissRequest = { if (!isSending) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(0.9f)
                .clip(RoundedCornerShape(20.dp))
                .background(Color(0xFF1A1A1A))
                .border(1.dp, Color(0xFFD88A18).copy(alpha = 0.35f), RoundedCornerShape(20.dp))
                .padding(horizontal = 22.dp, vertical = 24.dp)
        ) {
            Column {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Contact Us",
                        fontFamily = PoppinsFamily,
                        fontWeight = FontWeight.Bold,
                        fontSize = ssp(R.dimen._18ssp),
                        color = Color.White
                    )
                    Box(
                        modifier = Modifier
                            .size(sdp(R.dimen._28sdp))
                            .clip(CircleShape)
                            .background(Color.White.copy(alpha = 0.08f))
                            .clickable(enabled = !isSending) { onDismiss() },
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Close",
                            tint = Color.White.copy(alpha = 0.7f),
                            modifier = Modifier.size(sdp(R.dimen._16sdp))
                        )
                    }
                }

                Spacer(Modifier.height(sdp(R.dimen._4sdp)))

                Text(
                    text = "We'd love to hear from you",
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.Normal,
                    fontSize = ssp(R.dimen._12ssp),
                    color = Color.White.copy(alpha = 0.55f)
                )

                Spacer(Modifier.height(sdp(R.dimen._20sdp)))

                FieldLabel(text = "NAME")
                Spacer(Modifier.height(sdp(R.dimen._6sdp)))
                ContactTextField(
                    value = name,
                    onValueChange = { name = it; errorText = null },
                    enabled = !isSending,
                    placeholder = "Your name",
                    singleLine = true,
                    imeAction = ImeAction.Next
                )

                Spacer(Modifier.height(sdp(R.dimen._16sdp)))

                FieldLabel(text = "MESSAGE")
                Spacer(Modifier.height(sdp(R.dimen._6sdp)))
                ContactTextField(
                    value = message,
                    onValueChange = { message = it; errorText = null },
                    enabled = !isSending,
                    placeholder = "Tell us about your requirements, business, or any questions you have...",
                    singleLine = false,
                    minLines = 4,
                    imeAction = ImeAction.Default
                )

                if (errorText != null) {
                    Spacer(Modifier.height(sdp(R.dimen._10sdp)))
                    Text(
                        text = errorText.orEmpty(),
                        color = Color(0xFFFF6A4D),
                        fontSize = ssp(R.dimen._11ssp),
                        fontFamily = PoppinsFamily,
                        textAlign = TextAlign.Start,
                        modifier = Modifier.fillMaxWidth()
                    )
                }

                Spacer(Modifier.height(sdp(R.dimen._20sdp)))

                GradientButton(
                    onClick = {
                        if (!canSend) return@GradientButton
                        isSending = true
                        errorText = null
                        scope.launch {
                            when (val result = repository.send(name.trim(), message.trim())) {
                                is ContactResult.Success -> {
                                    isSending = false
                                    onSent("Your message has been sent. We'll get back to you soon!")
                                }
                                is ContactResult.Failure -> {
                                    isSending = false
                                    errorText = result.message
                                }
                            }
                        }
                    },
                    enabled = canSend,
                    width = 0.dp,
                    height = sdp(R.dimen._review_action_button_height),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    if (isSending) {
                        AppLoadingIndicator(size = sdp(R.dimen._20sdp), color = Color.White, strokeWidth = 2.dp)
                    } else {
                        Text(
                            text = "Send Message",
                            color = Color.White,
                            fontFamily = PoppinsFamily,
                            fontWeight = FontWeight.Bold,
                            fontSize = ssp(R.dimen._14ssp)
                        )
                        Spacer(Modifier.width(sdp(R.dimen._8sdp)))
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._16sdp))
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ContactTextField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    placeholder: String,
    singleLine: Boolean,
    minLines: Int = 1,
    imeAction: ImeAction = ImeAction.Default
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        placeholder = { Text(placeholder, color = Color.White.copy(alpha = 0.4f), fontFamily = PoppinsFamily, fontSize = ssp(R.dimen._13ssp)) },
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        singleLine = singleLine,
        minLines = minLines,
        keyboardOptions = KeyboardOptions(imeAction = imeAction),
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

// ─── Sub-Components ──────────────────────────────────────────────────────────

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
private fun UneditableAuthTextField(
    value: String,
    leadingIcon: ImageVector
) {
    OutlinedTextField(
        value = value,
        onValueChange = {},
        readOnly = true,
        enabled = false,
        leadingIcon = {
            Icon(
                imageVector = leadingIcon,
                contentDescription = null
            )
        },
        modifier = Modifier
            .fillMaxWidth()
            .alpha(0.55f),
        shape = RoundedCornerShape(12.dp),
        singleLine = true,
        colors = OutlinedTextFieldDefaults.colors(
            disabledTextColor = Color.White,
            disabledBorderColor = Color.White.copy(alpha = 0.4f),
            disabledContainerColor = Color(0xFF1A1816),
            disabledLeadingIconColor = Color.White
        )
    )
}

// ─── Preview ─────────────────────────────────────────────────────────────────

@Preview(
    name = "Profile Page - Phone",
    showBackground = true,
    showSystemUi = true,
    device = "spec:width=411dp,height=891dp,dpi=420"
)
@Composable
private fun ProfilePagePreview() {
    TryMeTheme {
        ProfilePage(onBack = {}, onLogoutSuccess = {})
    }
}
