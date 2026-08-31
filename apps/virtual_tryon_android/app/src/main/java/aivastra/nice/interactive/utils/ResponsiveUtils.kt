package tryme.nice.interactive.utils

import androidx.annotation.DimenRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.dimensionResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit

/**
 * Lightweight helper to load responsive DP dimensions from resource files.
 */
@Composable
fun sdp(@DimenRes id: Int): Dp {
    return dimensionResource(id)
}

/**
 * Lightweight helper to load responsive SP font sizes from resource files.
 */
@Composable
fun ssp(@DimenRes id: Int): TextUnit {
    val density = LocalDensity.current
    return with(density) { dimensionResource(id).toSp() }
}
