package tryme.nice.interactive.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import tryme.nice.interactive.ui.components.AppHeaderLogo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tryme.nice.interactive.R
import tryme.nice.interactive.data.repository.MerchantRepository
import tryme.nice.interactive.data.repository.MerchantResult
import tryme.nice.interactive.data.repository.UserRepository
import tryme.nice.interactive.data.session.SessionManager
import tryme.nice.interactive.ui.components.AppDialog
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.ButtonGradient
import tryme.nice.interactive.ui.theme.ButtonGradientCenter
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale


import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.platform.LocalContext
import androidx.activity.compose.BackHandler
import tryme.nice.interactive.utils.CrashReporter

// ─── Data model ──────────────────────────────────────────────────────────────

data class Category(
    val id: String,
    val label: String,
    val subtitle: String,
    @DrawableRes val imageRes: Int
)

// Ids must match the backend's category enum exactly: 'men' | 'women' | 'boys' | 'girls'
// (apps/api/src/modules/admin/models.routes.ts). Singular ids here would silently
// return zero subcategories/products for Boy and Girl since no server-side row
// is ever tagged with the singular form.
private val categories = listOf(
    Category("women", "WOMEN", "Try on women's outfits", R.drawable.women_img),
    Category("men",   "MEN",   "Try on men's outfits",  R.drawable.men_img),
    Category("boys",  "BOY",   "Try on boys' outfits",  R.drawable.boy_img),
    Category("girls", "GIRL",  "Try on girls' outfits", R.drawable.girl_img)
)

// ─── Screen ──────────────────────────────────────────────────────────────────

