package tryme.nice.trymeadmin.viewmodels

import tryme.nice.trymeadmin.utils.PrefsManager
import tryme.nice.interactive.viewmodel.Login.UserSession
import com.example.facewixlatest.ApiUtils.APICaller
import com.example.facewixlatest.ApiUtils.APIConstant
import com.example.facewixlatest.ApiUtils.ApiException
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONObject

class DeviceLimitReachedException(
    message: String,
    val forceLogoutToken: String,
) : Exception(message)

object AuthRepository {
    private val mapper = ObjectMapper()

    suspend fun deviceLogin(email: String, password: String, deviceId: String): UserSession {
        val body = JSONObject().apply {
            put("email", email)
            put("password", password)
            put("deviceId", deviceId)
            put("platform", "mobile")
        }.toString()
        val response = try {
            APICaller.postJson(APIConstant.API_ENDPOINTS.DEVICE_LOGIN, body)
        } catch (e: ApiException.BackendError) {
            throw deviceLimitExceptionOrRethrow(e)
        }
        return mapper.readValue(response, UserSession::class.java)
    }

    suspend fun forceDeviceLogin(forceLogoutToken: String, deviceId: String): UserSession {
        val body = JSONObject().apply {
            put("forceLogoutToken", forceLogoutToken)
            put("deviceId", deviceId)
            put("platform", "mobile")
        }.toString()
        val response = APICaller.postJson(APIConstant.API_ENDPOINTS.DEVICE_LOGIN_FORCE, body)
        return mapper.readValue(response, UserSession::class.java)
    }

    /** DEVICE_LIMIT_REACHED carries a forceLogoutToken the caller needs to confirm-and-retry. */
    private fun deviceLimitExceptionOrRethrow(e: ApiException.BackendError): Throwable {
        if (e.code != "DEVICE_LIMIT_REACHED") return e
        val token = try {
            JSONObject(e.rawBody).getJSONObject("error").optString("forceLogoutToken", "")
        } catch (_: Exception) {
            ""
        }
        return if (token.isNotBlank()) DeviceLimitReachedException(e.backendMessage, token) else e
    }

    suspend fun deviceLogout() {
        val refreshToken = PrefsManager.getRefreshToken()
        if (refreshToken.isBlank()) return
        val body = JSONObject().apply {
            put("refreshToken", refreshToken)
        }.toString()
        APICaller.postJson(APIConstant.API_ENDPOINTS.DEVICE_LOGOUT, body)
    }

    /** Maps a caught ApiException to a user-facing message. */
    fun errorMessage(e: Throwable): String = when (e) {
        is ApiException.BackendError -> e.backendMessage
        is ApiException.NetworkError -> APIConstant.serverTimeOut
        is ApiException.ClientError -> e.message ?: APIConstant.errorSomethingWrong
        else -> APIConstant.errorSomethingWrong
    }
}