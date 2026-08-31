package com.example.facewixlatest.ApiUtils

/** Every network call exposes whether failure came from the server, network, or client. */
sealed class ApiException(message: String) : Exception(message) {
    class BackendError(val code: String, val backendMessage: String, val httpStatus: Int, val rawBody: String = "") :
        ApiException(backendMessage)

    class NetworkError(cause: Throwable) : ApiException(cause.message ?: "Network error")

    class ClientError(message: String) : ApiException(message)

    /** The refresh token itself was explicitly rejected (expired/revoked/reused) — the local
     * session is already cleared by the time this is thrown. Distinct from a 401 that a token
     * refresh might still recover from, so callers can redirect to login instead of showing a
     * raw "invalid token" message that retrying can never fix. */
    class SessionExpired : ApiException("Your session has expired. Please log in again.")
}