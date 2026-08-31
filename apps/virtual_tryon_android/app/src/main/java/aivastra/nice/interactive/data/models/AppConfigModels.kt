package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class AppVideoConfigResponse(
    @SerializedName("videoUrl") val videoUrl: String?
)
