package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class OnboardingStatusResponse(
    @SerializedName("merchantStatus") val merchantStatus: String,
    @SerializedName("prefill") val prefill: OnboardingStatusPrefill
)

data class OnboardingStatusPrefill(
    @SerializedName("contactName") val contactName: String,
    @SerializedName("companyName") val companyName: String,
    @SerializedName("phone") val phone: String
)

data class MerchantOnboardingRequest(
    @SerializedName("phone") val phone: String,
    @SerializedName("contactName") val contactName: String? = null,
    @SerializedName("companyName") val companyName: String? = null,
    @SerializedName("businessAddress") val businessAddress: String? = null
)

data class MerchantOnboardingResponse(
    @SerializedName("merchantStatus") val merchantStatus: String,
    @SerializedName("merchantId") val merchantId: String
)
