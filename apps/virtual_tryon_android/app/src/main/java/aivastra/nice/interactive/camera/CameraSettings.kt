package tryme.nice.interactive.camera

import android.util.Size
import kotlin.math.abs
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy

enum class CaptureQualityOption(val label: String) {
    ULTRA_4K("Ultra 4K"),
    HIGH_HD("High HD"),
    STANDARD_SD("Standard SD")
}

enum class ResolutionRatioOption(val label: String, val aspectRatio: Float) {
    RATIO_4_3("4 : 3", 4f / 3f),
    RATIO_16_9("16 : 9", 16f / 9f),
    RATIO_1_1("1 : 1", 1f)
}

enum class SurfaceStreamTypeOption(val label: String, val detail: String) {
    SURFACE_VIEW("SurfaceView", "(Low Latency)"),
    TEXTURE_VIEW("TextureView", "(Compositing)")
}

enum class HdrOption(val label: String) {
    HDR_AUTO("HDR Auto"),
    HDR_ON("HDR On"),
    HDR_OFF("HDR Off")
}

enum class SkinFilterOption(val label: String) {
    NATURAL("Natural"),
    SMOOTH_STUDIO("Smooth Studio"),
    VIVID_FABRIC("Vivid Fabric")
}

enum class CameraFacingOption(val label: String) {
    BACK("Back Camera"),
    FRONT("Front Camera")
}

enum class TimerOption(val label: String, val seconds: Int) {
    SEC_10("10 Seconds", 10),
    SEC_5("5 Seconds", 5),
    SEC_3("3 Seconds", 3),
    OFF("Off", 0)
}

data class CameraSettings(
    val captureQuality: CaptureQualityOption = CaptureQualityOption.ULTRA_4K,
    val resolutionRatio: ResolutionRatioOption = ResolutionRatioOption.RATIO_4_3,
    val surfaceStreamType: SurfaceStreamTypeOption = SurfaceStreamTypeOption.TEXTURE_VIEW,
    val hdrOption: HdrOption = HdrOption.HDR_ON,
    val skinFilter: SkinFilterOption = SkinFilterOption.NATURAL,
    val cameraFacing: CameraFacingOption = CameraFacingOption.BACK,
    val timerOption: TimerOption = TimerOption.SEC_10,
    val countdownSeconds: Int = 10,
    // Exact device-reported picture size ("Picture Resolution" setting). Null falls back to
    // the captureQuality/resolutionRatio tiers below; set, it takes priority over them.
    val pictureSize: Size? = null
)

// Ties the "Capture Quality" setting to an actual CameraX resolution target.
// Kiosk/box cameras otherwise let CameraX auto-pick a low default resolution,
// which is the main cause of soft/low-res captures on those devices.
fun CaptureQualityOption.toResolutionStrategy(): ResolutionStrategy = when (this) {
    CaptureQualityOption.ULTRA_4K -> ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY
    CaptureQualityOption.HIGH_HD -> ResolutionStrategy(
        Size(1920, 1080),
        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
    )
    CaptureQualityOption.STANDARD_SD -> ResolutionStrategy(
        Size(1280, 720),
        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
    )
}

fun CaptureQualityOption.toJpegQuality(): Int = when (this) {
    CaptureQualityOption.ULTRA_4K -> 100
    CaptureQualityOption.HIGH_HD -> 95
    CaptureQualityOption.STANDARD_SD -> 85
}

fun ResolutionRatioOption.toAspectRatioStrategy(): AspectRatioStrategy = when (this) {
    ResolutionRatioOption.RATIO_16_9 -> AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY
    ResolutionRatioOption.RATIO_4_3, ResolutionRatioOption.RATIO_1_1 ->
        AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
}

// AspectRatioStrategy only accepts CameraX's two predefined ratios (4:3 / 16:9), not an
// arbitrary Rational, so an explicit device picture size is matched to whichever is closer.
private fun Size.toNearestAspectRatioStrategy(): AspectRatioStrategy {
    val long = maxOf(width, height).toFloat()
    val short = minOf(width, height).toFloat()
    if (short <= 0f) return AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
    val ratio = long / short
    return if (abs(ratio - 16f / 9f) < abs(ratio - 4f / 3f)) {
        AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY
    } else {
        AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
    }
}

// A user-picked exact picture size takes priority over the coarse quality tier: its own
// aspect ratio drives the AspectRatioStrategy and its exact value drives the ResolutionStrategy.
fun CameraSettings.toResolutionSelector(): ResolutionSelector {
    val explicitSize = pictureSize
    val aspectRatioStrategy = if (explicitSize != null) {
        explicitSize.toNearestAspectRatioStrategy()
    } else {
        resolutionRatio.toAspectRatioStrategy()
    }
    val resolutionStrategy = if (explicitSize != null) {
        ResolutionStrategy(explicitSize, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
    } else {
        captureQuality.toResolutionStrategy()
    }
    return ResolutionSelector.Builder()
        .setAspectRatioStrategy(aspectRatioStrategy)
        .setResolutionStrategy(resolutionStrategy)
        .build()
}
