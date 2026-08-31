package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class KioskDownloadItem(
    @SerializedName("jobId") val jobId: String,
    @SerializedName("url") val url: String
)

data class KioskDownloadBatchResponse(
    @SerializedName("items") val items: List<KioskDownloadItem>
)