@Composable
fun CategorySelectionPage(
    onCategorySelected: (categoryId: String) -> Unit = {},
    onProfileClick: () -> Unit = {},
    onUploadProductsClick: () -> Unit = {},
    onReportsClick: () -> Unit = {},
    onLogoutSuccess: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    // Finish activity on system back gesture/button on root home screen to exit app cleanly
    BackHandler(enabled = true) {
        (context as? Activity)?.finish()
    }

    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { delay(80); visible = true }

    var showProfileMenu by remember { mutableStateOf(false) }
    var showLogoutDialog by remember { mutableStateOf(false) }
    var isLoggingOut by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()
    val userEmail = remember { SessionManager.userEmail ?: "user@tryme.com" }

    var creditsBalance by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        when (val result = MerchantRepository().getMe()) {
            is MerchantResult.Success -> creditsBalance = result.data.balance
            is MerchantResult.Failure -> Unit // Keep the pill at 0 rather than surfacing an error over the whole screen for this ancillary widget.
        }
    }

    // ── Compute dynamic card height from actual screen space ───────────────
    // BoxWithConstraints gives us real maxHeight at composition time, enabling
    // a single layout that fills the screen on any device size automatically.
    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val screenH = this@BoxWithConstraints.maxHeight
        val isPreview   = LocalInspectionMode.current
        val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)

        // Dynamic chrome & spacing for mobile, tablet, and kiosk
        val rowCount = categories.size
        val availableCategorySpace = (screenH - statusBarH - sdp(R.dimen._150sdp)).coerceAtLeast(sdp(R.dimen._200sdp))
        val rawGap = sdp(R.dimen._8sdp)
        // Each rendered CategoryCard is actually cardHeight + _35sdp tall (extra room so the
        // model image can overflow above the card top) — that per-card overflow has to come out
        // of the same budget too, or the real total height runs past what was reserved and the
        // whole page needs a scroll to see the last card/footer. On phones this pushed the
        // computed cardH just high enough to overflow; tablets/kiosks had enough slack to not
        // notice. Reserving it here keeps the "fits without scrolling" behavior on both sides.
        val perCardOverflow = sdp(R.dimen._35sdp)
        val cardH = ((availableCategorySpace - (rawGap * (rowCount - 1)) - (perCardOverflow * rowCount)) / rowCount)
            .coerceIn(sdp(R.dimen._70sdp), sdp(R.dimen._180sdp))
        val cardGap = rawGap

        Box(modifier = Modifier.fillMaxSize()) {

            // ── Background ─────────────────────────────────────────────────
            Image(
                painter = painterResource(R.drawable.new_app_bg),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop
            )

            // ── Full screen balanced layout ──────────────────────────────────
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Column(
                    modifier = Modifier
                        .widthIn(max = sdp(R.dimen._screen_container_width))
                        .fillMaxSize()
                        .padding(horizontal = sdp(R.dimen._16sdp)),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.SpaceBetween
                ) {
                    // ── Top Section: Status bar, Logo & Title ───────────────
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Spacer(Modifier.height(statusBarH))

                        // ── Top bar ─────────────────────────────────────────
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            AppHeaderLogo()
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                // Explicit interaction source + no-ripple scale-down feedback (same
                                // recipe as CategoryCard) fires the instant a finger touches down —
                                // the default clickable ripple noticeably lagged the tap here since it
                                // waits on the indication animation before anything visibly reacts.
                                val menuInteractionSource = remember { MutableInteractionSource() }
                                val isMenuPressed by menuInteractionSource.collectIsPressedAsState()
                                val menuButtonScale by animateFloatAsState(
                                    targetValue = if (isMenuPressed) 0.88f else 1f,
                                    animationSpec = tween(60),
                                    label = "menuButtonScale"
                                )
                                Box {
                                    // Outer box is the real touch target — bigger than the visible
                                    // pill so a tap that lands just outside the 40sdp circle (but still
                                    // near it) still registers, instead of requiring a dead-center hit.
                                    Box(
                                        modifier = Modifier
                                            .size(sdp(R.dimen._52sdp))
                                            .clip(CircleShape)
                                            .clickable(
                                                interactionSource = menuInteractionSource,
                                                indication = null,
                                                onClick = { showProfileMenu = true }
                                            ),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .size(sdp(R.dimen._40sdp))
                                                .scale(menuButtonScale)
                                                .clip(CircleShape)
                                                .background(Color.White.copy(alpha = 0.08f))
                                                .border(sdp(R.dimen._1sdp), Color.White.copy(alpha = 0.16f), CircleShape),
                                            contentAlignment = Alignment.Center
                                        ) {
                                            Icon(
                                                imageVector = Icons.Default.MoreVert,
                                                contentDescription = "Menu",
                                                tint = Color.White,
                                                modifier = Modifier.size(sdp(R.dimen._22sdp))
                                            )
                                        }
                                    }
                                    DropdownMenu(
                                        expanded = showProfileMenu,
                                        onDismissRequest = { showProfileMenu = false },
                                        modifier = Modifier.width(sdp(R.dimen._240sdp)),
                                        containerColor = Color.Transparent,
                                        tonalElevation = 0.dp,
                                        shadowElevation = 0.dp
                                    ) {
                                        Column(horizontalAlignment = Alignment.End) {
                                            // Speech-bubble tail pointing up at the 3-dot button that opened this menu.
                                            Canvas(
                                                modifier = Modifier
                                                    .padding(end = sdp(R.dimen._16sdp))
                                                    .size(width = sdp(R.dimen._16sdp), height = sdp(R.dimen._8sdp))
                                            ) {
                                                val tailPath = Path().apply {
                                                    moveTo(0f, size.height)
                                                    lineTo(size.width / 2f, 0f)
                                                    lineTo(size.width, size.height)
                                                    close()
                                                }
                                                drawPath(tailPath, color = Color(0xFF1B1815))
                                            }
                                            // Glass finish, no stroke — fully opaque (not see-through) so menu
                                            // text stays readable regardless of what's behind it; the "glass"
                                            // read comes from a soft diagonal sheen catching the top-left
                                            // corner, not from transparency.
                                            Column(
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .clip(RoundedCornerShape(sdp(R.dimen._16sdp)))
                                                    .background(Color(0xFF1B1815))
                                                    .background(
                                                        Brush.linearGradient(
                                                            colors = listOf(Color.White.copy(alpha = 0.10f), Color.Transparent, Color.Transparent),
                                                            start = Offset(0f, 0f),
                                                            end = Offset(300f, 220f)
                                                        )
                                                    )
                                                    .padding(vertical = sdp(R.dimen._6sdp))
                                            ) {
                                                CreditsPill(
                                                    credits = creditsBalance,
                                                    modifier = Modifier
                                                        .fillMaxWidth()
                                                        .padding(horizontal = sdp(R.dimen._12sdp), vertical = sdp(R.dimen._4sdp))
                                                )
                                                HorizontalDivider(
                                                    color = Color.White.copy(alpha = 0.12f),
                                                    modifier = Modifier.padding(horizontal = sdp(R.dimen._12sdp), vertical = sdp(R.dimen._4sdp))
                                                )
                                                ProfileMenuItem(
                                                    leadingIcon = {
                                                        Icon(Icons.Default.Person, null, tint = Color(0xFFD88A18), modifier = Modifier.size(sdp(R.dimen._18sdp)))
                                                    },
                                                    title = "My Profile",
                                                    subtitle = "View and edit your profile",
                                                    onClick = { showProfileMenu = false; onProfileClick() }
                                                )
                                                ProfileMenuItem(
                                                    leadingIcon = {
                                                        Icon(painterResource(R.drawable.ic_cloud_upload), null, tint = Color(0xFFD88A18), modifier = Modifier.size(sdp(R.dimen._18sdp)))
                                                    },
                                                    title = "Upload Products",
                                                    subtitle = "Add your products",
                                                    onClick = { showProfileMenu = false; onUploadProductsClick() }
                                                )
                                                ProfileMenuItem(
                                                    leadingIcon = {
                                                        Icon(Icons.AutoMirrored.Filled.List, null, tint = Color(0xFFD88A18), modifier = Modifier.size(sdp(R.dimen._18sdp)))
                                                    },
                                                    title = "Reports",
                                                    subtitle = "View daily activity",
                                                    onClick = { showProfileMenu = false; onReportsClick() }
                                                )
                                                ProfileMenuItem(
                                                    leadingIcon = {
                                                        Icon(Icons.Default.Star, null, tint = Color(0xFFD88A18), modifier = Modifier.size(sdp(R.dimen._18sdp)))
                                                    },
                                                    title = "Manage Credits",
                                                    subtitle = "View plans & Add credits",
                                                    onClick = {
                                                        showProfileMenu = false
                                                        try {
                                                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://app.tryme.com/pricing")))
                                                        } catch (e: Exception) {
                                                            CrashReporter.recordException(e, "CategorySelectionPage")
                                                        }
                                                    }
                                                )
                                                HorizontalDivider(
                                                    color = Color.White.copy(alpha = 0.12f),
                                                    modifier = Modifier.padding(horizontal = sdp(R.dimen._12sdp), vertical = sdp(R.dimen._4sdp))
                                                )
                                                ProfileMenuItem(
                                                    leadingIcon = {
                                                        Icon(Icons.Default.ExitToApp, null, tint = Color(0xFFFF6A4D), modifier = Modifier.size(sdp(R.dimen._18sdp)))
                                                    },
                                                    title = "Log Out",
                                                    subtitle = "Sign out from your account",
                                                    titleColor = Color(0xFFFF6A4D),
                                                    showChevron = false,
                                                    onClick = { showProfileMenu = false; showLogoutDialog = true }
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        Spacer(Modifier.height(sdp(R.dimen._12sdp)))

                        // ── Title ───────────────────────────────────────────
                        Box(modifier = Modifier.fillMaxWidth()) {
                            Column {
                                Text(
                                    text = buildAnnotatedString {
                                        withStyle(SpanStyle(color = Color.White)) { append("Choose Your ") }
                                        withStyle(SpanStyle(brush = ButtonGradient)) { append("Category") }
                                    },
                                    fontSize = ssp(R.dimen._24ssp),
                                    fontWeight = FontWeight.Bold,
                                    fontFamily = PoppinsFamily
                                )
                                Spacer(Modifier.height(sdp(R.dimen._2sdp)))
                                Text(
                                    "Select who is trying on today",
                                    color = Color(0xFFD9D9D9),
                                    fontSize = ssp(R.dimen._13ssp),
                                    fontFamily = PoppinsFamily,
                                    fontWeight = FontWeight.Normal
                                )
                                Spacer(Modifier.height(sdp(R.dimen._8sdp)))
                                Box(
                                    modifier = Modifier
                                        .size(width = sdp(R.dimen._40sdp), height = 2.dp)
                                        .background(Brush.horizontalGradient(listOf(ButtonGradientCenter, Color.Transparent)))
                                )
                            }
                        }
                    }

                    Spacer(Modifier.height(sdp(R.dimen._8sdp)))

                    // ── Middle Section: Category cards dynamically sized ─────
                    CategoryList(
                        cardHeight = cardH,
                        itemSpacing = cardGap,
                        onCategorySelected = onCategorySelected
                    )

                    Spacer(Modifier.height(sdp(R.dimen._30sdp)))

                    // ── Bottom Section: Privacy notice ──────────────────────
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = sdp(R.dimen._12sdp))
                    ) {
                        Image(
                            painter = painterResource(R.drawable.privacy_lock_icon),
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(sdp(R.dimen._24sdp))
                        )
                        Spacer(Modifier.width(sdp(R.dimen._18sdp)))
                        Column(verticalArrangement = Arrangement.Center) {
                            Text(
                                "Try-On images are stored only for this session.",
                                color = Color.White.copy(alpha = 0.55f),
                                fontSize = ssp(R.dimen._11ssp),
                                lineHeight = ssp(R.dimen._12ssp),
                                fontFamily = PoppinsFamily,
                                fontWeight = FontWeight.Medium
                            )
                            Text(
                                "You can delete all Try-On results after completing the session.",
                                color = Color.White.copy(alpha = 0.35f),
                                fontSize = ssp(R.dimen._9ssp),
                                lineHeight = ssp(R.dimen._10ssp),
                                fontFamily = PoppinsFamily,
                                fontWeight = FontWeight.Normal
                            )
                        }
                    }
                }
            }

            // ── Logout dialog ───────────────────────────────────────────────
            if (showLogoutDialog) {
                AppDialog(
                    title = "Confirm Logout",
                    message = "Are you sure you want to log out?",
                    subMessage = "Logged in as: $userEmail",
                    icon = Icons.Default.ExitToApp,
                    warningText = "You will need to sign in again to access your account.",
                    confirmText = "Yes, Logout",
                    cancelText = "Cancel",
                    isLoading = isLoggingOut,
                    onConfirm = {
                        if (isLoggingOut) return@AppDialog
                        isLoggingOut = true
                        scope.launch {
                            val refreshToken = SessionManager.refreshToken ?: ""
                            if (refreshToken.isNotEmpty()) {
                                UserRepository().logoutDevice(refreshToken)
                            }
                            SessionManager.clear()
                            isLoggingOut = false
                            showLogoutDialog = false
                            onLogoutSuccess()
                        }
                    },
                    onDismiss = { if (!isLoggingOut) showLogoutDialog = false }
                )
            }
        }
    }
}

