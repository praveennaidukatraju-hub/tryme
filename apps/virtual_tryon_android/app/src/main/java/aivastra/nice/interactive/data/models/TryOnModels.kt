package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class TryOnJobRequest(
    @SerializedName("merchantCatalogItemId") val merchantCatalogItemId: String,
    @SerializedName("customerPhotoKey") val customerPhotoKey: String
)

data class TryOnJobResponse(
    @SerializedName("jobId") val jobId: String
)

data class TryOnStatusResponse(
    @SerializedName("id") val id: String? = null,
    @SerializedName("status") val status: String,
    @SerializedName("merchantId") val merchantId: String? = null,
    @SerializedName("resultKey") val resultKey: String? = null,
    @SerializedName("shareUrl") val shareUrl: String? = null,
    @SerializedName("errorCode") val errorCode: String? = null,
    @SerializedName("liked") val liked: Boolean? = false,
    @SerializedName("inCart") val inCart: Boolean? = false,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("completedAt") val completedAt: String? = null
)
