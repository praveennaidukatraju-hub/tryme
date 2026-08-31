# Saree Catalogue Android Backend Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/saree_catalogue_android`'s legacy backend connection (`api.tryme.com`, static shared-secret + api_key auth) with `apps/api`'s existing device-login auth and merchant catalog routes — a client-only rewrite against already-existing, unmodified backend endpoints.

**Architecture:** Coroutines-based `APICaller` (sealed `ApiException`, mutex-guarded refresh-on-401) mirrored from the sibling app `apps/virtual-tryon-mobile&kiosk_latest`, `EncryptedSharedPreferences` token storage, and a client-orchestrated generate→poll→import→patch sequence for product creation that mirrors `apps/catalogues-web`'s catalogue-manager. Full design rationale: `docs/superpowers/specs/2026-07-20-saree-catalogue-android-backend-cutover.md`.

**Tech Stack:** Kotlin, OkHttp, kotlinx.coroutines, androidx.security.crypto (EncryptedSharedPreferences), Gson, JUnit.

---

### Task 1: Gradle/build configuration

**Files:**
- Modify: `apps/saree_catalogue_android/gradle/libs.versions.toml`
- Modify: `apps/saree_catalogue_android/app/build.gradle.kts`
- Modify: `apps/saree_catalogue_android/gradle.properties`

- [ ] **Step 1: Add the security-crypto version + library entries to the version catalog**

In `apps/saree_catalogue_android/gradle/libs.versions.toml`, find the `[versions]` block and add:

```toml
securityCrypto = "1.0.0"
```

Find the `[libraries]` block and add:

```toml
androidx-security-crypto = { group = "androidx.security", name = "security-crypto", version.ref = "securityCrypto" }
```

- [ ] **Step 2: Add the security-crypto dependency to the app module**

In `apps/saree_catalogue_android/app/build.gradle.kts`, inside the existing `dependencies { ... }` block (after the last `implementation(libs.androidx.photoview)` line), add:

```kotlin
    implementation(libs.androidx.security.crypto)
```

- [ ] **Step 3: Wire `apiBaseUrl` through to `BuildConfig.API_BASE_URL`**

At the very top of `apps/saree_catalogue_android/app/build.gradle.kts`, before the `plugins { ... }` block, add:

```kotlin
val apiBaseUrl = (project.findProperty("apiBaseUrl") as String?) ?: ""
```

Inside the `android { defaultConfig { ... } }` block, after the existing `resConfigs("en")` line, add:

```kotlin
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
```

Find the existing `buildFeatures { compose = true }` block (around line 41) and the second `buildFeatures { viewBinding = true; dataBinding = true }` block (around line 52) — the project currently has two separate `buildFeatures` blocks, which is legal Kotlin DSL (they merge), so add `buildConfig = true` to the second one rather than creating a third block:

```kotlin
    buildFeatures {
        viewBinding = true
        dataBinding = true
        buildConfig = true
    }
```

- [ ] **Step 4: Set the production API base URL default**

In `apps/saree_catalogue_android/gradle.properties`, add a new line:

```properties
apiBaseUrl=https://app.tryme.com/
```

- [ ] **Step 5: Verify the Gradle sync picks up the new config**

Run (from `apps/saree_catalogue_android/`, using the wrapper workaround for this project's `&`-containing path — see Task 9 for why `gradlew.bat` doesn't work directly):

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin
```

Expected: build succeeds (it will regenerate `BuildConfig` with `API_BASE_URL = "https://app.tryme.com/"`; no Kotlin source yet references it, so this just proves the Gradle config itself is valid).

- [ ] **Step 6: Commit**

```bash
git add apps/saree_catalogue_android/gradle/libs.versions.toml apps/saree_catalogue_android/app/build.gradle.kts apps/saree_catalogue_android/gradle.properties
git commit -m "chore(saree-catalogue-android): wire API_BASE_URL build config + security-crypto dep"
```

---

### Task 2: Network core — `ApiException`, `APIConstant`, `APICaller`

**Files:**
- Create: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/ApiException.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APIConstant.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APICaller.kt`

This mirrors `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/APICaller.kt` almost verbatim, adapted to this app's package (`tryme.nice.trymeadmin`) and endpoint set. The sibling file uses `package com.example.facewixlatest.ApiUtils` for its `ApiUtils` classes (a historical quirk both apps share — the legacy `APIConstant.kt`/`APIInterface.kt` in this app already use that same package line) — keep that exact package declaration for consistency — every new repository this plan adds (`AuthRepository.kt` in Task 4, `MerchantCatalogRepository.kt` in Tasks 6-7) imports `com.example.facewixlatest.ApiUtils.APICaller`/`APIConstant` from this same package.

- [ ] **Step 1: Create `ApiException.kt`**

```kotlin
package com.example.facewixlatest.ApiUtils

/** Every network call exposes whether failure came from the server, network, or client. */
sealed class ApiException(message: String) : Exception(message) {
    class BackendError(val code: String, val backendMessage: String, val httpStatus: Int, val rawBody: String = "") :
        ApiException(backendMessage)

    class NetworkError(cause: Throwable) : ApiException(cause.message ?: "Network error")

    class ClientError(message: String) : ApiException(message)
}
```

- [ ] **Step 2: Replace `APIConstant.kt` with the new backend's endpoints**

Full replacement of `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APIConstant.kt`:

```kotlin
package com.example.facewixlatest.ApiUtils

import tryme.nice.trymeadmin.BuildConfig

object APIConstant {
    const val errorSomethingWrong = "Oops! Something went wrong. Please try again."
    const val fileNotSupported = "Selected file not supported. Please try another image."
    const val serverTimeOut = "Server time out"

    const val BASE_URL = BuildConfig.API_BASE_URL

    object API_ENDPOINTS {
        const val DEVICE_LOGIN = "v1/auth/device-login"
        const val DEVICE_REFRESH = "v1/auth/device-refresh"
        const val DEVICE_LOGOUT = "v1/auth/device-logout"

        const val MERCHANT_CATALOG_SUBCATEGORIES = "v1/merchant/catalog/subcategories"
        const val MERCHANT_CATALOG_ITEMS = "v1/merchant/catalog"
        const val MERCHANT_CATALOG_PRESIGN = "v1/merchant/catalog/presign"
        const val MERCHANT_CATALOG_GENERATE = "v1/merchant/catalog/generate"
        fun merchantCatalogGenerateStatus(jobId: String) = "v1/merchant/catalog/generate/$jobId"
        const val MERCHANT_CATALOG_IMPORT = "v1/merchant/catalog/import"
        fun merchantCatalogItem(id: String) = "v1/merchant/catalog/$id"
    }

    object Parameter {
        const val AUTHORIZATION = "Authorization"
    }
}
```

- [ ] **Step 3: Replace `APICaller.kt` with the coroutines-based client**

Full replacement of `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APICaller.kt`:

```kotlin
package com.example.facewixlatest.ApiUtils

import tryme.nice.trymeadmin.BuildConfig
import tryme.nice.trymeadmin.utils.PrefsManager
import android.annotation.SuppressLint
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

@SuppressLint("StaticFieldLeak")
object APICaller {
    private lateinit var context: Context
    private val jsonMediaType = "application/json".toMediaType()

    fun init(appContext: Context) {
        context = appContext.applicationContext
    }

    private val client: OkHttpClient by lazy {
        // BODY logs full request/response bodies AND the Authorization header to logcat —
        // only acceptable on debug builds. Release must never log tokens or payloads.
        val logging = HttpLoggingInterceptor().setLevel(
            if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY else HttpLoggingInterceptor.Level.NONE,
        )
        OkHttpClient.Builder()
            .addInterceptor(logging)
            .connectTimeout(120, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }

    // Content-Type is derived solely from the RequestBody's own media type below (null when
    // there's no real JSON payload) rather than a manual header — Fastify's default JSON
    // content-type parser rejects ANY request that declares Content-Type: application/json but
    // sends a zero-length body (FST_ERR_CTP_EMPTY_JSON_BODY, 400), which every GET/DELETE and
    // every empty-bodied PUT was triggering before this fix, since a manual header was being
    // attached unconditionally regardless of whether a body existed.
    private fun jsonBody(body: String) = body.toRequestBody(if (body.isNotEmpty()) jsonMediaType else null)

    suspend fun postJson(url: String, body: String): String {
        val request = Request.Builder()
            .url(resolveUrl(url))
            .post(jsonBody(body))
            .build()
        return execute(request)
    }

    suspend fun getJson(url: String): String {
        val request = Request.Builder().url(resolveUrl(url)).get().build()
        return execute(request)
    }

    suspend fun putJson(url: String, body: String = ""): String {
        val request = Request.Builder()
            .url(resolveUrl(url))
            .put(jsonBody(body))
            .build()
        return execute(request)
    }

    /** Raw PUT of arbitrary bytes to a presigned R2 URL — no Authorization header, no base-URL resolution. */
    suspend fun putToPresignedUrl(uploadUrl: String, body: RequestBody) {
        val request = Request.Builder().url(uploadUrl).put(body).build()
        withContext(Dispatchers.IO) {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ApiException.ClientError("Upload failed: HTTP ${response.code}")
                }
            }
        }
    }

    suspend fun postJsonAuthed(url: String, body: String, accessToken: String): String =
        executeAuthed(Request.Builder().post(jsonBody(body)), url, accessToken)

    suspend fun getJsonAuthed(url: String, accessToken: String): String =
        executeAuthed(Request.Builder().get(), url, accessToken)

    suspend fun patchJsonAuthed(url: String, body: String, accessToken: String): String =
        executeAuthed(Request.Builder().patch(jsonBody(body)), url, accessToken)

    private val refreshMutex = Mutex()

    private suspend fun executeAuthed(
        builder: Request.Builder,
        url: String,
        accessToken: String,
    ): String {
        val resolvedUrl = resolveUrl(url)
        val request = builder
            .url(resolvedUrl)
            .header(APIConstant.Parameter.AUTHORIZATION, "Bearer $accessToken")
            .build()
        return try {
            execute(request)
        } catch (e: ApiException.BackendError) {
            // The access token is short-lived; refresh once and retry the same request rather
            // than surfacing a 401 to the user for what's really a routine token expiry.
            if (e.httpStatus == 401 && refreshAccessToken()) {
                val retryRequest = builder
                    .url(resolvedUrl)
                    .header(APIConstant.Parameter.AUTHORIZATION, "Bearer ${PrefsManager.getAccessToken()}")
                    .build()
                execute(retryRequest)
            } else {
                throw e
            }
        }
    }

    private suspend fun refreshAccessToken(): Boolean = refreshMutex.withLock {
        val refreshToken = PrefsManager.getRefreshToken()
        if (refreshToken.isBlank()) return@withLock false
        try {
            val body = JSONObject().apply {
                put("refreshToken", refreshToken)
                put("platform", "mobile")
            }.toString()
            val request = Request.Builder()
                .url(resolveUrl(APIConstant.API_ENDPOINTS.DEVICE_REFRESH))
                .post(jsonBody(body))
                .build()
            val json = JSONObject(execute(request))
            val newAccessToken = json.optString("accessToken", "")
            if (newAccessToken.isBlank()) return@withLock false
            PrefsManager.updateAccessToken(newAccessToken)
            val newRefreshToken = json.optString("refreshToken", "")
            if (newRefreshToken.isNotBlank()) {
                PrefsManager.saveRefreshToken(newRefreshToken)
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { response ->
                val bodyString = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw parseBackendError(bodyString, response.code)
                }
                bodyString
            }
        } catch (e: ApiException) {
            throw e
        } catch (e: SocketTimeoutException) {
            throw ApiException.NetworkError(e)
        } catch (e: IOException) {
            throw ApiException.NetworkError(e)
        }
    }

    private fun parseBackendError(body: String, httpStatus: Int): ApiException.BackendError {
        return try {
            val error = JSONObject(body).getJSONObject("error")
            ApiException.BackendError(
                code = error.optString("code", "UNKNOWN"),
                backendMessage = error.optString("message", "HTTP $httpStatus"),
                httpStatus = httpStatus,
                rawBody = body,
            )
        } catch (_: Exception) {
            ApiException.BackendError(
                code = "HTTP_$httpStatus",
                backendMessage = body.ifBlank { "HTTP $httpStatus" },
                httpStatus = httpStatus,
                rawBody = body,
            )
        }
    }

    private fun resolveUrl(url: String): String {
        return if (url.startsWith("http://") || url.startsWith("https://")) url else baseURL() + url
    }

    fun baseURL(): String = APIConstant.BASE_URL
}
```

