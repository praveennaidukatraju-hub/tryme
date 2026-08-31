package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class TryOnHistoryDay(
    @SerializedName("date") val date: String,
    @SerializedName("inputCount") val inputCount: Int,
    @SerializedName("generatedCount") val generatedCount: Int,
    @SerializedName("failedCount") val failedCount: Int
)

data class TryOnHistoryResponse(
    @SerializedName("days") val days: List<TryOnHistoryDay>,
    @SerializedName("nextCursor") val nextCursor: String?
)
