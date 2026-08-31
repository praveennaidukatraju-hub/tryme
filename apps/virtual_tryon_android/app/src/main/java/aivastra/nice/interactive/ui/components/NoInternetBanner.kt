package tryme.nice.interactive.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.NetworkMonitor
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp

/**
 * App-wide "no internet connection" banner. Observes [NetworkMonitor] directly — no state has
 * to be threaded in from the host screen — so dropping this composable once at the top of the
 * view hierarchy (see `MainActivity`) covers every screen in the app automatically.
 */
@Composable
fun NoInternetBanner(modifier: Modifier = Modifier) {
    val isConnected by NetworkMonitor.isConnected.collectAsState()
    val layoutDirection = LocalLayoutDirection.current
    val statusBarInsets = WindowInsets.statusBars.asPaddingValues()

    AnimatedVisibility(
        visible = !isConnected,
        enter = fadeIn() + slideInVertically(initialOffsetY = { -it }),
        exit = fadeOut() + slideOutVertically(targetOffsetY = { -it }),
        modifier = modifier
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFFE05252))
                .padding(
                    start = statusBarInsets.calculateStartPadding(layoutDirection) + sdp(R.dimen._16sdp),
                    end = statusBarInsets.calculateEndPadding(layoutDirection) + sdp(R.dimen._16sdp),
                    top = statusBarInsets.calculateTopPadding() + sdp(R.dimen._8sdp),
                    bottom = sdp(R.dimen._8sdp)
                )
        ) {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(sdp(R.dimen._14sdp))
            )
            Text(
                text = "No internet connection",
                color = Color.White,
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.Medium,
                fontSize = ssp(R.dimen._12ssp),
                modifier = Modifier.padding(start = sdp(R.dimen._8sdp))
            )
        }
    }
}