Note: `APICaller.init(context)` must be called once at app startup. Check `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/app/MyAPP.kt`'s `onCreate()` — if the sibling app's `MyAPP.kt` calls `APICaller.init(this)` there (check `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/app/MyAPP.kt`), add the same call to this app's `MyAPP.kt`. This `APICaller` doesn't currently use `context` for anything (no `NetworkInterceptor` per the design's explicit scope cut) — `init()`/`context` are kept only so future connectivity-check code has a plug point; if the sibling's `MyAPP.onCreate()` doesn't actually need it either, it's still cheap to keep for parity. Add the init call to this app's `MyAPP.onCreate()` regardless, since `PrefsManager` (Task 3) needs `MyAPP.appContext` set up the same way it already is in the current codebase (`MyAPP.appContext` already exists and is used by the current `PrefsManager.kt` — confirm this by reading `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/app/MyAPP.kt` before editing; do not duplicate `appContext` wiring if it's already there).

- [ ] **Step 4: Compile-check**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin
```

Expected: FAILS at this point, and the failure list is larger than just the missing `PrefsManager` methods — this Task 2 replacement is a **full replacement**, not additive, so it also removes every legacy endpoint constant (`APIConstant.API_ENDPOINTS.UPLOAD_USER_IMAGE`, `GET_TRYON_RESULT`, `APP_LOGIN`, `UPLOAD_CUSTOM_PRODUCT`, `GET_PRODUCT_CATEGORY`, `GET_UPLOADED_PRODUCT`, `GET_UPLOADED_PRODUCT_CATEGORY`, `GET_SAREE_PALLU_TYPE`, `FILTER_PRODUCT_LIST`, `VERIFY_USER`, `LOGOUT_USER`, every `Parameter.*` except `AUTHORIZATION`, `KeyParameter.*`) and every legacy callback-based `APICaller` method (`postRequest`, `postMultipartRequest`, `postMultipleMultipartRequest`, `getRequest`, `getRequestWithJSONARRAY`, and the `APICallBack`/`APICallBackWithError` interfaces). `ProductUploadDataRepository.kt` (every function) and `ProductUploadViewModel.kt` (its login/catalog/upload functions) reference these directly and will fail to compile as a result — on top of the `PrefsManager.getAccessToken()`/`getRefreshToken()`/`updateAccessToken()`/`saveRefreshToken()` failures. **All of this is expected and correct at this point in the plan** — `ProductUploadDataRepository.kt` is deleted in Task 5, and every function in `ProductUploadViewModel.kt` that references the removed constants/methods is deleted in Task 5 and replaced in Tasks 6-7. Do not add compatibility shims, deprecated aliases, or partial legacy support back into `APIConstant`/`APICaller` to make this checkpoint pass cleanly — that would contradict this task's "full replacement" design and add abstraction the plan never asked for. Confirm the failures are confined to the expected files and proceed to Task 3 regardless of how large the error list looks:

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin 2>&1 | grep "e: file" | sort -u
```

Expected file list at this checkpoint: only `ApiUtils/ApiException.kt`/`APIConstant.kt`/`APICaller.kt` (the files this task just replaced — these should NOT error, since they're the source of truth now), `ProductUploadDataRepository.kt`, and `ProductUploadViewModel.kt`. If any other file errors, stop and investigate before proceeding — that would indicate a caller this plan didn't account for.

- [ ] **Step 5: Commit**

```bash
git add apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/
git commit -m "feat(saree-catalogue-android): rewrite network core against apps/api (coroutines, sealed ApiException)"
```

---

### Task 3: `PrefsManager` — encrypted token storage + session model

**Files:**
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/utils/PrefsManager.kt`
- Create: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/Login/UserSession.kt`
- Delete: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/Login/UserLoginDataModel.kt` (superseded by `UserSession.kt` — legacy fields like `apiKey`-as-bearer-token, `business_id`, `merchant_photo` have no backend equivalent; see Task 4 for the auth-screen reference cleanup and Task 5 for the remaining `ProductUploadDataRepository`/`ProductUploadViewModel` reference cleanup)

- [ ] **Step 1: Create the new session model**

`deviceLoginUserPayload()` (`apps/api/src/modules/auth/routes.ts:258`) returns `{id, email, displayName, tier, maxActiveDevices}`. Create `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/Login/UserSession.kt`:

```kotlin
package tryme.nice.interactive.viewmodel.Login

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import java.io.Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class DeviceLoginUser(
    @JsonProperty("id") val id: String = "",
    @JsonProperty("email") val email: String = "",
    @JsonProperty("displayName") val displayName: String? = null,
    @JsonProperty("tier") val tier: String = "",
    @JsonProperty("maxActiveDevices") val maxActiveDevices: Int = 0,
) : Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class UserSession(
    @JsonProperty("accessToken") val accessToken: String = "",
    @JsonProperty("refreshToken") val refreshToken: String = "",
    @JsonProperty("user") val user: DeviceLoginUser = DeviceLoginUser(),
) : Serializable
```

(Package kept as `tryme.nice.interactive.viewmodel.Login` to match the existing import path used throughout this module — e.g. `ProductUploadViewModel.kt`'s `import tryme.nice.interactive.viewmodel.Login.UserLoginDataModel` becomes `import tryme.nice.interactive.viewmodel.Login.UserSession` in Task 4, same package, no new import root.)

- [ ] **Step 2: Delete the legacy login model**

```bash
rm apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/Login/UserLoginDataModel.kt
```

- [ ] **Step 3: Rewrite `PrefsManager.kt`**

Full replacement of `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/utils/PrefsManager.kt` — preserves every existing non-auth helper (`saveCapturedImage`/`getCapturedImage`, `saveCustomSareeResultData`/`getCustomSareeTryOnResultData`, `saveImageId`/`getImageID`/`clearUserId`, generic `putString`/`getInt`/`putInt`/`getFloat`/`putFloat`/`getString`/`putBoolean`/`getBoolean`/`getBooleanTrue`) on `appPrefs()` unchanged; adds `securePrefs()` for the session blob + refresh token:

```kotlin
package tryme.nice.trymeadmin.utils

import tryme.nice.trymeadmin.app.MyAPP
import tryme.nice.trymeadmin.viewmodels.VastraTryOnResultModel
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

    fun saveCustomSareeResultData(user: VastraTryOnResultModel) {
        synchronized(this) {
            appPrefs().edit().putString("saveCustomSareeResultData", Gson().toJson(user)).apply()
        }
    }

    val getCustomSareeTryOnResultData: VastraTryOnResultModel
        get() {
            val sharedPreferences = appPrefs()
            if (sharedPreferences.contains("saveCustomSareeResultData")) {
                return Gson().fromJson(
                    sharedPreferences.getString("saveCustomSareeResultData", ""),
                    VastraTryOnResultModel::class.java,
                )
            }
            return VastraTryOnResultModel()
        }

    fun checkForNullKey(key: String?) {
        if (key == null) throw NullPointerException()
    }

    fun checkForNullValue(value: String?) {
        if (value == null) throw NullPointerException()
    }
}
```

Note what was dropped versus the legacy version: `saveLoginUserData(UserLoginDataModel)`/`loginUserInfo` (replaced by `saveSession(UserSession)`/`session`, on `securePrefs()` instead of plaintext `appPrefs()`).

- [ ] **Step 4: Compile-check**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin
```

