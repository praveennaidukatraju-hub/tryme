package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

// ─── Requests ───────────────────────────────────────────────────────────────

data class DeviceLoginRequest(
    @SerializedName("email") val email: String,
    @SerializedName("password") val password: String,
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("deviceName") val deviceName: String,
    @SerializedName("platform") val platform: String
)

data class GoogleLoginRequest(
    @SerializedName("idToken") val idToken: String,
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("deviceName") val deviceName: String,
    @SerializedName("platform") val platform: String
)

data class ForceLoginRequest(
    @SerializedName("forceLogoutToken") val forceLogoutToken: String,
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("deviceName") val deviceName: String,
    @SerializedName("platform") val platform: String
)

data class RefreshTokenRequest(
    @SerializedName("refreshToken") val refreshToken: String,
    @SerializedName("platform") val platform: String
)

data class LogoutRequest(
    @SerializedName("refreshToken") val refreshToken: String
)

// ─── Responses ──────────────────────────────────────────────────────────────

data class UserDto(
    @SerializedName("id") val id: String,
    @SerializedName("email") val email: String,
    @SerializedName("displayName") val displayName: String,
    @SerializedName("tier") val tier: String,
    @SerializedName("maxActiveDevices") val maxActiveDevices: Int,
    @SerializedName("logoUrl") val logoUrlCamel: String? = null,
    @SerializedName("logo_url") val logoUrlSnake: String? = null
) {
    val effectiveLogoUrl: String? get() = logoUrlCamel ?: logoUrlSnake
}

/**
 * Derived server-side, never stored: ONBOARDING_REQUIRED (no merchants row yet) ->
 * show the onboarding form; PENDING_ACTIVATION (row exists but isActive=false) ->
 * block with an "awaiting activation" screen; ACTIVE -> proceed to Home. Without
 * branching on this, a user with no/inactive merchant profile logs in fine and
 * then 403s on every catalog call with no explanation (apps/api/.../status.ts).
 */
object MerchantStatus {
    const val ONBOARDING_REQUIRED = "ONBOARDING_REQUIRED"
    const val PENDING_ACTIVATION = "PENDING_ACTIVATION"
    const val ACTIVE = "ACTIVE"
}

data class OnboardingPrefill(
    @SerializedName("suggestedContactName") val suggestedContactName: String? = null,
    @SerializedName("suggestedCompanyName") val suggestedCompanyName: String? = null
)

data class DeviceLoginResponse(
    @SerializedName("accessToken") val accessToken: String,
    @SerializedName("refreshToken") val refreshToken: String? = null,
    @SerializedName("logoUrl") val logoUrlCamel: String? = null,
    @SerializedName("logo_url") val logoUrlSnake: String? = null,
    @SerializedName("user") val user: UserDto,
    @SerializedName("merchantStatus") val merchantStatus: String? = null,
    // Only present from the Google login route, and only when onboarding is required.
    @SerializedName("onboarding") val onboarding: OnboardingPrefill? = null
) {
    val effectiveLogoUrl: String? get() = logoUrlCamel ?: logoUrlSnake ?: user.effectiveLogoUrl
}

data class RefreshTokenResponse(
    @SerializedName("accessToken") val accessToken: String,
    @SerializedName("refreshToken") val refreshToken: String? = null,
    @SerializedName("logoUrl") val logoUrlCamel: String? = null,
    @SerializedName("logo_url") val logoUrlSnake: String? = null
) {
    val effectiveLogoUrl: String? get() = logoUrlCamel ?: logoUrlSnake
}

data class LogoutResponse(
    @SerializedName("ok") val ok: Boolean
)

/**
 * Single-use code (60s TTL) that lets the in-app WebView (Try-On Library) log
 * into the same account as this device session, without re-entering credentials.
 */
data class CatalogAppDeviceCodeResponse(
    @SerializedName("code") val code: String,
    @SerializedName("expiresInSeconds") val expiresInSeconds: Int
)

// ─── Device Limit Error Payload ──────────────────────────────────────────────

data class ActiveDevice(
    @SerializedName("id") val id: String,
    @SerializedName("platform") val platform: String,
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("deviceName") val deviceName: String,
    @SerializedName("createdAt") val createdAt: String,
    @SerializedName("expiresAt") val expiresAt: String
)

data class DeviceLimitErrorData(
    @SerializedName("code") val code: String,
    @SerializedName("message") val message: String,
    @SerializedName("forceLogoutToken") val forceLogoutToken: String,
    @SerializedName("maxActiveDevices") val maxActiveDevices: Int,
    @SerializedName("activeDevices") val activeDevices: List<ActiveDevice>
)

data class DeviceLimitErrorResponse(
    @SerializedName("error") val error: DeviceLimitErrorData
)