//──────────────────────────────────────────────────────────────────────────────
// CREDITS PILL
//──────────────────────────────────────────────────────────────────────────────

@Composable
private fun CreditsPill(credits: Int, modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
        // Same neutral glass treatment as the 3-dot menu button next to it —
        // flat translucent white fill + a barely-there white border, no color tint.
        modifier = modifier
            .clip(RoundedCornerShape(sdp(R.dimen._8sdp)))
            .background(Color.White.copy(alpha = 0.08f))
            .border(sdp(R.dimen._1sdp), Color.White.copy(alpha = 0.16f), RoundedCornerShape(sdp(R.dimen._8sdp)))
            .padding(start = sdp(R.dimen._6sdp), end = sdp(R.dimen._12sdp), top = sdp(R.dimen._9sdp), bottom = sdp(R.dimen._9sdp))
    ) {
        Box(
            modifier = Modifier
                .size(sdp(R.dimen._22sdp))
                .clip(CircleShape)
                .background(Color(0xFF19140F))
                .border(sdp(R.dimen._1sdp), Color(0xFFD88A18), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Star,
                contentDescription = null,
                tint = Color(0xFFD88A18),
                modifier = Modifier.size(sdp(R.dimen._12sdp))
            )
        }
        Spacer(Modifier.width(sdp(R.dimen._6sdp)))
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = Color(0xFFD99429), fontWeight = FontWeight.Bold)) { append(formatCredits(credits)) }
                withStyle(SpanStyle(color = Color.Gray.copy(alpha = 0.85f), fontWeight = FontWeight.SemiBold)) { append(" Credits") }
            },
            fontSize = ssp(R.dimen._11ssp),
            fontFamily = PoppinsFamily
        )
    }
}