Expected: still FAILS — every call site that referenced `PrefsManager.loginUserInfo`/`saveLoginUserData`/`UserLoginDataModel` (Login/Profile/Splash activities, `ProductUploadViewModel`, `ProductUploadDataRepository`, `VastraProductCategoryFragment`, `UploadVastraFragment`) is now broken, on top of the Task 2 failures already present. This is expected — Task 4 fixes the auth-screen call sites; Task 5 deletes the rest; Tasks 6-7 rebuild them. Confirm the failures are all in those known files and nowhere else:

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin 2>&1 | grep "e: file" | sort -u
```

- [ ] **Step 5: Commit**

```bash
git add apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/utils/PrefsManager.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/Login/
git commit -m "feat(saree-catalogue-android): encrypt session/token storage, replace UserLoginDataModel with UserSession"
```

---

### Task 4: Auth repository + Login/Splash/Profile screen wiring

**Files:**
- Create: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/AuthRepository.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/activity/LoginActivity.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/activity/ProfileActivity.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/activity/SplashScreenActivity.kt`

- [ ] **Step 1: Create `AuthRepository.kt`**

```kotlin
package tryme.nice.trymeadmin.viewmodels

import tryme.nice.trymeadmin.utils.PrefsManager
import tryme.nice.interactive.viewmodel.Login.UserSession
import com.example.facewixlatest.ApiUtils.APICaller
import com.example.facewixlatest.ApiUtils.APIConstant
import com.example.facewixlatest.ApiUtils.ApiException
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONObject

object AuthRepository {
    private val mapper = ObjectMapper()

    suspend fun deviceLogin(email: String, password: String, deviceId: String): UserSession {
        val body = JSONObject().apply {
            put("email", email)
            put("password", password)
            put("deviceId", deviceId)
            put("platform", "mobile")
        }.toString()
        val response = APICaller.postJson(APIConstant.API_ENDPOINTS.DEVICE_LOGIN, body)
        return mapper.readValue(response, UserSession::class.java)
    }

    // DeviceLogoutBody (apps/api/src/modules/auth/routes.ts:36) requires {refreshToken} —
    // the refresh token IS the credential here, not the (possibly already-expired) access
    // token, so this is an unauthenticated postJson, not postJsonAuthed. Mirrors the sibling
    // app's SareeCategoryDataRepository.logoutDevice() exactly.
    suspend fun deviceLogout() {
        val refreshToken = PrefsManager.getRefreshToken()
        if (refreshToken.isBlank()) return
        val body = JSONObject().apply {
            put("refreshToken", refreshToken)
        }.toString()
        APICaller.postJson(APIConstant.API_ENDPOINTS.DEVICE_LOGOUT, body)
    }

    /** Maps a caught ApiException to a user-facing message, including the DEVICE_LIMIT_REACHED case as a plain error (no override-device UI). */
    fun errorMessage(e: Throwable): String = when (e) {
        is ApiException.BackendError -> e.backendMessage
        is ApiException.NetworkError -> APIConstant.serverTimeOut
        is ApiException.ClientError -> e.message ?: APIConstant.errorSomethingWrong
        else -> APIConstant.errorSomethingWrong
    }
}
```

- [ ] **Step 2: Add login/logout functions to `ProductUploadViewModel`**

In `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt`, replace the imports at the top (remove `com.example.facewixlatest.ApiUtils.APICaller`/`APIConstant` usage tied to the old callback interfaces where no longer needed, keep `APIConstant` for error strings):

```kotlin
import tryme.nice.trymeadmin.utils.PrefsManager
import tryme.nice.interactive.viewmodel.Login.UserSession
import android.provider.Settings
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.facewixlatest.ApiUtils.APIConstant
import kotlinx.coroutines.launch
```

(Don't worry about fully cleaning up unused imports in this step — Task 5 replaces `ProductUploadViewModel.kt` wholesale shortly after and settles the import list there; leave anything still used by functions this step doesn't touch.)

Replace `userAppLoginAPI`/`userVerifyApi`/`userLogoutAPI` (lines 276-368 of the current file) with:

`deviceId` requires a `Context`, and a `ViewModel` shouldn't hold an `Activity` reference — so `deviceLogin` takes `deviceId` as a parameter from the caller, matching how the legacy `userAppLoginAPI(userName, password, deviceId)` was already called (`LoginActivity` already computes it via `Settings.Secure.ANDROID_ID` and passes it in — see Step 3 below):

```kotlin
    private val _sessionResult = MutableLiveData<UserSession?>()
    val sessionResult: LiveData<UserSession?> get() = _sessionResult

    fun deviceLogin(email: String, password: String, deviceId: String) {
        viewModelScope.launch {
            try {
                val session = AuthRepository.deviceLogin(email, password, deviceId)
                PrefsManager.saveSession(session)
                PrefsManager.saveRefreshToken(session.refreshToken)
                _sessionResult.postValue(session)
            } catch (e: Exception) {
                _error.postValue(AuthRepository.errorMessage(e))
            }
        }
    }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            try {
                // Must run before deleteuser() below — deviceLogout() reads the refresh
                // token out of PrefsManager, which deleteuser() clears.
                AuthRepository.deviceLogout()
            } catch (e: Exception) {
                // Best-effort — clear local session regardless of server-side logout success.
            }
            PrefsManager.deleteuser()
            onDone()
        }
    }

    fun resetSessionResult() {
        _sessionResult.postValue(null)
        _error.postValue(null)
    }
```

- [ ] **Step 3: Rewrite `LoginActivity.kt`'s login call**

In `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/activity/LoginActivity.kt`, replace `callAppLoginAPI()` (lines 58-80):

```kotlin
    private fun callAppLoginAPI(){
        val deviceId = Settings.Secure.getString(this.contentResolver, Settings.Secure.ANDROID_ID)
        val email = binding.etUsername.text.toString().trim()
        val password = binding.etPassword.text?.toString()?.trim() ?: ""
        LoaderManager.show(this,findViewById(android.R.id.content),false)
        productUploadViewModel.deviceLogin(email, password, deviceId)
        productUploadViewModel.sessionResult.observe(this, Observer { session->
            LoaderManager.remove(this)
            if(session!=null){
                gotoNextScreen()
            }
        })
        productUploadViewModel.error.observe(this, Observer { errorMsg->
            LoaderManager.remove(this)
            if(errorMsg!=null){
                productUploadViewModel.resetSessionResult()
                ViewControll.showSnackErrorMsg(this,errorMsg)
                resetObserver()
            }
        })
    }
```

Update `resetObserver()` (line 89-92) to match the renamed LiveData:

```kotlin
    private fun resetObserver(){
        productUploadViewModel.error.removeObservers(this)
        productUploadViewModel.sessionResult.removeObservers(this)
    }
```

The `checkValidation()` function's copy still says "Please enter username" — leave the copy as-is (out of scope: this is a label wording change, not a functional one; the field now holds an email address per `DeviceLoginBody`'s `z.string().email()` validation, but renaming the UI label is a cosmetic follow-up, not part of this cutover).

- [ ] **Step 4: Rewrite `ProfileActivity.kt`'s profile display + logout**

In `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/activity/ProfileActivity.kt`, replace the `initView()` body's profile-display block (lines 36-62) — drop `merchantPhoto`/`companyLogo` (no backend field for either, per spec's "Explicitly out of scope"):

```kotlin
        if(PrefsManager.isUserExist){
            val session = PrefsManager.session
            binding.txtUsername.text = session.user.displayName ?: session.user.email
            binding.txtEmail.text = session.user.email
        }
```

Replace `showLogoutAlertDialog()`'s body (lines 71-95):

```kotlin
    private fun showLogoutAlertDialog(){
        val showErrorAlertDialog = ShowErrorAlertDialog(ShowErrorAlertDialog.ImageSourceType.FromDrawbleRes(R.drawable.ic_profile_stylish),
            getString(R.string.logout),
            getString(R.string.alert_logout),
            getString(R.string.cancel),
            getString(R.string.logout)){

            LoaderManager.show(this,findViewById(android.R.id.content),false)
            productUploadViewmodel.logout {
                LoaderManager.remove(this)
                ViewControll.showMessage(this,"User logout successfully")
                val intent = Intent(this@ProfileActivity, LoginActivity::class.java)
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                startActivity(intent)
                overridePendingTransition(R.anim.fade_and_scale_in, R.anim.fade_and_scale_out)
            }
        }
        showErrorAlertDialog.show(supportFragmentManager, "ShowErrorAlertDialog")
    }
```

Remove the now-unused `import android.provider.Settings` and `import com.bumptech.glide.Glide` if no other Glide usage remains in this file (check before removing — this file had two `Glide.with(...)` calls, both removed above, so the import is now dead).

- [ ] **Step 5: Verify `SplashScreenActivity.kt` needs no change**

`PrefsManager.isUserExist` (line 30) now reads from `securePrefs()` instead of plaintext — no code change needed in this file, the gate still works identically. Confirm by re-reading the file after Task 3/4 changes; if `isUserExist` compiles and the file has no other `PrefsManager`/`UserLoginDataModel` references, skip editing it.

