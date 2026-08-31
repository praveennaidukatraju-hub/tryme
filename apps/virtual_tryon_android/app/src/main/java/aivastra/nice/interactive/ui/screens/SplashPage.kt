package tryme.nice.interactive.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.components.AppLoadingIndicator
import tryme.nice.interactive.ui.components.GradientButton
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * SplashPage — Ai Vastra Virtual Trial Room Splash Screen with interactive TRY NOW button overlay.
 */
@Composable
fun SplashPage(
    onClick: () -> Unit = {},
    isLoading: Boolean = false,
    modifier: Modifier = Modifier
) {
    val isPreview = LocalInspectionMode.current
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xFF090807)),
        contentAlignment = Alignment.Center
    ) {
        // ── 1. Pixel-Perfect Design Graphic Asset ────────────────────────────
        Image(
            painter = painterResource(id = R.drawable.splash_screen_bg),
            contentDescription = "Ai Vastra Virtual Trial Room Splash",
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
        )

        // ── 2. Interactive TRY NOW Button Overlay ────────────────────────────
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .widthIn(max = sdp(R.dimen._screen_container_width))
                .fillMaxWidth()
                .padding(
                    start = sdp(R.dimen._20sdp),
                    end = sdp(R.dimen._20sdp),
                    bottom = sdp(R.dimen._30sdp) + navBarH
                )
        ) {
            GradientButton(
                onClick = {
                    if (!isLoading) {
                        onClick()
                    }
                },
                width = sdp(R.dimen._0sdp),
                height = sdp(R.dimen._action_button_height),
                shape = RoundedCornerShape(sdp(R.dimen._14sdp)),
                modifier = Modifier.fillMaxWidth()
            ) {
                if (isLoading) {
                    AppLoadingIndicator(size = sdp(R.dimen._24sdp), color = Color.White)
                } else {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        Text(
                            text = "TRY NOW",
                            color = Color.White,
                            fontSize = ssp(R.dimen._16ssp),
                            fontWeight = FontWeight.Bold,
                            fontFamily = PoppinsFamily
                        )
                        Spacer(Modifier.width(sdp(R.dimen._8sdp)))
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._18sdp))
                        )
                    }
                }
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF090807)
@Composable
private fun SplashPagePreview() {
    TryMeTheme {
        SplashPage()
    }
}
