package tryme.nice.interactive.data.session

import android.content.Context
import android.util.Base64
import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.data.repository.CatalogRepository
import tryme.nice.interactive.utils.CrashReporter
import org.json.JSONObject

/**
 * Process-wide session source. Preferences are private to the app; callers never
 * read or write token keys directly.
 */
object SessionManager {
    private const val PREFS_NAME = "ai_vastra_session"
    private const val ACCESS_TOKEN = "access_token"
    private const val REFRESH_TOKEN = "refresh_token"
    private const val USER_ID = "user_id"
    private const val USER_EMAIL = "user_email"
    private const val USER_NAME = "user_name"
    private const val USER_LOGO_URL = "user_logo_url"
    private const val EXPIRY_SKEW_SECONDS = 30L

    private lateinit var appContext: Context

    fun initialize(context: Context) {
        appContext = context.applicationContext
        ApiClient.setAccessToken(accessToken)
        CrashReporter.setUserId(userId)
    }

    private val preferences
        get() = if (::appContext.isInitialized) appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) else null

    val accessToken: String?
        get() = preferences?.getString(ACCESS_TOKEN, null)

    val refreshToken: String?
        get() = preferences?.getString(REFRESH_TOKEN, null)

    val userId: String?
        get() = preferences?.getString(USER_ID, null)

    val userEmail: String?
        get() = preferences?.getString(USER_EMAIL, null)

    val userName: String?
        get() = preferences?.getString(USER_NAME, null)

    val logoUrl: String?
        get() = preferences?.getString(USER_LOGO_URL, null)

    @JvmOverloads
    fun save(
        accessToken: String,
        refreshToken: String? = null,
        userId: String? = null,
        email: String? = null,
        userName: String? = null,
        logoUrl: String? = null
    ) {
        val prefs = preferences ?: return
        val editor = prefs.edit()
            .putString(ACCESS_TOKEN, accessToken)
        if (!refreshToken.isNullOrEmpty()) {
            editor.putString(REFRESH_TOKEN, refreshToken)
        }
        if (!userId.isNullOrEmpty()) {
            editor.putString(USER_ID, userId)
        }
        if (!email.isNullOrEmpty()) {
            editor.putString(USER_EMAIL, email)
        }
        if (!userName.isNullOrEmpty()) {
            editor.putString(USER_NAME, userName)
        }
        if (!logoUrl.isNullOrEmpty()) {
            editor.putString(USER_LOGO_URL, logoUrl)
        }
        editor.apply()
        ApiClient.setAccessToken(accessToken)
        CatalogRepository.clearCache()
        // Non-PII opaque id only — never the email — so crash reports can be
        // correlated with a user for support triage without logging PII to Crashlytics.
        CrashReporter.setUserId(userId ?: SessionManager.userId)
    }

    fun clear() {
        preferences?.edit()?.clear()?.apply()
        ApiClient.setAccessToken(null)
        CatalogRepository.clearCache()
        CrashReporter.setUserId(null)
    }

    fun hasValidSession(): Boolean {
        val token = accessToken
        val refresh = refreshToken
        return !token.isNullOrBlank() || !refresh.isNullOrBlank()
    }

    fun hasValidAccessToken(): Boolean {
        val token = accessToken ?: return false
        if (token.isBlank()) return false
        val expiry = tokenExpirySeconds(token) ?: return true
        return expiry > (System.currentTimeMillis() / 1000L) + EXPIRY_SKEW_SECONDS
    }

    private fun tokenExpirySeconds(token: String): Long? = runCatching {
        val payload = token.split('.')[1]
        val decoded = Base64.decode(
            payload,
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
        )
        JSONObject(String(decoded, Charsets.UTF_8)).getLong("exp")
    }.getOrNull()
}
