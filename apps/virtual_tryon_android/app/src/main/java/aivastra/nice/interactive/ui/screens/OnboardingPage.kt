package tryme.nice.interactive.ui.screens

import tryme.nice.interactive.R
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
import tryme.nice.interactive.viewmodels.OnboardingUiState
import tryme.nice.interactive.viewmodels.OnboardingViewModel
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel

/**
 * Shown when login returns merchantStatus = ONBOARDING_REQUIRED (no merchants row
 * yet for this user â€” see apps/api/.../status.ts). Mandatory one-time business
 * details form; completing it creates an active, zero-review, 0-credit merchant
 * and unblocks every /v1/merchant/{...} call.
 */
@Composable
fun OnboardingPage(
    suggestedContactName: String? = null,
    suggestedCompanyName: String? = null,
    onOnboardingComplete: () -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: OnboardingViewModel = viewModel()
) {
    LaunchedEffect(suggestedContactName, suggestedCompanyName) {
        viewModel.start(suggestedContactName, suggestedCompanyName)
    }

    val uiState by viewModel.uiState.collectAsState()

    var contactName by remember { mutableStateOf("") }
    var companyName by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastMessage by remember { mutableStateOf("") }

    // Seed the editable fields once prefill arrives, without stomping user edits
    // on every recomposition.
    LaunchedEffect(uiState) {
        val editing = uiState as? OnboardingUiState.Editing ?: return@LaunchedEffect
        if (contactName.isEmpty() && companyName.isEmpty() && phone.isEmpty()) {
            contactName = editing.contactName
            companyName = editing.companyName
            phone = editing.phone.filter(Char::isDigit).take(10)
        }
        if (editing.error != null) {
            toastMessage = editing.error
            toastVisible = true
        }
    }

    LaunchedEffect(uiState) {
        if (uiState is OnboardingUiState.Submitted) onOnboardingComplete()
    }

    val editingState = uiState as? OnboardingUiState.Editing
    val isSubmitting = editingState?.isSubmitting ?: false
    val showCompanyNameField = editingState?.showCompanyNameField ?: true
    val canSubmit = !isSubmitting && companyName.isNotBlank() && phone.filter(Char::isDigit).length == 10

    Box(modifier = modifier.fillMaxSize().background(Color.Black)) {
        Image(
            painter = painterResource(id = R.drawable.new_app_bg),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
        )

        if (uiState is OnboardingUiState.Loading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Color(0xFFD88A18))
            }
            return@Box
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = sdp(R.dimen._24sdp)),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            val isPreview = LocalInspectionMode.current
            val statusBarHeight: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)

            Column(
                modifier = Modifier.widthIn(max = sdp(R.dimen._screen_container_width)).fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.height(statusBarHeight))
                Spacer(modifier = Modifier.height(sdp(R.dimen._20sdp)))
                AppHeaderLogo(modifier = Modifier.size(width = sdp(R.dimen._250sdp), height = sdp(R.dimen._65sdp)))
            }

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

                Text(
                    text = buildAnnotatedString {
                        withStyle(SpanStyle(color = Color.White)) { append("BUSINESS ") }
                        withStyle(SpanStyle(brush = ButtonGradient)) { append("DETAILS") }
                    },
                    fontSize = ssp(R.dimen._32ssp),
                    fontWeight = FontWeight.Bold,
                    fontFamily = PoppinsFamily
                )

                Spacer(modifier = Modifier.height(sdp(R.dimen._6sdp)))

                Text(
                    text = "Start your virtual try-on journey",
                    color = Color.White.copy(alpha = 0.7f),
                    fontSize = ssp(R.dimen._13ssp),
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.Normal
                )

                Spacer(modifier = Modifier.height(sdp(R.dimen._24sdp)))

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(sdp(R.dimen._16sdp))
                ) {

                    if (showCompanyNameField) {
                        OnboardingFieldSection(
                            label = "COMPANY / STORE NAME",
                            value = companyName,
                            onValueChange = { companyName = it },
                            enabled = !isSubmitting,
                            placeholder = "Your business name"
                        )
                    }

                    OnboardingFieldSection(
                        label = "MOBILE NUMBER *",
                        value = phone,
                        onValueChange = { phone = it.filter(Char::isDigit).take(10) },
                        enabled = !isSubmitting,
                        placeholder = "10-digit mobile number"
                    )
                }

                Spacer(modifier = Modifier.height(sdp(R.dimen._24sdp)))

                GradientButton(
                    onClick = { viewModel.submit(contactName, companyName, phone, "") },
                    enabled = canSubmit,
                    width = sdp(R.dimen._0sdp),
                    height = sdp(R.dimen._action_button_height),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    if (isSubmitting) {
                        AppLoadingIndicator(size = sdp(R.dimen._22sdp), color = Color.White)
                    } else {
                        Text(
                            text = "CONTINUE",
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

                val navBarHeight: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                Spacer(modifier = Modifier.height(sdp(R.dimen._24sdp) + navBarHeight))
            }
        }

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
                type = ToastType.ERROR,
                autoDismissMs = 3500L,
                onDismiss = { toastVisible = false }
            )
        }
    }
}

@Composable
private fun OnboardingFieldSection(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    placeholder: String
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(sdp(R.dimen._4sdp))
    ) {
        OnboardingFieldLabel(text = label)
        OnboardingTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            placeholder = placeholder
        )
    }
}

@Composable
private fun OnboardingFieldLabel(text: String) {
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
private fun OnboardingTextField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    placeholder: String
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        placeholder = { Text(placeholder, color = Color.White.copy(alpha = 0.4f), fontFamily = PoppinsFamily) },
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        singleLine = true,
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

@Preview(showBackground = true, showSystemUi = true, device = "spec:width=411dp,height=891dp,dpi=420")
@Composable
private fun OnboardingPagePreview() {
    TryMeTheme { OnboardingPage() }
}


