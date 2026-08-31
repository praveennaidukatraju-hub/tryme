package tryme.nice.interactive.data.repository

import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.MerchantOnboardingRequest
import tryme.nice.interactive.data.models.MerchantOnboardingResponse
import tryme.nice.interactive.data.models.OnboardingStatusResponse

sealed interface OnboardingResult<out T> {
    data class Success<T>(val data: T) : OnboardingResult<T>
    data class Failure(val message: String) : OnboardingResult<Nothing>
}

/**
 * Uses ApiClient.apiService (the authenticated client) — both endpoints are guarded
 * by requireDeviceUser, which reads the same Bearer token the catalog calls use.
 */
class OnboardingRepository(
    private val service: ApiService = ApiClient.apiService
) {
    suspend fun getStatus(): OnboardingResult<OnboardingStatusResponse> {
        return try {
            val response = service.getOnboardingStatus()
            val body = response.body()
            if (response.isSuccessful && body != null) {
                OnboardingResult.Success(body)
            } else {
                OnboardingResult.Failure(response.errorBody()?.string() ?: "Unable to load status (${response.code()})")
            }
        } catch (e: Exception) {
            OnboardingResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }

    suspend fun submit(request: MerchantOnboardingRequest): OnboardingResult<MerchantOnboardingResponse> {
        return try {
            val response = service.submitOnboarding(request)
            val body = response.body()
            if (response.isSuccessful && body != null) {
                OnboardingResult.Success(body)
            } else if (response.code() == 409) {
                OnboardingResult.Failure("This account is already registered as a merchant")
            } else {
                OnboardingResult.Failure(response.errorBody()?.string() ?: "Onboarding failed (${response.code()})")
            }
        } catch (e: Exception) {
            OnboardingResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }
}