private fun formatCredits(value: Int): String = String.format(Locale.US, "%,d", value)

//──────────────────────────────────────────────────────────────────────────────
// PROFILE DROPDOWN MENU ITEM
//──────────────────────────────────────────────────────────────────────────────

@Composable
private fun ProfileMenuItem(
    leadingIcon: @Composable () -> Unit,
    title: String,
    subtitle: String,
    titleColor: Color = Color.White,
    showChevron: Boolean = true,
    onClick: () -> Unit
) {
    DropdownMenuItem(
        text = {
            Column {
                Text(title, color = titleColor, fontSize = ssp(R.dimen._13ssp), fontWeight = FontWeight.SemiBold, fontFamily = PoppinsFamily)
                Spacer(Modifier.height(sdp(R.dimen._menu_item_text_gap)))
                Text(subtitle, color = Color.White.copy(alpha = 0.45f), fontSize = ssp(R.dimen._10ssp), fontFamily = PoppinsFamily, fontWeight = FontWeight.Normal)
            }
        },
        contentPadding = PaddingValues(horizontal = sdp(R.dimen._12sdp), vertical = sdp(R.dimen._menu_item_row_padding)),
        onClick = onClick,
        leadingIcon = {
            Box(
                modifier = Modifier
                    .size(sdp(R.dimen._34sdp))
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.06f)),
                contentAlignment = Alignment.Center
            ) { leadingIcon() }
        },
        trailingIcon = if (showChevron) {
            {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = Color.White.copy(alpha = 0.3f),
                    modifier = Modifier.size(sdp(R.dimen._18sdp))
                )
            }
        } else null
    )
}