- [ ] **Step 6: Compile-check**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin 2>&1 | grep "e: file" | sort -u
```

Expected: remaining failures are only in `ProductUploadDataRepository.kt`, `VastraProductCategoryFragment.kt`, `UploadVastraFragment.kt`, `UploadPhotoDialog.kt` — Task 5 deletes the legacy repository and every remaining legacy-calling function out of `ProductUploadViewModel.kt`, which these three UI files depend on; Tasks 6-7 then rebuild them against the new backend. If `LoginActivity`, `ProfileActivity`, or `SplashScreenActivity` still error, fix those first before proceeding.

- [ ] **Step 7: Commit**

```bash
git add apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/AuthRepository.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/activity/LoginActivity.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/activity/ProfileActivity.kt
git commit -m "feat(saree-catalogue-android): device-login auth flow, profile screen against new session model"
```

---

### Task 5: Delete all remaining legacy backend-calling code

**Why this task exists (added after Task 4 landed):** the original plan replaced legacy code file-by-file, screen-by-screen (Tasks 5-7 each doing "add the new call + remove the now-dead old call" together). In practice that left `ProductUploadDataRepository.kt` sitting broken-and-uncommitted-as-dead-code from Task 2 all the way to the old Task 7, and produced two rounds of "is this compile failure expected or a new bug?" confusion (Task 2's expanded failure gate, then the `VastraSliderAdapter`/`SelectedVastraThemePreviewDialog` gap in the old Task 5). Ripping out every legacy backend call **first**, in one clean sweep, then rebuilding feature-by-feature against the new backend in Tasks 6-8, removes that ambiguity — after this task, every remaining compile error is straightforwardly "not wired up yet," not "wait, was this supposed to still work?" This does **not** avoid an intermediate non-compiling state (Kotlin is statically typed — deleting a function any caller depends on breaks that caller immediately, no matter what order you do it in); it just consolidates all of that breakage into one well-understood checkpoint instead of spreading confusion across three.

**Files:**
- Delete: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APIInterface.kt`
- Delete: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadDataRepository.kt`
- Delete: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/CommonResponseModel.kt`
- Delete: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/SearchEvent.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt`

`APIInterface.kt` (the Retrofit interface) has been fully orphaned since Task 2 — the new `APICaller` uses raw OkHttp directly and never referenced it. `ProductUploadDataRepository.kt` has been non-compiling since Task 2 (every function in it calls a callback-based `APICaller` method Task 2 deleted). Deleting both now doesn't create any new breakage — it was already guaranteed the moment Task 2 landed, this just stops carrying the broken file forward. `CommonResponseModel.kt` and `SearchEvent.kt` are legacy response models used only by `ProductUploadDataRepository.kt`/`ProductUploadViewModel.kt` (verified via `grep -rln` against the current tree — neither appears in any fragment/adapter/dialog file), so they're safe to delete now too. (`ProductCategoryDataModel.kt`, `VastraProductCategoryDataModel.kt`, `SareePalluTypeDataModel.kt`, `ProductSearchDataModel.kt`, and `VastraTryOnResultModel.kt` are **not** included here — they're still referenced by `VastraProductCategoryFragment.kt`/`UploadVastraFragment.kt`/adapters/`PrefsManager.kt`, which Tasks 6-8 rewire; Task 8 verifies and deletes whichever of those are dead by then.)

- [ ] **Step 1: Delete the four fully-orphaned files**

```bash
rm apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APIInterface.kt
rm apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadDataRepository.kt
rm apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/CommonResponseModel.kt
rm apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/SearchEvent.kt
```

- [ ] **Step 2: Strip every remaining legacy-calling function out of `ProductUploadViewModel.kt`**

Full replacement of `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt` — keeps only what Task 4 already wired against the new backend (`_error`/`error`, `_sessionResult`/`sessionResult`, `resetError()`, `deviceLogin()`, `logout()`, `resetSessionResult()`); deletes `val repository = ProductUploadDataRepository`, `maxTryOnPollAttempts`, every other `LiveData` field (`_uploadProductData`, `_addCustomProductData`, `_productCategoryDataList`, `searchResultEvent`, `_searchProductData`, `_allAddedProductCategoryData`, `_sareePalluTypeData`), `resetProductCatList()`, `resetAddCustomProductData()`, `resetPalluTypeList()`, `fetchSareeCategoryData()`, `fetchSareePalluTypeData()`, `fetchAllUploadedProductCategoryWiseData()`, `fetchCustomSareeTryOnAPI()`, `pollTryOnResult()`, `uploadCustomProductAPI()`, `filterProductBySKUNumber()`:

```kotlin
package tryme.nice.trymeadmin.viewmodels

import tryme.nice.trymeadmin.utils.PrefsManager
import tryme.nice.interactive.viewmodel.Login.UserSession
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch

class ProductUploadViewModel : ViewModel() {

    private val _error = MutableLiveData<String?>()
    val error: LiveData<String?> get() = _error

    private val _sessionResult = MutableLiveData<UserSession?>()
    val sessionResult: LiveData<UserSession?> get() = _sessionResult

    fun resetError() {
        _error.postValue(null)
    }

    fun deviceLogin(email: String, password: String, deviceId: String) {
        viewModelScope.launch {
            try {
                val session = AuthRepository.deviceLogin(email, password, deviceId)
                PrefsManager.saveSession(session)
                PrefsManager.saveRefreshToken(session.refreshToken)
                _sessionResult.postValue(session)
            } catch (e: Exception) {
                _error.postValue(AuthRepository.errorMessage(e))
            }
        }
    }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            try {
                AuthRepository.deviceLogout()
            } catch (e: Exception) {
                // Best-effort: clear the local session regardless of logout failure.
            }
            PrefsManager.deleteuser()
            onDone()
        }
    }

    fun resetSessionResult() {
        _sessionResult.postValue(null)
        _error.postValue(null)
    }
}
```

Note what this drops versus the file's current state: the `android.app.Activity`, `com.example.facewixlatest.ApiUtils.APICaller`, `com.example.facewixlatest.ApiUtils.APIConstant`, `kotlinx.coroutines.delay`, `okhttp3.MediaType.Companion.toMediaTypeOrNull`, `okhttp3.MultipartBody.Part.Companion.createFormData`, `okhttp3.RequestBody`, `okhttp3.RequestBody.Companion.asRequestBody`, and `java.io.File` imports are all gone too — none of the kept functions need them. Task 7 re-adds `APIConstant` (for `APIConstant.serverTimeOut`/`errorSomethingWrong` in the generate orchestration function) — don't add it back here, it would be an unused-import warning until then.

- [ ] **Step 3: Compile-check — confirm the failure surface is exactly the three UI files, nothing else**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin 2>&1 | grep "e: file" | sort -u
```

Expected: failures now confined to `VastraProductCategoryFragment.kt`, `UploadVastraFragment.kt`, `UploadPhotoDialog.kt` (calling `ProductUploadViewModel` functions that no longer exist) and whatever adapters/dialogs those three transitively touch (`ProductSubCategoryAdapter.kt`, `ProductCategoryItemAdapter.kt`, `VastraSliderAdapter.kt`, `SelectedVastraThemePreviewDialog.kt` — these still reference `VastraProductCategoryDataModel`, untouched by this task). **This is expected and is exactly what Tasks 6-8 fix.** If `AuthRepository.kt`, `LoginActivity.kt`, `ProfileActivity.kt`, `SplashScreenActivity.kt`, `PrefsManager.kt`, or anything under `ApiUtils/` shows an error, stop — Task 4/2/3 regressed, fix that before proceeding.

- [ ] **Step 4: Commit**

`APIInterface.kt`, `ProductUploadDataRepository.kt`, `CommonResponseModel.kt`, and `SearchEvent.kt` were never committed to git in the first place — only the specific files each of Tasks 1-4 touched were ever `git add`ed (confirm with `git status --porcelain apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APIInterface.kt`, which should show nothing once deleted, not a staged `D`). `rm`-ing them is a pure filesystem operation with nothing for git to record — do **not** pass their paths to `git add`, it will fail with `fatal: pathspec '...' did not match any files` (exit 128) since there's no tracked history to delete. Only `ProductUploadViewModel.kt` is a real, tracked change:

```bash
git add apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt
git commit -m "chore(saree-catalogue-android): delete legacy repository, Retrofit interface, and dead ViewModel functions"
```

---

### Task 6: Merchant catalog browse (subcategories + items + search)

**Files:**
- Create: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogModels.kt`
- Create: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogRepository.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/VastraProductCategoryFragment.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/dialog/SelectedVastraThemePreviewDialog.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/adapter/VastraSliderAdapter.kt`

