package tryme.nice.interactive.data.repository

import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.MerchantMeResponse
import tryme.nice.interactive.utils.ErrorParser

sealed interface MerchantResult<out T> {
    data class Success<T>(val data: T) : MerchantResult<T>
    data class Failure(val message: String) : MerchantResult<Nothing>
}

/**
 * Uses ApiClient.apiService (the authenticated client) — /v1/merchant/me is guarded
 * by requireMerchant, which reads the same Bearer token the catalog calls use.
 */
class MerchantRepository(
    private val service: ApiService = ApiClient.apiService
) {
    suspend fun getMe(): MerchantResult<MerchantMeResponse> {
        return try {
            val response = service.getMerchantMe()
            val body = response.body()
            if (response.isSuccessful && body != null) {
                MerchantResult.Success(body)
            } else {
                MerchantResult.Failure(ErrorParser.parseErrorMessage(response, "Unable to load account (${response.code()})"))
            }
        } catch (e: Exception) {
            MerchantResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }
}
