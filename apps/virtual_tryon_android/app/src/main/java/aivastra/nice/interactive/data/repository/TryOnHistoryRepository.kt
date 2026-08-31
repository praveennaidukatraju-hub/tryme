package tryme.nice.interactive.data.repository

import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.TryOnHistoryResponse

sealed interface TryOnHistoryResult<out T> {
    data class Success<T>(val data: T) : TryOnHistoryResult<T>
    data class Failure(val message: String) : TryOnHistoryResult<Nothing>
}

class TryOnHistoryRepository(
    private val apiService: ApiService = ApiClient.apiService
) {
    suspend fun getHistory(
        before: String? = null,
        limit: Int = 30
    ): TryOnHistoryResult<TryOnHistoryResponse> {
        return try {
            val response = apiService.getTryOnHistory(before, limit)
            val body = response.body()
            if (response.isSuccessful && body != null) {
                TryOnHistoryResult.Success(body)
            } else {
                TryOnHistoryResult.Failure(
                    response.errorBody()?.string() ?: "Unable to load history (${response.code()})"
                )
            }
        } catch (e: Exception) {
            TryOnHistoryResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }
}