The legacy screen has two nesting levels (category → subcategory → items); this app is saree-only so the new backend's single-level subcategory list becomes the fragment's top-level list (see spec's "Merchant catalog browse" section).

**Correction found during implementation:** the original version of this task described `SelectedVastraThemePreviewDialog`'s fix as a 2-parameter mechanical retarget. That was wrong — read in full, the dialog and `VastraSliderAdapter` both depend on `selectedVastraSubcat.items`, a nested item list that only existed on the legacy two-level model. `MerchantCatalogSubcategory` (Task 5 Step 1) has no `.items` field — items are fetched separately via `MerchantCatalogRepository.fetchItems(subcategoryId)`. The real fix needs a third parameter (the current items list, which the caller already has) and is spelled out in full below.

- [ ] **Step 1: Create response models**

```kotlin
package tryme.nice.trymeadmin.viewmodels

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import java.io.Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogSubcategory(
    @JsonProperty("id") val id: String = "",
    @JsonProperty("category") val category: String = "",
    @JsonProperty("name") val name: String = "",
    @JsonProperty("productCount") val productCount: Int = 0,
) : Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogSubcategoryListResponse(
    @JsonProperty("items") val items: List<MerchantCatalogSubcategory> = emptyList(),
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogItem(
    @JsonProperty("id") val id: String = "",
    @JsonProperty("subcategoryId") val subcategoryId: String = "",
    @JsonProperty("label") val label: String = "",
    @JsonProperty("sku") val sku: String? = null,
    @JsonProperty("actualPrice") val actualPrice: Int = 0,
    @JsonProperty("offerPrice") val offerPrice: Int = 0,
    @JsonProperty("imageUrl") val imageUrl: String? = null,
    @JsonProperty("thumbnailUrl") val thumbnailUrl: String? = null,
) : Serializable

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogListResponse(
    @JsonProperty("items") val items: List<MerchantCatalogItem> = emptyList(),
)
```

(`actualPrice`/`offerPrice` here are rupees, as returned by `serializeCatalogItem()` in `apps/api/src/modules/merchant/catalog.routes.ts` — that function does `Math.round(item.actualPricePaise / 100)` before serializing, so no paise-to-rupee conversion is needed client-side on reads; Task 7's write path converts the other direction.)

- [ ] **Step 2: Create `MerchantCatalogRepository.kt`**

```kotlin
package tryme.nice.trymeadmin.viewmodels

import tryme.nice.trymeadmin.utils.PrefsManager
import com.example.facewixlatest.ApiUtils.APICaller
import com.example.facewixlatest.ApiUtils.APIConstant
import com.fasterxml.jackson.databind.ObjectMapper

object MerchantCatalogRepository {
    private val mapper = ObjectMapper()

    suspend fun fetchSubcategories(category: String): List<MerchantCatalogSubcategory> {
        val url = "${APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_SUBCATEGORIES}?category=$category"
        val response = APICaller.getJsonAuthed(url, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogSubcategoryListResponse::class.java).items
    }

    suspend fun fetchItems(subcategoryId: String? = null, search: String? = null): List<MerchantCatalogItem> {
        val params = buildList {
            subcategoryId?.let { add("subcategoryId=$it") }
            search?.takeIf { it.isNotBlank() }?.let { add("search=${java.net.URLEncoder.encode(it, "UTF-8")}") }
        }
        val query = if (params.isEmpty()) "" else "?${params.joinToString("&")}"
        val url = "${APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_ITEMS}$query"
        val response = APICaller.getJsonAuthed(url, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogListResponse::class.java).items
    }
}
```

- [ ] **Step 3: Add browse functions to `ProductUploadViewModel`**

Task 5 already deleted the legacy `fetchSareeCategoryData`/`fetchSareePalluTypeData`/`fetchAllUploadedProductCategoryWiseData`/`filterProductBySKUNumber` and their backing `LiveData` — this step adds their replacements. Append to the class body:

```kotlin
    private val _subcategories = MutableLiveData<List<MerchantCatalogSubcategory>>()
    val subcategories: LiveData<List<MerchantCatalogSubcategory>> get() = _subcategories

    private val _catalogItems = MutableLiveData<List<MerchantCatalogItem>>()
    val catalogItems: LiveData<List<MerchantCatalogItem>> get() = _catalogItems

    fun fetchSubcategories(category: String = "women") {
        viewModelScope.launch {
            try {
                _subcategories.postValue(MerchantCatalogRepository.fetchSubcategories(category))
            } catch (e: Exception) {
                _error.postValue(AuthRepository.errorMessage(e))
            }
        }
    }

    fun fetchItems(subcategoryId: String) {
        viewModelScope.launch {
            try {
                _catalogItems.postValue(MerchantCatalogRepository.fetchItems(subcategoryId = subcategoryId))
            } catch (e: Exception) {
                _error.postValue(AuthRepository.errorMessage(e))
            }
        }
    }

    fun searchItems(query: String) {
        viewModelScope.launch {
            try {
                _catalogItems.postValue(MerchantCatalogRepository.fetchItems(search = query))
            } catch (e: Exception) {
                _error.postValue(AuthRepository.errorMessage(e))
            }
        }
    }

    fun resetSubcategories() {
        _subcategories.postValue(emptyList())
        _error.postValue(null)
    }
```

- [ ] **Step 4: Rewrite `VastraProductCategoryFragment.kt`'s data loading**

Replace `initView()`'s profile-image block (lines 66-82) — same `companyLogo` removal rationale as Task 4 Step 4:

```kotlin
    private fun initView() {
        productUploadViewmodel = ViewModelProvider(this).get(ProductUploadViewModel::class.java)
        getAllUploadedProductList()
        addProductSearchListener()
    }
```

Replace `getAllUploadedProductList()` (lines 87-128) — the old two-level (category → subcategory → items) rendering collapses to one level (subcategories → items), using `ProductSubCategoryAdapter` directly against `MerchantCatalogSubcategory` instead of `VastraProductCategoryDataModel.Data.Subcategory`. `ProductSubCategoryAdapter`'s constructor currently takes `List<VastraProductCategoryDataModel.Data.Subcategory>` with a `dressSubCatItemData.name`-style field access — check `apps/saree_catalogue_android/app/src/main/java/tryme/nice/interactive/activity/vastra/ProductSubCategoryAdapter.kt` before this step; if it only reads a `.name`/display-label field and an item click callback (no other `VastraProductCategoryDataModel`-specific fields), retarget its generic type to `MerchantCatalogSubcategory` (which also has a `.name` field) rather than writing a second adapter class:

```kotlin
    private fun getAllUploadedProductList(){
        LoaderManager.show(requireActivity(),requireActivity().findViewById(android.R.id.content),true)
        LoaderManager.setMessage("Fetching Products...")
        isFromSearchProduct = false
        productUploadViewmodel.fetchSubcategories("women")
        productUploadViewmodel.error.observe(viewLifecycleOwner){errorMsg->
            if(errorMsg!=null){
                LoaderManager.remove(requireActivity())
                binding.txtNoData.isVisible = true
            }
        }
        productUploadViewmodel.subcategories.observe(viewLifecycleOwner){subcategoryList->
            LoaderManager.remove(requireActivity())
            if(subcategoryList!=null && subcategoryList.isNotEmpty()){
                setupProductItemRecyclerviewAdapter()
                selectedSubcategory = subcategoryList[0]
                val subcatAdapter = ProductSubCategoryAdapter(subcategoryList){ selected, _ ->
                    selectedSubcategory = selected
                    loadItemsForSubcategory(selected.id)
                }
                binding.recyclerVastraCategory.adapter = subcatAdapter
                binding.rlMainCatlist.isVisible = true
                subcatAdapter.selectedItemPositionDefault(0)
                loadItemsForSubcategory(subcategoryList[0].id)
            } else {
                binding.txtNoData.isVisible = true
            }
        }
    }

    private fun loadItemsForSubcategory(subcategoryId: String) {
        productUploadViewmodel.fetchItems(subcategoryId)
        productUploadViewmodel.catalogItems.observe(viewLifecycleOwner) { items ->
            binding.recyclerVastraItem.isVisible = true
            binding.recyclerSearchProductItem.isVisible = false
            dressTypeSubcatAdapter.submitList(items) {
                binding.recyclerVastraItem.smoothScrollToPosition(0)
            }
        }
    }
```

Add the field `private lateinit var selectedSubcategory: MerchantCatalogSubcategory` near the top of the class (replacing `private lateinit var selectedCategoryData: VastraProductCategoryDataModel.Data.Subcategory`).

Update `setupProductItemRecyclerviewAdapter()` (lines 138-147) — `ProductCategoryItemAdapter`'s item type also needs to switch from `VastraProductCategoryDataModel.Data.Subcategory.Item` to `MerchantCatalogItem`; check `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/adapter/ProductCategoryItemAdapter.kt` for what fields it binds (likely an image URL + label) and retarget its generic type the same way as `ProductSubCategoryAdapter` above:

```kotlin
    private fun setupProductItemRecyclerviewAdapter(){
         dressTypeSubcatAdapter = ProductCategoryItemAdapter { selectedItem, _ ->
             openSelectedVastraPreviewDialog(selectedSubcategory, selectedItem)
        }
        binding.recyclerVastraItem.apply {
            adapter = dressTypeSubcatAdapter
            setHasFixedSize(true)
            itemAnimator = null
        }
    }
```

`openSelectedVastraPreviewDialog` feeds `SelectedVastraThemePreviewDialog`, which shows a swipeable slider over every item in the tapped subcategory via `VastraSliderAdapter`. Both files currently key off `selectedVastraSubcat.items` — the nested item list on the legacy two-level model — which has no equivalent on `MerchantCatalogSubcategory`. Fix by threading the caller's already-fetched items list through as an explicit third parameter, and swap the legacy `.fullpath` identity check for `.id` (a stable UUID — a strictly better identity comparison than string path equality, not just a mechanical rename).

**`VastraSliderAdapter.kt`** — change the constructor's `images` parameter type and the field reads used in `onBindViewHolder`:

```kotlin
class VastraSliderAdapter(
    private val context: Activity,
    private val images: List<tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem>
) : RecyclerView.Adapter<VastraSliderAdapter.Holder>() {
```

Replace the import `tryme.nice.trymeadmin.viewmodels.VastraProductCategoryDataModel` with `tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem`. In `onBindViewHolder`, replace the body:

```kotlin
    override fun onBindViewHolder(holder: Holder, position: Int) {
        Glide.with(context)
            .load(images[position].imageUrl)
            .thumbnail(0.1f)
            .diskCacheStrategy(DiskCacheStrategy.ALL)
            .skipMemoryCache(false)
            .placeholder(ViewControll.setLoaderDrawble(context))
            .dontAnimate()
            .into(holder.image)
        holder.txtSkuNumber.text = "SKU No : ${images[position].sku ?: ""}"
        holder.txtOfferPrice.text = "Price : ₹${images[position].offerPrice}"
        holder.txtPrice.text = "₹${images[position].actualPrice}"
        holder.txtPrice.paintFlags = holder.txtPrice.paintFlags or Paint.STRIKE_THRU_TEXT_FLAG
    }
```

`images[position].preview` was a relative path prefixed with `APIConstant.BASE_URL + ...`; `MerchantCatalogItem.imageUrl` is already an absolute presigned URL (`serializeCatalogItem()` in `apps/api/src/modules/merchant/catalog.routes.ts`), so the concatenation is dropped, not just renamed. Remove the now-unused `import com.example.facewixlatest.ApiUtils.APIConstant`.

**`SelectedVastraThemePreviewDialog.kt`** — three constructor parameters instead of two, plus every `selectedVastraSubcat.items` reference becomes the new `items` parameter, and the `.fullpath` equality check becomes `.id`:

```kotlin
class SelectedVastraThemePreviewDialog(
    private val selectedVastraSubcat: tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory,
    private val items: List<tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem>,
    private val selectedVastraItem: tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem,
    private val dismissCallback: (tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem) -> Unit,
) : BottomSheetDialogFragment() {
```

Replace the import `tryme.nice.trymeadmin.viewmodels.VastraProductCategoryDataModel` with `MerchantCatalogSubcategory`/`MerchantCatalogItem`. Every occurrence of `selectedVastraSubcat.items` in the file (`autoScrollRunnable`, `initView`, the page-change callback, `updateUIForPosition`) becomes `items`. In `initView`, replace the `VastraSliderAdapter` construction and the initial-scroll-position lookup:

```kotlin
        binding.viewpagerSlider.adapter = VastraSliderAdapter(requireActivity(), items)
        binding.viewpagerSlider.post {
            items.forEachIndexed { index, item ->
                if (item.id == selectedVastraItem.id) {
                    binding.viewpagerSlider.setCurrentItem(index, true)
                }
            }
        }
```

Leave the rest of the file (ViewPager2 auto-scroll timer, bottom-sheet presentation) untouched — it's presentation-only and doesn't touch the network layer.

**`VastraProductCategoryFragment.kt`'s `openSelectedVastraPreviewDialog`** (line 251) and both call sites (lines 140, 242 of the pre-Task-5 file) need the items list threaded through:

```kotlin
    private fun openSelectedVastraPreviewDialog(
        selectedVastraSubcat: MerchantCatalogSubcategory,
        items: List<MerchantCatalogItem>,
        selectedVastraItem: MerchantCatalogItem,
    ) {
        val selectedVastraThemePreviewDialog = SelectedVastraThemePreviewDialog(selectedVastraSubcat, items, selectedVastraItem) { selectedVastraItem ->
//            gotoNextScreen(selectedVastraSubcat,selectedVastraItem)
        }
        selectedVastraThemePreviewDialog.show(childFragmentManager, "SelectedVastraThemePreviewDialog")
    }
```

The call site inside `setupProductItemRecyclerviewAdapter()`/`loadItemsForSubcategory` (the normal browse list) passes the items currently held by `productUploadViewmodel.catalogItems`'s last emitted list — capture it in a field (e.g. `private var currentItems: List<MerchantCatalogItem> = emptyList()`, set inside `loadItemsForSubcategory`'s observer alongside `dressTypeSubcatAdapter.submitList(items)`) and pass `currentItems` at the call site: `openSelectedVastraPreviewDialog(selectedSubcategory, currentItems, selectedItem)`. The search-results call site passes whatever list `setSearchProductItemList` is currently displaying (its own parameter, already `List<MerchantCatalogItem>` post-retarget) instead of `currentItems`.

Replace `filterProductBySku()` (lines 197-219) and its observer wiring:

```kotlin
    private fun filterProductBySku(searchBy:String) {
        isFromSearchProduct = true
        LoaderManager.show(requireActivity(), requireActivity().findViewById(android.R.id.content), true)
        LoaderManager.setMessage("Filtering Products...")
        ViewControll.hideKeyboard(requireActivity())
        productUploadViewmodel.searchItems(searchBy)
        productUploadViewmodel.catalogItems.observe(viewLifecycleOwner) { items ->
            LoaderManager.remove(requireActivity())
            if (items.isNotEmpty()) {
                setSearchProductItemList(items, searchBy)
            } else {
                binding.recyclerVastraItem.isVisible = true
                binding.recyclerSearchProductItem.isVisible = false
            }
        }
    }
```

`setSearchProductItemList` (line 223 onward, not shown in full above) takes `ArrayList<VastraProductCategoryDataModel.Data.Subcategory.Item>` — change its parameter type to `List<MerchantCatalogItem>` to match; `searchProductAdapter` is the same `ProductCategoryItemAdapter` retargeted in this task, so this is consistent with the type change already made.

- [ ] **Step 5: Compile-check**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin 2>&1 | grep "e: file" | sort -u
```

Expected: remaining failures only in `UploadVastraFragment.kt`, `UploadPhotoDialog.kt` (Task 7), plus possibly `ProductSubCategoryAdapter.kt`/`ProductCategoryItemAdapter.kt` if their internals reference more `VastraProductCategoryDataModel` fields than assumed above — read those two adapter files fully if compile errors point there, and adjust their field bindings to the new model's equivalent fields (`.name`, `.imageUrl`/`.thumbnailUrl`, `.label`) rather than guessing further from this plan. (`VastraSliderAdapter.kt` and `SelectedVastraThemePreviewDialog.kt` are already covered above — they should compile clean at this checkpoint, not appear in this failure list. If either still errors, the fix above missed a reference; grep that file for any remaining `VastraProductCategoryDataModel`/`.fullpath`/`.items` occurrence before assuming a new gap.)

- [ ] **Step 6: Commit**

```bash
git add apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogModels.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogRepository.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/VastraProductCategoryFragment.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/dialog/SelectedVastraThemePreviewDialog.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/adapter/VastraSliderAdapter.kt
git commit -m "feat(saree-catalogue-android): catalog browse against /v1/merchant/catalog, collapse two-level nav to one"
```

---

### Task 7: Generate + finalize product flow

**Files:**
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogModels.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogRepository.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/dialog/UploadPhotoDialog.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/UploadVastraFragment.kt`
- Test: `apps/saree_catalogue_android/app/src/test/java/tryme/nice/trymeadmin/PollStatusTest.kt`

This replaces `app_custome_drapping` (generate preview), `app_tryonresultv1` (poll), and `app_addthemev1` (finalize with category+SKU+price) with the presign→generate→poll→import→patch sequence from the spec. The legacy two-step UI (pick pallu type before capture, pick category+SKU+price after generating) becomes: pick subcategory first (unlocks capture), then after generating, enter SKU+price only.

- [ ] **Step 1: Add generate/import models**

Append to `MerchantCatalogModels.kt`:

```kotlin
@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogPresignResponse(
    @JsonProperty("assetId") val assetId: String = "",
    @JsonProperty("uploadUrl") val uploadUrl: String = "",
    @JsonProperty("r2Key") val r2Key: String = "",
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogGenerateResponse(
    @JsonProperty("jobId") val jobId: String = "",
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogGenerateStatus(
    @JsonProperty("jobId") val jobId: String = "",
    @JsonProperty("status") val status: String = "",
    @JsonProperty("resultUrl") val resultUrl: String? = null,
    @JsonProperty("errorCode") val errorCode: String? = null,
)

/** Pure — no Android/network dependency, safe for a plain JUnit test. */
fun isTerminalGenerateStatus(status: String): Boolean =
    status == "COMPLETED" || status == "FAILED" || status == "CANCELLED"
```

- [ ] **Step 2: Add the generate/import repository functions**

Append to `MerchantCatalogRepository.kt`:

```kotlin
    suspend fun presignFlatImage(contentType: String, contentLength: Long): MerchantCatalogPresignResponse {
        val body = org.json.JSONObject().apply {
            put("kind", "flat")
            put("contentType", contentType)
            put("contentLength", contentLength)
        }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_PRESIGN, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogPresignResponse::class.java)
    }

    suspend fun uploadFlatImage(uploadUrl: String, file: java.io.File, contentType: String) {
        val body = file.asRequestBody(contentType.toMediaType())
        APICaller.putToPresignedUrl(uploadUrl, body)
    }

    suspend fun generate(subcategoryId: String, flatImageKey: String): String {
        val body = org.json.JSONObject().apply {
            put("subcategoryId", subcategoryId)
            put("flatImageKey", flatImageKey)
        }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_GENERATE, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogGenerateResponse::class.java).jobId
    }

    suspend fun pollGenerateStatus(jobId: String): MerchantCatalogGenerateStatus {
        val url = APIConstant.API_ENDPOINTS.merchantCatalogGenerateStatus(jobId)
        val response = APICaller.getJsonAuthed(url, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogGenerateStatus::class.java)
    }

    suspend fun import(jobId: String, subcategoryId: String): MerchantCatalogItem {
        val body = org.json.JSONObject().apply {
            put("jobId", jobId)
            put("subcategoryId", subcategoryId)
        }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_IMPORT, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogItem::class.java)
    }

    suspend fun setPricing(itemId: String, sku: String, actualPrice: Int, offerPrice: Int): MerchantCatalogItem {
        val body = org.json.JSONObject().apply {
            put("sku", sku)
            put("actualPrice", actualPrice)
            put("offerPrice", offerPrice)
        }.toString()
        val url = APIConstant.API_ENDPOINTS.merchantCatalogItem(itemId)
        val response = APICaller.patchJsonAuthed(url, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogItem::class.java)
    }
```

Add the needed imports at the top of `MerchantCatalogRepository.kt`:

```kotlin
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
```

- [ ] **Step 3: Add the orchestration function to `ProductUploadViewModel`**

Add the import Task 5 removed (needed again for `APIConstant.serverTimeOut`/`errorSomethingWrong` below) back to the top of the file:

```kotlin
import com.example.facewixlatest.ApiUtils.APIConstant
```

Then add:

```kotlin
    sealed class GenerateState {
        object Uploading : GenerateState()
        object Generating : GenerateState()
        data class Completed(val resultUrl: String) : GenerateState()
        data class Failed(val message: String) : GenerateState()
    }

    private val _generateState = MutableLiveData<GenerateState>()
    val generateState: LiveData<GenerateState> get() = _generateState

    private var pendingItemId: String? = null
    val generatedItemId: String? get() = pendingItemId

    fun generateProduct(file: java.io.File, subcategoryId: String) {
        viewModelScope.launch {
            try {
                _generateState.postValue(GenerateState.Uploading)
                val contentType = "image/jpeg"
                val presign = MerchantCatalogRepository.presignFlatImage(contentType, file.length())
                MerchantCatalogRepository.uploadFlatImage(presign.uploadUrl, file, contentType)

                _generateState.postValue(GenerateState.Generating)
                val jobId = MerchantCatalogRepository.generate(subcategoryId, presign.r2Key)

                val startedAt = System.currentTimeMillis()
                var status: MerchantCatalogGenerateStatus
                do {
                    delay(2500)
                    status = MerchantCatalogRepository.pollGenerateStatus(jobId)
                    if (System.currentTimeMillis() - startedAt > 180_000) {
                        _generateState.postValue(GenerateState.Failed(APIConstant.serverTimeOut))
                        return@launch
                    }
                } while (!isTerminalGenerateStatus(status.status))

                if (status.status != "COMPLETED" || status.resultUrl == null) {
                    _generateState.postValue(GenerateState.Failed(APIConstant.errorSomethingWrong))
                    return@launch
                }

                val item = MerchantCatalogRepository.import(jobId, subcategoryId)
                pendingItemId = item.id
                _generateState.postValue(GenerateState.Completed(status.resultUrl))
            } catch (e: Exception) {
                _generateState.postValue(GenerateState.Failed(AuthRepository.errorMessage(e)))
            }
        }
    }

    fun finalizeProduct(sku: String, actualPrice: Int, offerPrice: Int, onDone: (Boolean, String) -> Unit) {
        val itemId = pendingItemId
        if (itemId == null) {
            onDone(false, APIConstant.errorSomethingWrong)
            return
        }
        viewModelScope.launch {
            try {
                MerchantCatalogRepository.setPricing(itemId, sku, actualPrice, offerPrice)
                pendingItemId = null
                onDone(true, "")
            } catch (e: Exception) {
                onDone(false, AuthRepository.errorMessage(e))
            }
        }
    }
```

(Task 5 already deleted the legacy `uploadCustomProductAPI`, `fetchCustomSareeTryOnAPI`, `pollTryOnResult`, and their backing `LiveData` — nothing to remove here, this is purely additive.)

- [ ] **Step 4: Rewrite `UploadPhotoDialog.kt`**

The dialog's job changes from "call the old drape-preview API" to "kick off `generateProduct` and show its state." Constructor now takes a `subcategoryId` instead of `selectedPalluType` (per the spec's pallu-type-to-subcategory mapping):

