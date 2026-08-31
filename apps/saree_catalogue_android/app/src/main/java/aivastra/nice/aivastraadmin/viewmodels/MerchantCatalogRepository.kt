package tryme.nice.trymeadmin.viewmodels

import tryme.nice.trymeadmin.utils.PrefsManager
import com.example.facewixlatest.ApiUtils.APICaller
import com.example.facewixlatest.ApiUtils.APIConstant
import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody

object MerchantCatalogRepository {
    private val mapper = ObjectMapper()
    suspend fun fetchSareeStyles(): List<MerchantCatalogSareeStyle> {
        val response = APICaller.getJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_SAREE_STYLES, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogSareeStyleListResponse::class.java).items
    }

    suspend fun fetchSubcategories(category: String): List<MerchantCatalogSubcategory> {
        val response = APICaller.getJsonAuthed("${APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_SAREE_SUBCATEGORIES}?category=$category", PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogSubcategoryListResponse::class.java).items
    }
    suspend fun fetchItems(subcategoryId: String? = null, search: String? = null): List<MerchantCatalogItem> {
        val params = buildList { subcategoryId?.let { add("subcategoryId=$it") }; search?.takeIf { it.isNotBlank() }?.let { add("search=${java.net.URLEncoder.encode(it, "UTF-8")}") } }
        val response = APICaller.getJsonAuthed("${APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_ITEMS}${if (params.isEmpty()) "" else "?${params.joinToString("&")}"}", PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogListResponse::class.java).items
    }

    suspend fun presignFlatImage(contentType: String, contentLength: Long): MerchantCatalogPresignResponse {
        val body = org.json.JSONObject().apply { put("kind", "flat"); put("contentType", contentType); put("contentLength", contentLength) }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_PRESIGN, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogPresignResponse::class.java)
    }

    suspend fun uploadFlatImage(uploadUrl: String, file: java.io.File, contentType: String) {
        APICaller.putToPresignedUrl(uploadUrl, file.asRequestBody(contentType.toMediaType()))
    }

    suspend fun generate(
        subcategoryId: String,
        flatImageKey: String,
        secondFlatImageKey: String? = null,
        sareeStyleId: String? = null
    ): String {
        // This app only ever generates saree catalog images — skip the normal pose/
        // background/face compositing step and finalize with the mannequin-drape
        // output directly (see createMerchantSareeMannequinJob on the API side).
        val body = org.json.JSONObject().apply {
            put("subcategoryId", subcategoryId)
            put("flatImageKey", flatImageKey)
            if (!secondFlatImageKey.isNullOrEmpty()) {
                put("secondFlatImageKey", secondFlatImageKey)
            }
            put("mannequinOnly", true)
            if (!sareeStyleId.isNullOrEmpty()) {
                put("sareeStyleId", sareeStyleId)
            }
        }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_GENERATE, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogGenerateResponse::class.java).jobId
    }

    suspend fun pollGenerateStatus(jobId: String): MerchantCatalogGenerateStatus {
        val response = APICaller.getJsonAuthed(APIConstant.API_ENDPOINTS.merchantCatalogGenerateStatus(jobId), PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogGenerateStatus::class.java)
    }

    suspend fun import(jobId: String, subcategoryId: String): MerchantCatalogItem {
        val body = org.json.JSONObject().apply { put("jobId", jobId); put("subcategoryId", subcategoryId) }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_IMPORT, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogItem::class.java)
    }

    suspend fun setPricing(itemId: String, sku: String, actualPrice: Int, offerPrice: Int): MerchantCatalogItem {
        val body = org.json.JSONObject().apply { put("sku", sku); put("actualPrice", actualPrice); put("offerPrice", offerPrice) }.toString()
        val response = APICaller.patchJsonAuthed(APIConstant.API_ENDPOINTS.merchantCatalogItem(itemId), body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogItem::class.java)
    }
}
