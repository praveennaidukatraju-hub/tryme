package tryme.nice.interactive.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import tryme.nice.interactive.ui.components.AppHeaderLogo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import tryme.nice.interactive.R
import tryme.nice.interactive.data.models.CatalogProduct
import tryme.nice.interactive.ui.components.GradientButton
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.PoppinsFamily

import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp

@Composable
fun OutfitDetailPage(
    product: CatalogProduct,
    productList: List<CatalogProduct> = emptyList(),
    onBack: () -> Unit,
    onStartTryOn: (CatalogProduct) -> Unit = {},
    modifier: Modifier = Modifier
) {
    val effectiveList = remember(product, productList) {
        if (productList.isNotEmpty()) productList else listOf(product)
    }
    var currentIndex by remember(product, effectiveList) {
        val idx = effectiveList.indexOfFirst { it.id == product.id }
        mutableIntStateOf(if (idx >= 0) idx else 0)
    }
    val currentProduct = effectiveList.getOrNull(currentIndex) ?: product

    // Pinch-to-zoom / pan / double-tap-to-reset on the outfit image, keyed to currentIndex so
    // switching garments via the arrows always starts the next image back at 1x. Pan is clamped
    // to the overflow the current zoom level actually produces, and the card's own clip() keeps
    // zoomed content from ever painting outside the image card - zoom stays within view only.
    var imageScale by remember(currentIndex) { mutableFloatStateOf(1f) }
    var imageOffset by remember(currentIndex) { mutableStateOf(Offset.Zero) }
    var imageContainerSize by remember { mutableStateOf(IntSize.Zero) }

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
                .padding(start = sdp(R.dimen._18sdp), end = sdp(R.dimen._18sdp), top = statusBarH + sdp(R.dimen._10sdp), bottom = sdp(R.dimen._34sdp) + navBarH),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // ── Top Bar (Back Arrow + Logo) ──────────────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                RoundNavigationButton(onClick = onBack, size = sdp(R.dimen._38sdp)) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                        tint = Color.White,
                        modifier = Modifier.size(sdp(R.dimen._20sdp))
                    )
                }
                AppHeaderLogo()
            }

            Spacer(Modifier.height(sdp(R.dimen._32sdp)))

            // ── Image Display Card with Left/Right Navigation Arrows ────────
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(sdp(R.dimen._12sdp)))
                        .background(Color(0xFFD4B798))
                        .border(
                            sdp(R.dimen._1sdp),
                            Brush.linearGradient(listOf(Color(0xFFE7A52C), Color(0xFF9B5100))),
                            RoundedCornerShape(sdp(R.dimen._12sdp))
                        )
                ) {
                    SubcomposeAsyncImage(
                        model = currentProduct.imageUrl ?: currentProduct.thumbnailUrl,
                        contentDescription = currentProduct.label ?: "Selected outfit",
                        contentScale = ContentScale.FillBounds,
                        alignment = Alignment.Center,
                        modifier = Modifier
                            .fillMaxSize()
                            .onGloballyPositioned { imageContainerSize = it.size }
                            .pointerInput(currentIndex) {
                                detectTapGestures(onDoubleTap = {
                                    imageScale = 1f
                                    imageOffset = Offset.Zero
                                })
                            }
                            .pointerInput(currentIndex) {
                                detectTransformGestures { _, pan, zoom, _ ->
                                    val newScale = (imageScale * zoom).coerceIn(1f, 4f)
                                    val maxPanX = (imageContainerSize.width * (newScale - 1f) / 2f).coerceAtLeast(0f)
                                    val maxPanY = (imageContainerSize.height * (newScale - 1f) / 2f).coerceAtLeast(0f)
                                    imageOffset = Offset(
                                        x = (imageOffset.x + pan.x).coerceIn(-maxPanX, maxPanX),
                                        y = (imageOffset.y + pan.y).coerceIn(-maxPanY, maxPanY)
                                    )
                                    imageScale = newScale
                                }
                            }
                            .graphicsLayer {
                                scaleX = imageScale
                                scaleY = imageScale
                                translationX = imageOffset.x
                                translationY = imageOffset.y
                            },
                        loading = {
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                CircularProgressIndicator(
                                    color = Color(0xFFE59B17),
                                    strokeWidth = sdp(R.dimen._2sdp),
                                    modifier = Modifier.size(sdp(R.dimen._32sdp))
                                )
                            }
                        },
                        error = {
                            Image(
                                painter = painterResource(R.drawable.placeholder),
                                contentDescription = null,
                                contentScale = ContentScale.Fit,
                                modifier = Modifier.fillMaxSize()
                            )
                        }
                    )
                }

                val listSize = effectiveList.size
                if (listSize > 1) {
                    // Left Arrow Button (Previous Outfit in Subcategory - Wraps around)
                    RoundNavigationButton(
                        onClick = {
                            currentIndex = if (currentIndex - 1 < 0) listSize - 1 else currentIndex - 1
                        },
                        size = sdp(R.dimen._40sdp),
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .offset(x = (-sdp(R.dimen._14sdp)))
                    ) {
                        Icon(
                            Icons.Default.KeyboardArrowLeft,
                            contentDescription = "Previous Outfit",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._24sdp))
                        )
                    }

                    // Right Arrow Button (Next Outfit in Subcategory - Wraps around)
                    RoundNavigationButton(
                        onClick = {
                            currentIndex = (currentIndex + 1) % listSize
                        },
                        size = sdp(R.dimen._40sdp),
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .offset(x = sdp(R.dimen._14sdp))
                    ) {
                        Icon(
                            Icons.Default.KeyboardArrowRight,
                            contentDescription = "Next Outfit",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._24sdp))
                        )
                    }
                }
            }

            Spacer(Modifier.height(sdp(R.dimen._22sdp)))
            PriceText(currentProduct)
            Spacer(Modifier.height(sdp(R.dimen._16sdp)))

            GradientButton(
                onClick = { onStartTryOn(currentProduct) },
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
                        painter = painterResource(R.drawable.start_tryon_icon),
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(sdp(R.dimen._20sdp))
                    )
                    Spacer(Modifier.width(sdp(R.dimen._8sdp)))
                    Text(
                        text = "Start Try-On",
                        color = Color.White,
                        fontSize = ssp(R.dimen._16ssp),
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
private fun PriceText(product: CatalogProduct) {
    val actualPrice = product.actualPricePaise / 100
    val offerPrice = product.offerPricePaise / 100
    val sellingPrice = offerPrice.takeIf { it > 0 } ?: actualPrice

    Text(
        text = buildAnnotatedString {
            withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.Bold)) {
                append("Price : ₹$sellingPrice")
            }
            if (offerPrice > 0 && actualPrice > offerPrice) {
                append("   ")
                withStyle(
                    SpanStyle(
                        color = Color.White.copy(alpha = 0.48f),
                        textDecoration = TextDecoration.LineThrough
                    )
                ) {
                    append("₹$actualPrice")
                }
            }
        },
        fontSize = ssp(R.dimen._14ssp),
        fontFamily = PoppinsFamily
    )
}

@Composable
private fun RoundNavigationButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = sdp(R.dimen._38sdp),
    content: @Composable () -> Unit
) {
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(
                Brush.linearGradient(
                    listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                )
            )
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick
            ),
        contentAlignment = Alignment.Center
    ) {
        content()
    }
}

@Preview(
    name = "Outfit Detail - Phone",
    showBackground = true,
    widthDp = 375,
    heightDp = 667
)
@Composable
private fun OutfitDetailPagePreview() {
    TryMeTheme {
        OutfitDetailPage(
            product = CatalogProduct(
                id = "preview-outfit",
                merchantId = "preview-merchant",
                subcategoryId = "preview-saree",
                label = "Maroon Saree",
                sku = "SAREE-001",
                actualPricePaise = 89900,
                offerPricePaise = 59900,
                moderationStatus = "approved",
                imageUrl = null,
                thumbnailUrl = null
            ),
            onBack = {}
        )
    }
}
