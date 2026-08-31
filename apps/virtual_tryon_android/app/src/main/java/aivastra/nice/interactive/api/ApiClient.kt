package tryme.nice.interactive.api

import tryme.nice.interactive.BuildConfig
import tryme.nice.interactive.data.models.RefreshTokenRequest
import tryme.nice.interactive.data.session.SessionManager
import tryme.nice.interactive.utils.CrashReporter
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Singleton client for Retrofit networking setup.
 * Includes automatic 401 token refresh interceptor & authenticator.
 */
object ApiClient {
    private const val BASE_URL = "https://app.tryme.com/"

    @Volatile
    private var tokenOverride: String? = null

    fun setAccessToken(token: String?) {
        tokenOverride = token
    }

    // Full BODY logging is expensive per request (serializes every request/response) and was
    // previously always on, even in release — kiosks running the shipped build were paying that
    // cost on every API call for no benefit, plus logging full bodies (tokens, personal data) in
    // production logs is also unnecessary exposure.
    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY else HttpLoggingInterceptor.Level.NONE
    }

    // Unauthenticated HTTP client for Auth endpoints (login, refresh, logout).
    // MUST NOT attach Authorization headers to prevent token refresh deadlock or server rejection!
    private val rawOkHttpClient = OkHttpClient.Builder()
        .addInterceptor(loggingInterceptor)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val rawRetrofit: Retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(rawOkHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val authApiService: ApiService = rawRetrofit.create(ApiService::class.java)

    // Serialized lock for token refresh pattern
    private val refreshLock = Any()

    // Single-flight refresh, shared by the request interceptor (proactive — before a request
    // that already has a dead/missing access token goes out) and the Authenticator (reactive —
    // when a request 401s despite looking valid locally, e.g. server-side revocation). Without
    // the proactive path, any request made while the access token was merely expired or never
    // set went out with no Authorization header at all and failed with "missing bearer" before
    // ever getting a chance to refresh.
    private fun refreshAccessTokenBlocking(): String? = synchronized(refreshLock) {
        if (SessionManager.hasValidAccessToken()) {
            return@synchronized SessionManager.accessToken
        }

        val currentRefreshToken = SessionManager.refreshToken
        if (currentRefreshToken.isNullOrBlank()) {
            SessionManager.clear()
            return@synchronized null
        }

        try {
            val refreshResponse = runBlocking {
                authApiService.refreshToken(RefreshTokenRequest(currentRefreshToken, "kiosk"))
            }

            if (refreshResponse.isSuccessful) {
                val body = refreshResponse.body()
                val newAccessToken = body?.accessToken
                if (!newAccessToken.isNullOrBlank()) {
                    val newRefreshToken = body.refreshToken?.takeIf { it.isNotBlank() } ?: currentRefreshToken
                    SessionManager.save(newAccessToken, newRefreshToken)
                    setAccessToken(newAccessToken)
                    return@synchronized newAccessToken
                }
            }

            // If refresh token explicitly expired or invalid (400, 401, 403), clear session
            if (refreshResponse.code() in listOf(400, 401, 403)) {
                SessionManager.clear()
            }
        } catch (e: Exception) {
            CrashReporter.recordException(e, "ApiClient")
        }

        null
    }

    private val tokenAuthenticator = Authenticator { _, response ->
        if (response.responseCount > 1) {
            // Prevent infinite loop if retried request also returns 401
            return@Authenticator null
        }

        val failedRequestToken = response.request.header("Authorization")?.removePrefix("Bearer ")
        val newAccessToken = refreshAccessTokenBlocking()
        if (newAccessToken.isNullOrBlank() || newAccessToken == failedRequestToken) {
            // Either refresh failed outright, or it just handed back the same token that
            // already 401'd (server-side revocation) — retrying would only loop.
            null
        } else {
            response.request.newBuilder()
                .header("Authorization", "Bearer $newAccessToken")
                .build()
        }
    }

    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor { chain ->
            try {
                if (!SessionManager.hasValidAccessToken() && !SessionManager.refreshToken.isNullOrBlank()) {
                    refreshAccessTokenBlocking()
                }
            } catch (_: Exception) {}
            val activeToken = SessionManager.accessToken ?: tokenOverride
            val request = chain.request().newBuilder().apply {
                activeToken?.takeIf { it.isNotBlank() }?.let {
                    header("Authorization", "Bearer $it")
                }
            }.build()
            chain.proceed(request)
        }
        .authenticator(tokenAuthenticator)
        .addInterceptor(loggingInterceptor)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val retrofit: Retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val apiService: ApiService = retrofit.create(ApiService::class.java)
}

private val Response.responseCount: Int
    get() {
        var count = 1
        var prior = priorResponse
        while (prior != null) {
            count++
            prior = prior.priorResponse
        }
        return count
    }