```kotlin
class UploadPhotoDialog(private val selectedPhotoPath: String,
                        private val subcategoryId: String,
                        private val onCompleted: (String) -> Unit) : BottomSheetDialogFragment() {
```

Replace `uploadProductImageAPI()` (lines 94-115):

```kotlin
    private fun uploadProductImageAPI(){
        keepScreenOn()
        LoaderManager.show(requireActivity(),dialog?.window?.decorView as ViewGroup,true)
        LoaderManager.setMessage(getString(R.string.uploading_your_product))
        productUploadViewmodel.generateProduct(File(selectedPhotoPath), subcategoryId)
        productUploadViewmodel.generateState.observe(this) { state ->
            when (state) {
                is ProductUploadViewModel.GenerateState.Completed -> {
                    LoaderManager.remove(requireActivity())
                    clearKeepScreenOn()
                    onCompleted(state.resultUrl)
                    dismiss()
                }
                is ProductUploadViewModel.GenerateState.Failed -> {
                    LoaderManager.remove(requireActivity())
                    clearKeepScreenOn()
                    ViewControll.showMessage(requireActivity(), state.message)
                    dismiss()
                }
                else -> { /* Uploading / Generating — loader already shown */ }
            }
        }
    }
```

Every other function in this file (`onCreateDialog`, `onStart`, `keepScreenOn`/`clearKeepScreenOn`, `onDestroyView`, the `ImageSourceType` sealed class) is presentation-only and untouched.

