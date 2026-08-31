package tryme.nice.interactive.ui.screens

import tryme.nice.interactive.R
import tryme.nice.interactive.ui.components.AppHeaderLogo
import tryme.nice.interactive.ui.components.GradientButton
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview

/**
 * Shown when login returns merchantStatus = PENDING_ACTIVATION — a merchants row
 * exists but is not yet marked active (awaiting admin approval). Blocking screen:
 * every /v1/merchant/{...} call would 403 until an admin flips isActive, so there is
 * nothing else useful for the user to do here besides sign out and check back later.
 */
@Composable
fun PendingActivationPage(
    onLogout: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize().background(Color.Black)) {
        Image(
            painter = painterResource(id = R.drawable.new_app_bg),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .widthIn(max = sdp(R.dimen._screen_container_width))
                .padding(horizontal = sdp(R.dimen._24sdp)),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            AppHeaderLogo(modifier = Modifier.size(width = sdp(R.dimen._250sdp), height = sdp(R.dimen._65sdp)))

            Spacer(modifier = Modifier.height(sdp(R.dimen._30sdp)))

            Box(
                modifier = Modifier
                    .size(sdp(R.dimen._65sdp))
                    .background(Color(0xFFD88A18).copy(alpha = 0.15f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.DateRange,
                    contentDescription = null,
                    tint = Color(0xFFD88A18),
                    modifier = Modifier.size(sdp(R.dimen._30sdp))
                )
            }

            Spacer(modifier = Modifier.height(sdp(R.dimen._20sdp)))

            Text(
                text = "Account Awaiting Activation",
                color = Color.White,
                fontSize = ssp(R.dimen._22ssp),
                fontWeight = FontWeight.Bold,
                fontFamily = PoppinsFamily,
                textAlign = TextAlign.Center
            )

            Spacer(modifier = Modifier.height(sdp(R.dimen._10sdp)))

            Text(
                text = "Your business details were submitted successfully. An TryMe admin needs to activate your account before you can start using the kiosk.",
                color = Color.White.copy(alpha = 0.65f),
                fontSize = ssp(R.dimen._13ssp),
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.Normal,
                textAlign = TextAlign.Center
            )

            Spacer(modifier = Modifier.height(sdp(R.dimen._30sdp)))

            GradientButton(
                onClick = onLogout,
                width = sdp(R.dimen._0sdp),
                height = sdp(R.dimen._action_button_height),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = "SIGN OUT",
                    color = Color.White,
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.Bold,
                    fontSize = ssp(R.dimen._16ssp)
                )
                Spacer(modifier = Modifier.size(sdp(R.dimen._8sdp)))
                Icon(
                    imageVector = Icons.Default.ExitToApp,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(sdp(R.dimen._18sdp))
                )
            }
        }
    }
}

@Preview(showBackground = true, showSystemUi = true, device = "spec:width=411dp,height=891dp,dpi=420")
@Composable
private fun PendingActivationPagePreview() {
    TryMeTheme { PendingActivationPage() }
}