//──────────────────────────────────────────────────────────────────────────────
// CATEGORY CARD
//──────────────────────────────────────────────────────────────────────────────

@Composable
private fun CategoryCard(
    category: Category,
    cardHeight: Dp,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {

    val interactionSource = remember { MutableInteractionSource() }
    val isPressed by interactionSource.collectIsPressedAsState()

    val scale by animateFloatAsState(
        targetValue = if (isPressed) 0.97f else 1f,
        animationSpec = tween(120),
        label = "cardScale"
    )

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .height(cardHeight + sdp(R.dimen._35sdp))
            .scale(scale)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick
            )
    ) {
        val cardWidth = maxWidth
        val isMobile = cardWidth < 500.dp

        // Mobile's narrower box was clipping the model image's right side under
        // ContentScale.FillHeight — a bit more width to scale into, and slightly less end
        // padding to make room for it, keeps the model fully in frame on narrow screens.
        val imgWidth = if (isMobile) sdp(R.dimen._170sdp) else sdp(R.dimen._220sdp)
        val imgEndPadding = if (isMobile) sdp(R.dimen._42sdp) else sdp(R.dimen._92sdp)
        val textStartPadding = if (isMobile) sdp(R.dimen._20sdp) else sdp(R.dimen._36sdp)
        val titleFontSize = if (isMobile) ssp(R.dimen._18ssp) else ssp(R.dimen._24ssp)
        val subtitleFontSize = if (isMobile) ssp(R.dimen._11ssp) else ssp(R.dimen._14ssp)

        // ── Card Base Container ─────────────────────────────────────────────
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(cardHeight)
                .clip(RoundedCornerShape(sdp(R.dimen._20sdp)))
        ) {

            // Base Gradient Background
            Box(
                Modifier
                    .matchParentSize()
                    .background(
                        Brush.linearGradient(
                            colors = listOf(
                                Color(0xFF3A342F),
                                Color(0xFF282523),
                                Color(0xFF1A1918)
                            )
                        )
                    )
            )

            // Warm Amber Radial Glow
            Box(
                Modifier
                    .matchParentSize()
                    .background(
                        Brush.radialGradient(
                            colors = listOf(
                                Color(0x22D89B32),
                                Color.Transparent
                            ),
                            radius = 900f,
                            center = Offset(260f, -50f)
                        )
                    )
            )

            // Left Scrim / Dark Gradient (Protects text contrast)
            Box(
                Modifier
                    .matchParentSize()
                    .background(
                        Brush.horizontalGradient(
                            0f to Color(0xFF2C2926),
                            0.50f to Color(0xFF2C2926),
                            0.70f to Color(0xCC2C2926),
                            0.85f to Color(0x442C2926),
                            1f to Color.Transparent
                        )
                    )
            )

            // White Light Halo behind model
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = if (isMobile) sdp(R.dimen._30sdp) else sdp(R.dimen._60sdp))
                    .size(if (isMobile) sdp(R.dimen._180sdp) else sdp(R.dimen._280sdp))
                    .background(
                        Brush.radialGradient(
                            colors = listOf(
                                Color.White.copy(alpha = 0.48f),
                                Color.White.copy(alpha = 0.20f),
                                Color.White.copy(alpha = 0.05f),
                                Color.Transparent
                            )
                        )
                    )
            )

            // Card Border
            Box(
                Modifier
                    .matchParentSize()
                    .border(
                        width = sdp(R.dimen._1sdp),
                        color = Color.White.copy(alpha = 0.12f),
                        shape = RoundedCornerShape(sdp(R.dimen._20sdp))
                    )
            )
        }

        // ── Model Image (Positioned adaptively to avoid text overlap) ────────
        Image(
            painter = painterResource(category.imageRes),
            contentDescription = category.label,
            contentScale = ContentScale.FillHeight,
            alignment = Alignment.BottomCenter,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = imgEndPadding)
                .width(imgWidth)
                .height(cardHeight + sdp(R.dimen._35sdp))
        )

        // ── Category Text Information ────────────────────────────────────────
        Column(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .fillMaxHeight()
                .padding(start = textStartPadding),
            verticalArrangement = Arrangement.Center
        ) {
            Spacer(Modifier.height(sdp(R.dimen._36sdp)))
            Text(
                text = category.label.uppercase(),
                color = Color.White,
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.SemiBold,
                fontSize = titleFontSize
            )

            Spacer(Modifier.height(sdp(R.dimen._4sdp)))

            Text(
                text = category.subtitle,
                color = Color(0xFFB8B2AC),
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.Medium,
                fontSize = subtitleFontSize
            )

            Spacer(Modifier.height(sdp(R.dimen._10sdp)))

            Box(
                modifier = Modifier
                    .width(sdp(R.dimen._42sdp))
                    .height(sdp(R.dimen._2sdp))
                    .background(
                        Brush.horizontalGradient(
                            listOf(
                                Color(0xFFD99429),
                                Color.Transparent
                            )
                        )
                    )
            )
        }

        // ── Arrow Action Button ──────────────────────────────────────────────
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .padding(end = sdp(R.dimen._12sdp))
                .size(if (isMobile) sdp(R.dimen._36sdp) else sdp(R.dimen._42sdp))
                .clip(CircleShape)
                .background(Color.Transparent)
                .border(
                    width = sdp(R.dimen._1sdp),
                    color = Color.White.copy(alpha = 0.22f),
                    shape = CircleShape
                ),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(if (isMobile) sdp(R.dimen._16sdp) else sdp(R.dimen._18sdp))
            )
        }
    }
}


