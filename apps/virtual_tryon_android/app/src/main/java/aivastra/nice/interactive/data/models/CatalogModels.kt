package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class SubcategoryResponse(
    @SerializedName("items") val items: List<GarmentSubcategory> = emptyList()
)

data class GarmentSubcategory(
    @SerializedName("id") val id: String,
    @SerializedName("merchantId") val merchantId: String,
    @SerializedName("category") val category: String,
    @SerializedName("name") val name: String,
    @SerializedName("garmentSubcategoryId") val garmentSubcategoryId: String?,
    @SerializedName("sortOrder") val sortOrder: Int = 0,
    @SerializedName("productCount") val productCount: Int = 0
)

data class CatalogResponse(
    @SerializedName("items") val items: List<CatalogProduct> = emptyList()
)

data class CatalogProduct(
    @SerializedName("id") val id: String,
    @SerializedName("merchantId") val merchantId: String,
    @SerializedName("subcategoryId") val subcategoryId: String,
    @SerializedName("label") val label: String?,
    @SerializedName("sku") val sku: String?,
    @SerializedName("actualPricePaise") val actualPricePaise: Long = 0,
    @SerializedName("offerPricePaise") val offerPricePaise: Long = 0,
    @SerializedName("isActive") val isActive: Boolean = true,
    @SerializedName("moderationStatus") val moderationStatus: String?,
    @SerializedName("sortOrder") val sortOrder: Int = 0,
    @SerializedName("imageUrl") val imageUrl: String?,
    @SerializedName("thumbnailUrl") val thumbnailUrl: String?
)
