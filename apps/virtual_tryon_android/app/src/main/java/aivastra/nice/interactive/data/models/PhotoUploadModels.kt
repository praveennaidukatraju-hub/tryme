package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class CreateUploadSessionResponse(
    @SerializedName("qrUrl") val qrUrl: String,
    @SerializedName("token") val token: String?
)

data class UploadSessionStatusResponse(
    @SerializedName("status") val status: String,
    @SerializedName("r2Key") val r2Key: String?
)

data class PresignRequest(
    @SerializedName("contentType") val contentType: String = "image/jpeg",
    @SerializedName("contentLength") val contentLength: Long
)

data class PresignResponse(
    @SerializedName("uploadUrl") val uploadUrl: String,
    @SerializedName("r2Key") val r2Key: String
)

data class PhotoUrlResponse(
    @SerializedName("url") val url: String
)
