package tryme.nice.interactive.data.repository

import com.google.gson.Gson
import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.data.models.DeviceLoginRequest
import tryme.nice.interactive.data.models.DeviceLoginResponse
import tryme.nice.interactive.data.models.DeviceLimitErrorResponse
import tryme.nice.interactive.data.models.ForceLoginRequest
import tryme.nice.interactive.data.models.GoogleLoginRequest
import tryme.nice.interactive.data.models.LogoutRequest
import tryme.nice.interactive.data.models.LogoutResponse
import tryme.nice.interactive.data.models.RefreshTokenRequest
import tryme.nice.interactive.data.models.RefreshTokenResponse
import tryme.nice.interactive.data.session.SessionManager

import tryme.nice.interactive.utils.ErrorParser

/**
 * Sealed result type for clean error boundary at the repository layer.
 */
sealed class AuthResult<out T> {
    data class Success<T>(val data: T) : AuthResult<T>()
    data class DeviceLimitReached(val error: DeviceLimitErrorResponse) : AuthResult<Nothing>()
    data class Failure(val message: String) : AuthResult<Nothing>()
}

/**
 * Repository that acts as the single source of truth for all auth network calls.
 * Uses ApiClient.authApiService for unauthenticated auth endpoints (login, refresh, logout)
 * to prevent token header conflicts and deadlock.
 */
class UserRepository {

    private val gson = Gson()

    suspend fun loginDevice(request: DeviceLoginRequest): AuthResult<DeviceLoginResponse> {
        return try {
            val response = ApiClient.authApiService.loginDevice(request)
            when {
                response.isSuccessful -> {
                    val body = response.body()
                    if (body != null) AuthResult.Success(body)
                    else AuthResult.Failure("Empty response body")
                }
                response.code() == 409 -> {
                    val errJson = response.errorBody()?.string()
                    val limitError = gson.fromJson(errJson, DeviceLimitErrorResponse::class.java)
                    if (limitError?.error?.code == "DEVICE_LIMIT_REACHED") {
                        AuthResult.DeviceLimitReached(limitError)
                    } else {
                        AuthResult.Failure(ErrorParser.parseErrorMessage(response, "Login conflict"))
                    }
                }
                else -> {
                    AuthResult.Failure(ErrorParser.parseErrorMessage(response, "Login failed. Please check your credentials."))
                }
            }
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }

    suspend fun loginGoogle(request: GoogleLoginRequest): AuthResult<DeviceLoginResponse> {
        return try {
            val response = ApiClient.authApiService.loginGoogle(request)
            when {
                response.isSuccessful -> {
                    val body = response.body()
                    if (body != null) AuthResult.Success(body)
                    else AuthResult.Failure("Empty response body")
                }
                response.code() == 409 -> {
                    val errJson = response.errorBody()?.string()
                    val limitError = gson.fromJson(errJson, DeviceLimitErrorResponse::class.java)
                    if (limitError?.error?.code == "DEVICE_LIMIT_REACHED") {
                        AuthResult.DeviceLimitReached(limitError)
                    } else {
                        AuthResult.Failure(ErrorParser.parseErrorMessage(response, "Login conflict"))
                    }
                }
                else -> {
                    AuthResult.Failure(ErrorParser.parseErrorMessage(response, "Google login failed."))
                }
            }
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }

    suspend fun forceLogin(request: ForceLoginRequest): AuthResult<DeviceLoginResponse> {
        return try {
            val response = ApiClient.authApiService.forceLogin(request)
            if (response.isSuccessful) {
                val body = response.body()
                if (body != null) AuthResult.Success(body)
                else AuthResult.Failure("Empty response body")
            } else {
                AuthResult.Failure(ErrorParser.parseErrorMessage(response, "Force login failed."))
            }
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }

    suspend fun refreshToken(refreshToken: String, platform: String = "kiosk"): AuthResult<RefreshTokenResponse> {
        return try {
            val response = ApiClient.authApiService.refreshToken(RefreshTokenRequest(refreshToken, platform))
            if (response.isSuccessful) {
                val body = response.body()
                if (body != null) AuthResult.Success(body)
                else AuthResult.Failure("Empty response body")
            } else {
                AuthResult.Failure(ErrorParser.parseErrorMessage(response, "Session refresh failed."))
            }
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }

    suspend fun logoutDevice(refreshToken: String): AuthResult<LogoutResponse> {
        return try {
            val response = ApiClient.authApiService.logoutDevice(LogoutRequest(refreshToken))
            if (response.isSuccessful) {
                val body = response.body()
                if (body != null) {
                    SessionManager.clear()
                    AuthResult.Success(body)
                }
                else AuthResult.Failure("Empty response body")
            } else {
                AuthResult.Failure(ErrorParser.parseErrorMessage(response, "Logout failed."))
            }
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }
}
