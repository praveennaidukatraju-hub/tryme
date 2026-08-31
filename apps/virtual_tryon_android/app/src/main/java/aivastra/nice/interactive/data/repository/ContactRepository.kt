package tryme.nice.interactive.data.repository

import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.ContactRequest
import tryme.nice.interactive.data.session.SessionManager
import tryme.nice.interactive.utils.ErrorParser

sealed interface ContactResult {
    data object Success : ContactResult
    data class Failure(val message: String) : ContactResult
}

/**
 * Uses ApiClient.apiService (the authenticated client) — /v1/contact requires the
 * same Bearer token the catalog/merchant calls use, attached automatically.
 */
class ContactRepository(
    private val service: ApiService = ApiClient.apiService,
    private val onboardingRepository: OnboardingRepository = OnboardingRepository()
) {
    /**
     * name/message come from the form; email is read from the session, and phone is
     * pulled from the merchant's onboarding record (mandatory during onboarding, so every
     * logged-in user has one) since this form intentionally doesn't ask for it again.
     */
    suspend fun send(name: String, message: String): ContactResult {
        val email = SessionManager.userEmail
        if (email.isNullOrBlank()) {
            return ContactResult.Failure("Your session is missing an email address. Please sign in again.")
        }

        val phone = when (val status = onboardingRepository.getStatus()) {
            is OnboardingResult.Success -> status.data.prefill.phone.takeIf { it.isNotBlank() }
            is OnboardingResult.Failure -> null
        } ?: return ContactResult.Failure("Unable to load your account details. Please try again.")

        return try {
            val response = service.sendContactMessage(
                ContactRequest(name = name, email = email, phone = phone, message = message.ifBlank { null })
            )
            if (response.isSuccessful) {
                ContactResult.Success
            } else {
                ContactResult.Failure(ErrorParser.parseErrorMessage(response, "Unable to send your message (${response.code()})"))
            }
        } catch (e: Exception) {
            ContactResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }
}
