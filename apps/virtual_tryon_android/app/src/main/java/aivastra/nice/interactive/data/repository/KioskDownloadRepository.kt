package tryme.nice.interactive.data.repository

import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.KioskDownloadItem

sealed interface KioskDownloadResult<out T> {
    data class Success<T>(val data: T) : KioskDownloadResult<T>
    data class Failure(val message: String) : KioskDownloadResult<Nothing>
}

/**
 * Public route (no merchant auth) backing the "Download All" kiosk QR — kept as its own
 * repository since, unlike every other repository in this app, its result reflects what a
 * customer's phone would see when scanning, not anything scoped to the logged-in merchant.
 */
class KioskDownloadRepository(
    private val apiService: ApiService = ApiClient.apiService
) {
    suspend fun getBatch(jobIds: List<String>): KioskDownloadResult<List<KioskDownloadItem>> {
        if (jobIds.isEmpty()) return KioskDownloadResult.Success(emptyList())
        return try {
            val response = apiService.getKioskDownloadBatch(jobIds.joinToString(","))
            val body = response.body()
            if (response.isSuccessful && body != null) {
                KioskDownloadResult.Success(body.items)
            } else {
                KioskDownloadResult.Failure(
                    response.errorBody()?.string() ?: "Unable to check downloads (${response.code()})"
                )
            }
        } catch (e: Exception) {
            KioskDownloadResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }
}
