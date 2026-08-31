package tryme.nice.interactive.data.repository

import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.TryOnJobRequest
import tryme.nice.interactive.data.models.TryOnStatusResponse
import tryme.nice.interactive.utils.ErrorParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.IOException

sealed interface TryOnResult<out T> {
    data class Success<T>(val data: T) : TryOnResult<T>
    data class Failure(val message: String) : TryOnResult<Nothing>
}

private const val CREATE_JOB_NETWORK_RETRY_ATTEMPTS = 3
private const val CREATE_JOB_NETWORK_RETRY_DELAY_MS = 800L

class TryOnRepository(
    private val apiService: ApiService = ApiClient.apiService
) {
    /**
     * A transient DNS/connectivity blip right as the "Generating..." screen fires this
     * off (e.g. UnknownHostException) shouldn't surface "Try-On Failed" immediately -
     * unlike checkJobStatus, which is naturally retried by pollJobStatus's polling loop,
     * this is a single one-shot call, so it gets its own short retry here.
     */
    suspend fun createTryOnJob(
        garmentId: String,
        customerPhotoKey: String
    ): TryOnResult<String> = withContext(Dispatchers.IO) {
        var lastNetworkError: IOException? = null
        repeat(CREATE_JOB_NETWORK_RETRY_ATTEMPTS) { attempt ->
            try {
                val response = apiService.createTryOnJob(
                    TryOnJobRequest(
                        merchantCatalogItemId = garmentId,
                        customerPhotoKey = customerPhotoKey
                    )
                )
                val body = response.body()
                return@withContext if (response.isSuccessful && body != null) {
                    TryOnResult.Success(body.jobId)
                } else {
                    TryOnResult.Failure(ErrorParser.parseErrorMessage(response, "Failed to create try-on job"))
                }
            } catch (e: IOException) {
                lastNetworkError = e
                if (attempt < CREATE_JOB_NETWORK_RETRY_ATTEMPTS - 1) {
                    delay(CREATE_JOB_NETWORK_RETRY_DELAY_MS)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return@withContext TryOnResult.Failure(e.message ?: "Network error creating try-on job")
            }
        }
        TryOnResult.Failure(lastNetworkError?.message ?: "Network error creating try-on job")
    }

    suspend fun checkJobStatus(jobId: String): TryOnResult<TryOnStatusResponse> = withContext(Dispatchers.IO) {
        try {
            val response = apiService.getTryOnJobStatus(jobId)
            val body = response.body()
            if (response.isSuccessful && body != null) {
                TryOnResult.Success(body)
            } else {
                TryOnResult.Failure(ErrorParser.parseErrorMessage(response, "Failed to check status"))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            TryOnResult.Failure(e.message ?: "Network error checking job status")
        }
    }

    suspend fun deleteJob(jobId: String): TryOnResult<Unit> = withContext(Dispatchers.IO) {
        try {
            val response = apiService.deleteTryOnJob(jobId)
            if (response.isSuccessful) {
                TryOnResult.Success(Unit)
            } else {
                TryOnResult.Failure(ErrorParser.parseErrorMessage(response, "Failed to delete job"))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            TryOnResult.Failure(e.message ?: "Network error deleting job")
        }
    }
}