- [ ] **Step 5: Rewrite `UploadVastraFragment.kt`'s subcategory-first flow**

Replace `gotoNextScreen()` (lines 602-620) — drops the `selectedPalluType` null-guard (subcategory is now chosen earlier, before capture is even reachable):

```kotlin
    private fun gotoNextScreen(capturePhotoFilePath: String) {
        val subcategoryId = selectedSubcategoryId
        if (subcategoryId == null) {
            ViewControll.showMessage(requireActivity(), "Please select a product type before uploading")
            return
        }
        val uploadPhotoDialog = UploadPhotoDialog(capturePhotoFilePath, subcategoryId) { resultUrl ->
            binding.llAddProduct.isVisible = true
            binding.llUploadProduct.isVisible = false
            resetSelectCatSKUDetails()
            initViewAddProduct(resultUrl)
        }
        uploadPhotoDialog.show(childFragmentManager, "UploadPhotoDialog")
    }
```

Replace `selectedPalluType: String?` field declaration (line 68) with `private var selectedSubcategoryId: String? = null`.

Replace `getSareePalluTypeData()`/`resetPalluTypeObserber()`/`setPalluTypeSpinner()`/`isPalluTypeSelected()` (lines 727-774, 837-846) — this becomes the subcategory picker, and per the spec it now runs **before** capture rather than as part of "Add Product":

```kotlin
    private fun getSubcategoryData(){
        productUploadViewmodel.fetchSubcategories("women")
        productUploadViewmodel.subcategories.observe(viewLifecycleOwner){subcategoryList->
            if(subcategoryList!=null && subcategoryList.isNotEmpty()){
                setSubcategorySpinner(subcategoryList)
            }
        }
        productUploadViewmodel.error.observe(viewLifecycleOwner){errorMsg->
            if(errorMsg!=null){
                ViewControll.showSnackErrorMsg(requireActivity(),errorMsg)
            }
        }
    }

    private fun setSubcategorySpinner(subcategoryList: List<MerchantCatalogSubcategory>) {
        val nameList = subcategoryList.map { it.name }
        val adapter = ArrayAdapter(requireActivity(), R.layout.item_spinner_text, nameList)
        binding.materialSpinnerPalluType.setAdapter(adapter)
        binding.materialSpinnerPalluType.setOnItemClickListener { _, _, position, _ ->
            selectedSubcategoryId = subcategoryList[position].id
        }
        binding.materialSpinnerPalluType.setDropDownBackgroundDrawable(
            ContextCompat.getDrawable(requireActivity(), R.drawable.bg_dropdown_white)
        )
        if (subcategoryList.isNotEmpty()) {
            selectedSubcategoryId = subcategoryList[0].id
            binding.materialSpinnerPalluType.setText(subcategoryList[0].name, false)
        }
    }

    private fun isSubcategorySelected(): Boolean {
        if(selectedSubcategoryId==null){
            ViewControll.showMessage(requireActivity(),"Please select a product type")
            return false
        }
        return true
    }
```

Find every call site of `isPalluTypeSelected()` (lines 853, 858 per the earlier grep) and rename to `isSubcategorySelected()`. Find every call site of `getSareePalluTypeData()` and move it to fire at the point the fragment's "Upload" screen is first shown (`initView()`, matching where the legacy code fetched pallu types before capture was reachable) rather than after generation.

Replace `initViewAddProduct()` (lines 622-637) — now takes the generated preview URL directly instead of reading it back out of `PrefsManager.getCustomSareeTryOnResultData`, and no longer fetches a second "product category" list (subcategory was already chosen):

```kotlin
    private fun initViewAddProduct(resultUrl: String) {
        try{
            Glide.with(requireActivity())
                .load(resultUrl)
                .placeholder(ViewControll.setLoaderDrawble(requireActivity()))
                .into(binding.imgTryonResult)
        }catch (e:Exception){
            e.printStackTrace()
        }
        binding.btnCancel.setOnClickListener(this)
        binding.btnUpload.setOnClickListener(this)
        binding.btnUpload.setTextColor(ContextCompat.getColor(requireActivity(), R.color.white))
        binding.btnCancel.setTextColor(ContextCompat.getColor(requireActivity(), R.color.white))
    }
```

Delete `getAllProductCatList()`/`setVastracatSpinner()`/`getSelectedVastraCatList()`/`resetObserver()` (lines 639-654, 705-725, 776-791) and the `selectedProductCat`/`ProductCategoryDataModel` field — no longer needed, subcategory was chosen up front.

Replace `checkValidation()` (lines 656-672) — drop the category check (already chosen), keep SKU/price/offer-price:

```kotlin
    private fun checkValidation(): Boolean {
        if(binding.etSkuNo.text.trim().isEmpty()){
            ViewControll.showMessage(requireActivity(),"Please add SKU No")
            return false
        }else if(binding.etPrice.text.trim().isEmpty()){
            ViewControll.showMessage(requireActivity(),"Please add price")
            return false
        }else if(binding.etOfferPrice.text.trim().isEmpty()){
            ViewControll.showMessage(requireActivity(),"Please add offer price")
            return false
        }else{
            return true
        }
    }
```

Replace `uploadVastraProductAPI()` (lines 674-703):

