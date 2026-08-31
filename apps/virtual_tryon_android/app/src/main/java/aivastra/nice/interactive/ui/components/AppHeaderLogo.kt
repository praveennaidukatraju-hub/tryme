package tryme.nice.interactive.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import tryme.nice.interactive.R
import tryme.nice.interactive.data.session.SessionManager
import tryme.nice.interactive.utils.sdp
import coil.compose.AsyncImage

/**
 * Reusable dynamic header logo. Displays the merchant's custom logoUrl if present,
 * or defaults to ai_vastra_new_logo as placeholder across all screens.
 */
@Composable
fun AppHeaderLogo(
    modifier: Modifier = Modifier,
    logoUrl: String? = SessionManager.logoUrl
) {
    // sdp scales with screen-width bucket but not enough to stay visually proportional from
    // phone up to tablet/kiosk, and this logo is used on nearly every screen — sizing it off
    // the real screen width here fixes it everywhere at once instead of per-screen.
    val isMobile = LocalConfiguration.current.screenWidthDp.dp < 500.dp
    val logoWidth = if (isMobile) sdp(R.dimen._170sdp) else sdp(R.dimen._220sdp)
    val logoHeight = if (isMobile) sdp(R.dimen._80sdp) else sdp(R.dimen._92sdp)

    val targetLogo = logoUrl?.takeIf { it.isNotBlank() } ?: SessionManager.logoUrl?.takeIf { it.isNotBlank() }
    if (targetLogo != null) {
        AsyncImage(
            model = targetLogo,
            contentDescription = "Ai Vastra Logo",
            contentScale = ContentScale.Fit,
            error = painterResource(R.drawable.ai_vastra_new_logo),
            placeholder = painterResource(R.drawable.ai_vastra_new_logo),
            modifier = modifier
                .width(logoWidth)
                .height(logoHeight)
        )
    } else {
        Image(
            painter = painterResource(R.drawable.ai_vastra_new_logo),
            contentDescription = "Ai Vastra Logo",
            contentScale = ContentScale.Fit,
            modifier = modifier
                .width(logoWidth)
                .height(logoHeight)
        )
    }
}
