package tryme.nice.interactive.ui.screens

import androidx.annotation.DrawableRes
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import tryme.nice.interactive.ui.components.AppHeaderLogo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.components.GradientButton
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp

@Composable
fun PoseGuidePage(
    category: String,
    onBack: () -> Unit,
    onReady: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val instructionImage = remember(category) { categoryInstructionImage(category) }
    val isPreview = LocalInspectionMode.current
    val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    Box(modifier = modifier.fillMaxSize().background(Color.Black)) {
        Image(
            painter = painterResource(R.drawable.new_app_bg),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize()
        )

        Column(
            modifier = Modifier
                .fillMaxHeight()
                .fillMaxWidth()
                .widthIn(max = sdp(R.dimen._screen_container_width))
                .align(Alignment.TopCenter)
                .padding(start = sdp(R.dimen._18sdp), end = sdp(R.dimen._18sdp), top = statusBarH + sdp(R.dimen._10sdp), bottom = sdp(R.dimen._34sdp) + navBarH)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                PoseBackButton(onBack)
                AppHeaderLogo()
            }

            Spacer(Modifier.height(sdp(R.dimen._23sdp)))
            Text(
                text = "Perfect Your Pose",
                color = Color.White,
                fontSize = ssp(R.dimen._20ssp),
                fontWeight = FontWeight.SemiBold,
                fontFamily = PoppinsFamily
            )
            Spacer(Modifier.height(sdp(R.dimen._10sdp)))
            Text(
                text = "For the most accurate outfit try-on:",
                color = Color.White.copy(alpha = 0.76f),
                fontSize = ssp(R.dimen._14ssp),
                fontFamily = PoppinsFamily
            )
            Spacer(Modifier.height(sdp(R.dimen._5sdp)))
            PoseTip("Stand Straight & Face the camera")
            PoseTip("Keep hands down & Ensure good lighting")

            Spacer(Modifier.height(sdp(R.dimen._16sdp)))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(sdp(R.dimen._8sdp)))
                    .background(Color(0xFF2B1E10).copy(alpha = 0.72f))
                    .border(sdp(R.dimen._1sdp), Color(0xFFB96B05).copy(alpha = 0.55f), RoundedCornerShape(sdp(R.dimen._8sdp)))
                    .padding(horizontal = sdp(R.dimen._10sdp), vertical = sdp(R.dimen._8sdp)),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Image(
                    painter = painterResource(R.drawable.pose_right_light_icon),
                    contentDescription = null,
                    modifier = Modifier.size(sdp(R.dimen._16sdp))
                )
                Spacer(Modifier.width(sdp(R.dimen._8sdp)))
                Text(
                    "Incorrect poses may affect fitting results.",
                    color = Color.White.copy(alpha = 0.72f),
                    fontSize = ssp(R.dimen._12ssp),
                    fontFamily = PoppinsFamily
                )
            }

            Spacer(Modifier.height(sdp(R.dimen._20sdp)))
            Image(
                painter = painterResource(instructionImage),
                contentDescription = "Correct and incorrect pose examples for $category",
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            )

            Spacer(Modifier.height(sdp(R.dimen._24sdp)))
            GradientButton(
                onClick = onReady,
                width = sdp(R.dimen._0sdp),
                height = sdp(R.dimen._action_button_height),
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(sdp(R.dimen._9sdp))
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center
                ) {
                    Icon(
                        painter = painterResource(R.drawable.i_am_ready_icon),
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(sdp(R.dimen._20sdp))
                    )
                    Spacer(Modifier.width(sdp(R.dimen._8sdp)))
                    Text(
                        text = "I’m Ready",
                        color = Color.White,
                        fontSize = ssp(R.dimen._14ssp),
                        fontWeight = FontWeight.Bold,
                        fontFamily = PoppinsFamily
                    )
                }
            }
            Spacer(Modifier.height(sdp(R.dimen._8sdp)))
        }
    }
}

@Composable
private fun PoseTip(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Image(
            painter = painterResource(R.drawable.pose_right_ins_icon),
            contentDescription = null,
            modifier = Modifier.size(sdp(R.dimen._16sdp))
        )
        Spacer(Modifier.width(sdp(R.dimen._6sdp)))
        Text(text, color = Color.White.copy(alpha = 0.86f), fontSize = ssp(R.dimen._14ssp), fontFamily = PoppinsFamily)
    }
}

@Composable
private fun PoseBackButton(onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(sdp(R.dimen._38sdp))
            .clip(CircleShape)
            .background(Brush.linearGradient(listOf(Color(0xFFE7A52C), Color(0xFF9B5100))))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick
            ),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = "Back",
            tint = Color.White,
            modifier = Modifier.size(sdp(R.dimen._20sdp))
        )
    }
}

@DrawableRes
private fun categoryInstructionImage(category: String): Int = when (category.lowercase()) {
    "men" -> R.drawable.men_instruction
    "boys" -> R.drawable.boys_instruction
    "girls" -> R.drawable.girls_instruction
    else -> R.drawable.women_instruction
}

@Preview(
    name = "Pose Guide - Women",
    showBackground = true,
    widthDp = 375,
    heightDp = 667
)
@Composable
private fun PoseGuidePagePreview() {
    TryMeTheme {
        PoseGuidePage(
            category = "women",
            onBack = {}
        )
    }
}