```kotlin
    private fun uploadVastraProductAPI(){
        val skuNo = binding.etSkuNo.text.trim().toString()
        val price = binding.etPrice.text.trim().toString().toIntOrNull() ?: 0
        val offerPrice = binding.etOfferPrice.text.trim().toString().toIntOrNull() ?: 0
        LoaderManager.show(requireActivity(),requireActivity().findViewById(android.R.id.content),true)
        LoaderManager.setMessage("Adding Product...")
        productUploadViewmodel.finalizeProduct(skuNo, price, offerPrice) { success, errorMsg ->
            LoaderManager.remove(requireActivity())
            if(success){
                ViewControll.showMessage(requireActivity(),"Product added successfully")
                binding.llUploadProduct.isVisible = true
                binding.llAddProduct.isVisible = false
                (activity as? DashBoardActivity)?.navigateToProductFrag()
            } else {
                ViewControll.showMessage(requireActivity(),errorMsg)
            }
        }
    }
```

`handleBack()` (line 799) reads `customSareeTryOnResultData.tryon_image` for the discard-confirmation preview — replace with a field that stores the last generated `resultUrl` (set in the `gotoNextScreen` callback above); add `private var lastGeneratedResultUrl: String = ""` near the other fields, set it in the `UploadPhotoDialog` completion callback (`initViewAddProduct(resultUrl)` call site), and use `lastGeneratedResultUrl` in place of `customSareeTryOnResultData.tryon_image` in `handleBack()`/`showCancleUploadAlertDialog()`.

Add the import `import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory` and `import tryme.nice.trymeadmin.viewmodels.isTerminalGenerateStatus` (if referenced directly; it's only used inside `ProductUploadViewModel` in this plan, so this import may not be needed here — add only if the compiler requires it).

- [ ] **Step 6: Write the one pure-logic unit test**

`isTerminalGenerateStatus` (Step 1) is the only genuinely pure function introduced in this task. Create `apps/saree_catalogue_android/app/src/test/java/tryme/nice/trymeadmin/PollStatusTest.kt`:

```kotlin
package tryme.nice.trymeadmin

import tryme.nice.trymeadmin.viewmodels.isTerminalGenerateStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PollStatusTest {
    @Test
    fun `completed failed and cancelled are terminal`() {
        assertTrue(isTerminalGenerateStatus("COMPLETED"))
        assertTrue(isTerminalGenerateStatus("FAILED"))
        assertTrue(isTerminalGenerateStatus("CANCELLED"))
    }

    @Test
    fun `queued and processing are not terminal`() {
        assertFalse(isTerminalGenerateStatus("QUEUED"))
        assertFalse(isTerminalGenerateStatus("PROCESSING"))
        assertFalse(isTerminalGenerateStatus(""))
    }
}
```

Run it:

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:testDebugUnitTest --tests "tryme.nice.trymeadmin.PollStatusTest"
```

Expected: `BUILD SUCCESSFUL`, 2 tests passed.

- [ ] **Step 7: Compile-check**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin 2>&1 | grep "e: file" | sort -u
```

Expected: `BUILD SUCCESSFUL`, or very close to it — `ProductUploadDataRepository.kt` and `ApiUtils/APIInterface.kt` are already gone (Task 5), and every screen has now been rewired (Tasks 4, 6, 7). If anything still fails, it should only be a leftover reference to `ProductCategoryDataModel`/`VastraProductCategoryDataModel`/`SareePalluTypeDataModel`/`ProductSearchDataModel`/`VastraTryOnResultModel` that Task 6/7's rewiring missed — grep for those type names across the whole module and fix any stragglers before Task 8's cleanup pass confirms and deletes the now-dead ones.

- [ ] **Step 8: Commit**

```bash
git add apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/dialog/UploadPhotoDialog.kt apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/UploadVastraFragment.kt apps/saree_catalogue_android/app/src/test/java/tryme/nice/trymeadmin/PollStatusTest.kt
git commit -m "feat(saree-catalogue-android): generate+import+patch product flow against apps/api merchant catalog"
```

---

### Task 8: Final cleanup sweep

**Files:**
- Possibly delete: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductCategoryDataModel.kt`, `VastraProductCategoryDataModel.kt`, `SareePalluTypeDataModel.kt`, `ProductSearchDataModel.kt`, `VastraTryOnResultModel.kt` (verify each is fully unreferenced before deleting — Task 5 already deleted `APIInterface.kt`/`ProductUploadDataRepository.kt`/`CommonResponseModel.kt`/`SearchEvent.kt`, so this is only the models that were still in active use by UI screens as of Task 5 and should now be dead after Tasks 6-7 rewired those screens)
- Possibly modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/utils/PrefsManager.kt` (remove `saveCustomSareeResultData`/`getCustomSareeTryOnResultData` only if Step 2 below confirms nothing calls them anymore)

- [ ] **Step 1: Check each remaining legacy model file for zero references, delete confirmed-dead ones**

```bash
for model in ProductCategoryDataModel VastraProductCategoryDataModel SareePalluTypeDataModel ProductSearchDataModel; do
  echo "=== $model ==="
  grep -rln "$model" apps/saree_catalogue_android/app/src/main/java --include=*.kt
done
```

For each model where the only remaining match is the model's own file, delete it:

```bash
rm apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/<ModelName>.kt
```

Do this individually per model, re-running the grep after each deletion to catch any indirect reference the batch grep above might have missed (e.g. a data class nested inside another still-live file).

- [ ] **Step 2: Check whether `VastraTryOnResultModel.kt` is now fully dead**

Task 7 rewrote `UploadVastraFragment.kt` (`handleBack()`, `initViewAddProduct()`) to use a `lastGeneratedResultUrl` field instead of reading `PrefsManager.getCustomSareeTryOnResultData` — check whether that was the last caller:

```bash
grep -rln "VastraTryOnResultModel\|saveCustomSareeResultData\|getCustomSareeTryOnResultData" apps/saree_catalogue_android/app/src/main/java --include=*.kt
```

- If the only matches are `VastraTryOnResultModel.kt` itself and `PrefsManager.kt`'s own `saveCustomSareeResultData`/`getCustomSareeTryOnResultData` declarations (no caller anywhere else), both functions and the model are dead: remove `saveCustomSareeResultData`/`getCustomSareeTryOnResultData` from `PrefsManager.kt`, then `rm apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/VastraTryOnResultModel.kt`.
- If anything else still calls either function, leave `PrefsManager.kt` and `VastraTryOnResultModel.kt` alone — do not delete a model with a live caller.

- [ ] **Step 3: Full compile + assemble**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`, zero errors. If anything still fails, it means a reference was missed in Tasks 5-7 — fix it directly (do not re-add deleted legacy files as a workaround).

- [ ] **Step 4: Commit**

```bash
git add -A apps/saree_catalogue_android/
git commit -m "chore(saree-catalogue-android): delete dead legacy response models"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full debug compile**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`. (Project path workaround: `apps/saree_catalogue_android`'s folder name inherits the parent monorepo path but the sibling app's own docs — `docs/progress.md`, 2026-07-17 Android entries — note the wrapper jar has no `Main-Class` manifest entry, so `java -jar gradle-wrapper.jar` fails; the `-cp ... org.gradle.wrapper.GradleWrapperMain` form used throughout this plan sidesteps that. If this repo's checkout path also contains a literal `&`, per the same prior Android work, `gradlew.bat` itself will fail on `cmd.exe` parsing — always use the `java -cp` form, never `gradlew.bat` directly, for this project.)

- [ ] **Step 2: Full unit test run**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:testDebugUnitTest
```

Expected: `BUILD SUCCESSFUL` (includes `PollStatusTest` from Task 7 plus the pre-existing `ExampleUnitTest`).

- [ ] **Step 3: Debug assemble**

```bash
java -cp "gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`, produces `apps/saree_catalogue_android/app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 4: Manual device/emulator walkthrough (not automatable in this session — flag as pending, do not fabricate as done)**

This step requires an Android emulator/device, a running `apps/api` + `apps/dispatcher` against real Postgres/Redis/MinIO, and admin-panel data setup (per the spec's rollout prerequisite: at least one `garment_subcategories` + `merchant_catalog_subcategories` row under `category='women'`, with a `defaultPoseId` set, and a merchant test account). None of this is available in a plain implementation session. Whoever runs this step should confirm, in order:

1. Login screen: enter merchant email/password → lands on dashboard. Verify a second login attempt on a different logical "device" beyond `maxActiveDevices` shows the `DEVICE_LIMIT_REACHED` message (not a crash).
2. Product browse screen: subcategories load and render (this is the former "pallu type" list, now sourced from `/v1/merchant/catalog/subcategories?category=women`); tapping one loads its items.
3. Search box: enter a product label substring, confirm matching items appear (note: matches on `label`, not `sku` — expected per the spec's documented gap).
4. Upload flow: pick a subcategory first, capture/select a flat photo, confirm the generate→poll sequence shows a loading state then a generated preview image.
5. Finalize: enter SKU + price + offer price, submit, confirm success message and return to the product list.
6. Cross-check: call `GET /v1/merchant/catalog?subcategoryId=<the one used above>` directly (or check the web catalogue-manager's Women → Sarees section) and confirm the just-created product appears there with the SKU/price entered.
7. Logout: confirm it returns to the login screen and a subsequent app restart does not auto-login (session cleared).

Do not mark this step complete without actually running it — this plan's author has no device/browser tool in this environment to do so.

---

## Rollout prerequisite (reference, not a plan task)

Per the design spec: before step 4 of the manual walkthrough above can succeed, an admin must create at least one `garment_subcategories` row (with `defaultPoseId` set) and a corresponding `merchant_catalog_subcategories` row (`category: 'women'`) for the test merchant account, using the existing admin panel — no code from this plan creates that data.
