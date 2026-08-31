package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class ContactRequest(
    @SerializedName("name") val name: String,
    @SerializedName("email") val email: String,
    @SerializedName("phone") val phone: String,
    @SerializedName("source") val source: String? = "android-app",
    @SerializedName("message") val message: String? = null
)
