package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class MerchantMeResponse(
    @SerializedName("displayName") val displayName: String,
    @SerializedName("email") val email: String,
    @SerializedName("balance") val balance: Int,
    @SerializedName("used") val used: Int
)
