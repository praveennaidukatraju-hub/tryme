package tryme.nice.trymeadmin.viewmodels

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import java.io.Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogSareeStyle(
    @JsonProperty("id") val id: String = "",
    @JsonProperty("label") val label: String = "",
    @JsonProperty("previewUrl") val previewUrl: String? = null,
    @JsonProperty("sortOrder") val sortOrder: Int = 0,
    @JsonProperty("supportsTwoInput") val supportsTwoInput: Boolean = false
) : Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogSareeStyleListResponse(
    @JsonProperty("items") val items: List<MerchantCatalogSareeStyle> = emptyList()
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogSubcategory(@JsonProperty("id") val id: String = "", @JsonProperty("category") val category: String = "", @JsonProperty("name") val name: String = "", @JsonProperty("productCount") val productCount: Int = 0) : Serializable
@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogSubcategoryListResponse(@JsonProperty("items") val items: List<MerchantCatalogSubcategory> = emptyList())
@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogItem(@JsonProperty("id") val id: String = "", @JsonProperty("subcategoryId") val subcategoryId: String = "", @JsonProperty("label") val label: String = "", @JsonProperty("sku") val sku: String? = null, @JsonProperty("actualPrice") val actualPrice: Int = 0, @JsonProperty("offerPrice") val offerPrice: Int = 0, @JsonProperty("imageUrl") val imageUrl: String? = null, @JsonProperty("thumbnailUrl") val thumbnailUrl: String? = null) : Serializable
@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogListResponse(@JsonProperty("items") val items: List<MerchantCatalogItem> = emptyList())

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogPresignResponse(@JsonProperty("assetId") val assetId: String = "", @JsonProperty("uploadUrl") val uploadUrl: String = "", @JsonProperty("r2Key") val r2Key: String = "")
@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogGenerateResponse(@JsonProperty("jobId") val jobId: String = "")
@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogGenerateStatus(@JsonProperty("jobId") val jobId: String = "", @JsonProperty("status") val status: String = "", @JsonProperty("resultUrl") val resultUrl: String? = null, @JsonProperty("errorCode") val errorCode: String? = null)

/** Pure — no Android/network dependency, safe for a plain JUnit test. */
fun isTerminalGenerateStatus(status: String): Boolean = status == "COMPLETED" || status == "FAILED" || status == "CANCELLED"