//──────────────────────────────────────────────────────────────────────────────
// CATEGORY LIST
//──────────────────────────────────────────────────────────────────────────────

@Composable
private fun CategoryList(
    cardHeight: Dp,
    itemSpacing: Dp,
    onCategorySelected: (String) -> Unit
) {

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 16.dp),
        verticalArrangement = Arrangement.spacedBy(itemSpacing)
    ) {

        categories.forEach { category ->

            CategoryCard(
                category = category,
                cardHeight = cardHeight,
                onClick = {
                    onCategorySelected(category.id)
                }
            )
        }
    }
}
//@Composable
//private fun CategoryCard(
//    category: Category,
//    cardHeight: Dp,
//    animationDelay: Int = 0,
//    modifier: Modifier = Modifier,
//    onClick: () -> Unit
//) {
//    val interactionSource = remember { MutableInteractionSource() }
//    val isPressed by interactionSource.collectIsPressedAsState()
//    val scale by animateFloatAsState(
//        targetValue = if (isPressed) 0.97f else 1f,
//        animationSpec = tween(durationMillis = 120, easing = FastOutSlowInEasing),
//        label = "card_scale_${category.id}"
//    )
//
//    // Outer Box is unclipped — lets model image overflow above card top
//    Box(
//        modifier = modifier
//            .fillMaxWidth()
//            .height(cardHeight)
//            .clip(RoundedCornerShape(sdp(R.dimen._14sdp)))
//            .scale(scale)
//            .clickable(interactionSource = interactionSource, indication = null, onClick = onClick)
//    ) {
//        // ── Layer 1: Card background + border ────────────────────────
//        Box(
//            modifier = Modifier
//                .fillMaxSize()
//                .background(Color(0xFF1E1C1A))
//                .border(1.dp, Color(0xFF3D3A37).copy(alpha = 0.70f), RoundedCornerShape(sdp(R.dimen._14sdp)))
//        )
//
//        // ── Layer 2: Model image — right-aligned, head overflows above ─
//        Box(
//            modifier = Modifier
//                .align(Alignment.BottomEnd)
//                .padding(end = sdp(R.dimen._22sdp))
//                .fillMaxWidth(0.52f)
//                .fillMaxHeight()
//        ) {
//            Image(
//                painter = painterResource(category.imageRes),
//                contentDescription = category.label,
//                contentScale = ContentScale.Crop,
//                alignment = Alignment.TopCenter,
//                modifier = Modifier.fillMaxSize()
//            )
//        }
//
//        // ── Layer 3: Gradient blends image into card background ───────
//        Box(
//            modifier = Modifier
//                .fillMaxSize()
//                .background(
//                    Brush.horizontalGradient(
//                        0.00f to Color(0xFF1E1C1A),
//                        0.38f to Color(0xFF1E1C1A),
//                        0.52f to Color(0xFF1E1C1A).copy(alpha = 0.90f),
//                        0.68f to Color(0xFF1E1C1A).copy(alpha = 0.30f),
//                        0.84f to Color(0xFF1E1C1A).copy(alpha = 0.05f),
//                        1.00f to Color.Transparent
//                    )
//                )
//        )
//
//        // ── Layer 4: Text ─────────────────────────────────────────────
//        Column(
//            modifier = Modifier
//                .align(Alignment.CenterStart)
//                .padding(start = sdp(R.dimen._18sdp)),
//            verticalArrangement = Arrangement.Center
//        ) {
//            Text(category.label, color = Color.White, fontSize = ssp(R.dimen._20ssp), fontWeight = FontWeight.Bold, fontFamily = PoppinsFamily, letterSpacing = 0.8.sp)
//            Spacer(Modifier.height(sdp(R.dimen._4sdp)))
//            Text(category.subtitle, color = Color(0xFFB0ABA4), fontSize = ssp(R.dimen._11ssp), fontFamily = PoppinsFamily, fontWeight = FontWeight.Normal, lineHeight = ssp(R.dimen._14ssp))
//            Spacer(Modifier.height(sdp(R.dimen._10sdp)))
//            Box(
//                modifier = Modifier
//                    .size(width = sdp(R.dimen._32sdp), height = 2.dp)
//                    .background(Brush.horizontalGradient(colors = listOf(Color(0xFFD88A18), Color(0xFFD88A18).copy(alpha = 0.08f))))
//            )
//        }
//
//        // ── Layer 5: Arrow circle ─────────────────────────────────────
//        Box(
//            modifier = Modifier
//                .align(Alignment.CenterEnd)
//                .padding(end = sdp(R.dimen._14sdp))
//                .size(sdp(R.dimen._34sdp))
//                .clip(CircleShape)
//                .border(1.dp, Color.White.copy(alpha = 0.30f), CircleShape),
//            contentAlignment = Alignment.Center
//        ) {
//            Icon(Icons.Default.ArrowForward, "Select ${category.label}", tint = Color.White, modifier = Modifier.size(sdp(R.dimen._15sdp)))
//        }
//    }
//}
//
//@Composable
//private fun CategoryList(
//    cardHeight: Dp,
//    itemSpacing: Dp,
//    onCategorySelected: (String) -> Unit
//) {
//    Column(
//        verticalArrangement = Arrangement.spacedBy(itemSpacing),
//        modifier = Modifier.fillMaxWidth()
//    ) {
//        categories.forEachIndexed { index, category ->
//            CategoryCard(
//                category = category,
//                cardHeight = cardHeight,
//                animationDelay = index * 80,
//                onClick = { onCategorySelected(category.id) }
//            )
//        }
//    }
//}

//@Composable
//private fun CategoryList(
//    cardHeight: Dp,
//    itemSpacing: Dp,
//    onCategorySelected: (String) -> Unit
//) {
//    Column(
//        verticalArrangement = Arrangement.spacedBy(itemSpacing),
//        modifier = Modifier.fillMaxWidth()
//    ) {
//        categories.forEach { category ->
//            CategoryCard(
//                category = category,
//                cardHeight = cardHeight,
//                onClick = {
//                    onCategorySelected(category.id)
//                }
//            )
//        }
//    }
//}

// ─── Preview ─────────────────────────────────────────────────────────────────

@Preview()
@Composable
private fun CategorySelectionPageTabletPreview() {
    TryMeTheme { CategorySelectionPage() }
}
