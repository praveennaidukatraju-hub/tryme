package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class ApiErrorWrapper(
    @SerializedName("error") val error: ApiErrorDetail?
)

data class ApiErrorDetail(
    @SerializedName("code") val code: String?,
    @SerializedName("message") val message: String?
)
