package tryme.nice.trymeadmin.utils

import tryme.nice.trymeadmin.app.MyAPP
import tryme.nice.interactive.viewmodel.Login.UserSession
import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import com.google.gson.Gson

object PrefsManager {
    private const val PREFS_NAME = "TryMeAdmin"
    private const val SECURE_PREFS_NAME = "TryMeAdminSecure"
    private const val KEY_USER_ID = "USER_ID"
    private const val CAPTURED_IMAGE = "captured_image"
    private const val KEY_SESSION = "SaveLoginUserDetails"
    private const val KEY_REFRESH_TOKEN = "REFRESH_TOKEN"

    private fun appPrefs(): SharedPreferences {
        return MyAPP.appContext!!.getSharedPreferences(getAppname(), Context.MODE_PRIVATE)
    }

    private fun securePrefs(): SharedPreferences {
        val context = MyAPP.appContext!!
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        return EncryptedSharedPreferences.create(
            SECURE_PREFS_NAME,
            masterKeyAlias,
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun deleteuser() {
        synchronized(this) {
            appPrefs().edit().clear().apply()
            securePrefs().edit().clear().apply()
        }
    }

    fun saveSession(session: UserSession) {
        synchronized(this) {
            val serialized = Gson().toJson(session)
            securePrefs().edit().putString(KEY_SESSION, serialized).apply()
        }
    }

    fun saveRefreshToken(refreshToken: String) {
        securePrefs().edit().putString(KEY_REFRESH_TOKEN, refreshToken).apply()
    }

    fun getRefreshToken(): String {
        return securePrefs().getString(KEY_REFRESH_TOKEN, "") ?: ""
    }

    fun getAccessToken(): String {
        return session.accessToken
    }

    fun updateAccessToken(accessToken: String) {
        saveSession(session.copy(accessToken = accessToken))
    }

    val session: UserSession
        get() {
            val sharedPreferences = securePrefs()
            if (sharedPreferences.contains(KEY_SESSION)) {
                return Gson().fromJson(sharedPreferences.getString(KEY_SESSION, ""), UserSession::class.java)
                    ?: UserSession()
            }
            return UserSession()
        }

    val isUserExist: Boolean
        get() = securePrefs().contains(KEY_SESSION)

    fun saveImageId(context: Context, userId: String) {
        val sharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        sharedPreferences.edit().putString(KEY_USER_ID, userId).apply()
    }

    fun saveCapturedImage(context: Context, filePath: String) {
        val sharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        sharedPreferences.edit().putString(CAPTURED_IMAGE, filePath).apply()
    }

    fun getCapturedImage(context: Context): String {
        val sharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return sharedPreferences.getString(CAPTURED_IMAGE, "") ?: ""
    }

    fun getImageID(context: Context): String {
        val sharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return sharedPreferences.getString(KEY_USER_ID, "") ?: ""
    }

    fun clearUserId(context: Context) {
        val sharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        sharedPreferences.edit().remove(KEY_USER_ID).apply()
    }

    fun putString(key: String, value: String) {
        synchronized(this) {
            checkForNullKey(key)
            checkForNullValue(value)
            appPrefs().edit().putString(key, value).apply()
        }
    }

    fun getInt(key: String, defaultvalue: Int): Int = appPrefs().getInt(key, defaultvalue)

    fun putInt(key: String, value: Int) {
        synchronized(this) { appPrefs().edit().putInt(key, value).apply() }
    }

    fun getFloat(key: String, defaultvalue: Float): Float = appPrefs().getFloat(key, defaultvalue)

    fun putFloat(key: String, value: Float) {
        synchronized(this) { appPrefs().edit().putFloat(key, value).apply() }
    }

    fun getAppname(): String = "FaceWix"

    fun getString(key: String, defaultvalue: String): String? = appPrefs().getString(key, defaultvalue)

    fun putBoolean(key: String, value: Boolean) {
        synchronized(this) {
            checkForNullKey(key)
            appPrefs().edit().putBoolean(key, value).apply()
        }
    }

    fun getBoolean(key: String): Boolean = appPrefs().getBoolean(key, false)

    fun getBooleanTrue(key: String): Boolean = appPrefs().getBoolean(key, true)

    fun checkForNullKey(key: String?) {
        if (key == null) throw NullPointerException()
    }

    fun checkForNullValue(value: String?) {
        if (value == null) throw NullPointerException()
    }
}