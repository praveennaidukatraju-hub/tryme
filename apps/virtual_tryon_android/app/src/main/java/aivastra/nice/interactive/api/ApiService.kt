package tryme.nice.interactive.api

import tryme.nice.interactive.data.models.AppVideoConfigResponse
import tryme.nice.interactive.data.models.CatalogAppDeviceCodeResponse
import tryme.nice.interactive.data.models.ContactRequest
import tryme.nice.interactive.data.models.DeviceLoginRequest
import tryme.nice.interactive.data.models.DeviceLoginResponse
import tryme.nice.interactive.data.models.ForceLoginRequest
import tryme.nice.interactive.data.models.GoogleLoginRequest
import tryme.nice.interactive.data.models.KioskDownloadBatchResponse
import tryme.nice.interactive.data.models.MerchantMeResponse
import tryme.nice.interactive.data.models.MerchantOnboardingRequest
import tryme.nice.interactive.data.models.MerchantOnboardingResponse
import tryme.nice.interactive.data.models.OnboardingStatusResponse
import tryme.nice.interactive.data.models.LogoutRequest
import tryme.nice.interactive.data.models.LogoutResponse
import tryme.nice.interactive.data.models.RefreshTokenRequest
import tryme.nice.interactive.data.models.RefreshTokenResponse
import tryme.nice.interactive.data.models.CatalogResponse
import tryme.nice.interactive.data.models.SubcategoryResponse
import tryme.nice.interactive.data.models.CreateUploadSessionResponse
import tryme.nice.interactive.data.models.PresignRequest
import tryme.nice.interactive.data.models.PresignResponse
import tryme.nice.interactive.data.models.TryOnHistoryResponse
import tryme.nice.interactive.data.models.UploadSessionStatusResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.GET
import retrofit2.http.Query
import retrofit2.http.Path

/**
 * Retrofit interface defining all authentication network endpoints.
 */
interface ApiService {

    /** App-wide loading/generation video config. Public — no merchant auth required. */
    @GET("v1/config/app-video")
    suspend fun getAppVideoConfig(): Response<AppVideoConfigResponse>

    @POST("v1/merchant/tryon/upload-sessions")
    suspend fun createUploadSession(): Response<CreateUploadSessionResponse>

    @GET("v1/merchant/tryon/upload-sessions/{token}")
    suspend fun getUploadSessionStatus(
        @Path("token") token: String
    ): Response<UploadSessionStatusResponse>

    @POST("v1/merchant/tryon/presign")
    suspend fun presignCustomerPhoto(
        @Body request: PresignRequest
    ): Response<PresignResponse>

    @GET("v1/merchant/tryon/photo-url")
    suspend fun getPhotoUrl(
        @Query("r2Key") r2Key: String
    ): Response<tryme.nice.interactive.data.models.PhotoUrlResponse>

    @POST("v1/merchant/tryon/jobs")
    suspend fun createTryOnJob(
        @Body request: tryme.nice.interactive.data.models.TryOnJobRequest
    ): Response<tryme.nice.interactive.data.models.TryOnJobResponse>

    @GET("v1/merchant/tryon/jobs/{jobId}")
    suspend fun getTryOnJobStatus(
        @Path("jobId") jobId: String
    ): Response<tryme.nice.interactive.data.models.TryOnStatusResponse>

    @retrofit2.http.DELETE("v1/merchant/tryon/jobs/{jobId}")
    suspend fun deleteTryOnJob(
        @Path("jobId") jobId: String
    ): Response<Unit>

    /**
     * includeDemo defaults true server-side when omitted, but it is passed explicitly
     * here so the admin-curated demo store items (gated by merchants.demoData) are
     * deliberately requested rather than relying on that implicit default.
     */
    @GET("v1/merchant/catalog/subcategories")
    suspend fun getSubcategories(
        @Query("category") category: String,
        @Query("includeDemo") includeDemo: Boolean = true
    ): Response<SubcategoryResponse>

    @GET("v1/merchant/catalog")
    suspend fun getCatalog(
        @Query("includeDemo") includeDemo: Boolean = true
    ): Response<CatalogResponse>

    /** Standard device login. Returns 409 DEVICE_LIMIT_REACHED when max devices exceeded. */
    @POST("v1/auth/device-login")
    suspend fun loginDevice(@Body request: DeviceLoginRequest): Response<DeviceLoginResponse>

    /** Force logout other sessions and login on this device. */
    @POST("v1/auth/device-login/force")
    suspend fun forceLogin(@Body request: ForceLoginRequest): Response<DeviceLoginResponse>

    /** Native Google sign-in — idToken comes from Credential Manager's GetGoogleIdOption. */
    @POST("v1/auth/device-login/google")
    suspend fun loginGoogle(@Body request: GoogleLoginRequest): Response<DeviceLoginResponse>

    /** Refresh access token using a valid refresh token. */
    @POST("v1/auth/device-refresh")
    suspend fun refreshToken(@Body request: RefreshTokenRequest): Response<RefreshTokenResponse>

    /** Logout the current device session. */
    @POST("v1/auth/device-logout")
    suspend fun logoutDevice(@Body request: LogoutRequest): Response<LogoutResponse>

    /** Current merchant profile + credit balance/usage, for the logged-in merchant. */
    @GET("v1/merchant/me")
    suspend fun getMerchantMe(): Response<MerchantMeResponse>

    /** Current merchantStatus + prefill data. Guarded by requireDeviceUser (device-login session, not requireMerchant). */
    @GET("v1/merchant/onboarding")
    suspend fun getOnboardingStatus(): Response<OnboardingStatusResponse>

    /** Creates the merchants row for this user. Returns 409 if one already exists. */
    @POST("v1/merchant/onboarding")
    suspend fun submitOnboarding(@Body request: MerchantOnboardingRequest): Response<MerchantOnboardingResponse>

    /**
     * Mints a single-use code (60s TTL) from this device's bearer token so the
     * Try-On Library WebView can log in as the same user without a fresh sign-in.
     * No body — the user is identified from the Authorization header.
     */
    @POST("v1/auth/catalog-app-device-code")
    suspend fun getCatalogAppDeviceCode(): Response<CatalogAppDeviceCodeResponse>

    /** Submits a contact/support inquiry. Returns 204 No Content on success. */
    @POST("v1/contact")
    suspend fun sendContactMessage(@Body request: ContactRequest): Response<Unit>

    /**
     * Per-day summary of distinct input photos vs completed (generated) jobs
     * for this merchant. Paginated newest-first; pass `before` (the previous
     * response's nextCursor) to fetch older days. nextCursor is null on the
     * last page.
     */
    @GET("v1/merchant/tryon/history")
    suspend fun getTryOnHistory(
        @Query("before") before: String? = null,
        @Query("limit") limit: Int = 30
    ): Response<TryOnHistoryResponse>

    /**
     * Public route (no auth) backing the "Download All" kiosk QR — mints fresh 24h
     * presigned URLs for a batch of job IDs. Only jobs that are COMPLETED, have a
     * result image, and completed within the last 24h are returned; anything else
     * (expired/failed/invalid) is silently omitted rather than erroring.
     */
    @GET("v1/kiosk-download/batch")
    suspend fun getKioskDownloadBatch(
        @Query("jobIds") jobIds: String
    ): Response<KioskDownloadBatchResponse>
}
