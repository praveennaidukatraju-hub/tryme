package tryme.nice.interactive.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.graphics.Color
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import tryme.nice.interactive.R
import tryme.nice.interactive.ui.components.AppLoadingIndicator
import tryme.nice.interactive.utils.sdp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.NavType
import androidx.navigation.navArgument
import tryme.nice.interactive.ui.screens.ProfilePage
import tryme.nice.interactive.ui.screens.ReportsPage
import tryme.nice.interactive.ui.screens.WebViewPage
import tryme.nice.interactive.ui.screens.CategorySelectionPage
import tryme.nice.interactive.utils.CrashReporter
import tryme.nice.interactive.ui.screens.OnboardingPage
import tryme.nice.interactive.ui.screens.OutfitSelectionPage
import tryme.nice.interactive.ui.screens.PendingActivationPage
import tryme.nice.interactive.ui.screens.SignInPage
import tryme.nice.interactive.ui.screens.SplashPage
import tryme.nice.interactive.ui.screens.OutfitDetailPage
import tryme.nice.interactive.ui.screens.PoseGuidePage
import tryme.nice.interactive.ui.screens.PhotoUploadPage
import tryme.nice.interactive.ui.screens.PhotoReviewPage
import tryme.nice.interactive.ui.screens.TryOnProcessingPage
import tryme.nice.interactive.ui.screens.TryOnResultPage
import tryme.nice.interactive.ui.screens.TryMoreOutfitsPage
import tryme.nice.interactive.ui.screens.DownloadPage
import tryme.nice.interactive.data.models.CatalogProduct
import tryme.nice.interactive.data.models.MerchantStatus
import tryme.nice.interactive.data.repository.AuthResult
import tryme.nice.interactive.data.repository.OnboardingRepository
import tryme.nice.interactive.data.repository.OnboardingResult
import tryme.nice.interactive.data.repository.UserRepository
import tryme.nice.interactive.data.session.SessionManager
import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.viewmodels.AppVideoViewModel
import tryme.nice.interactive.viewmodels.TryOnState
import tryme.nice.interactive.viewmodels.TryOnViewModel

/**
 * Navigation routes definitions.
 */
sealed class Screen(val route: String) {
    object Splash             : Screen("splash")
    object SignIn             : Screen("signin")
    object Onboarding         : Screen("onboarding")
    object PendingActivation  : Screen("pending_activation")
    object CategorySelection  : Screen("category_selection")
    object Profile            : Screen("profile")
    object Reports            : Screen("reports")
    object TryOnLibrary       : Screen("tryon_library")
    object OutfitSelection    : Screen("outfit_selection/{category}") {
        fun createRoute(category: String) = "outfit_selection/$category"
    }
    object OutfitDetail       : Screen("outfit_detail")
    object PoseGuide          : Screen("pose_guide/{category}") {
        fun createRoute(category: String) = "pose_guide/$category"
    }
    object PhotoUpload        : Screen("photo_upload")
    object PhotoReview        : Screen("photo_review")
    object TryOnProcessing    : Screen("tryon_processing")
    object TryOnResult        : Screen("tryon_result")
    object TryMoreOutfits     : Screen("try_more_outfits")
    object Download           : Screen("download")
}

/**
 * AppNavGraph configures the standard Jetpack Compose NavHost with
 * instantaneous (zero-lag) transition configurations.
 */
@Composable
fun AppNavGraph(
    navController: NavHostController,
    modifier: Modifier = Modifier,
    tryOnViewModel: TryOnViewModel = viewModel(),
    appVideoViewModel: AppVideoViewModel = viewModel()
) {
    val appVideoUri by appVideoViewModel.videoUri.collectAsState()

    var selectedProduct by remember { mutableStateOf<CatalogProduct?>(null) }
    var activeSubcategoryProductList by remember { mutableStateOf<List<CatalogProduct>>(emptyList()) }
    var fromTryMoreOutfits by remember { mutableStateOf(false) }

    var selectedCategory by remember { mutableStateOf("women") }
    var capturedPhotoUri by remember { mutableStateOf<String?>(null) }
    var customerPhotoR2Key by remember { mutableStateOf<String?>(null) }

    // Google login includes a suggested name pair for the onboarding form; password
    // login and the splash session-restore path never do, and OnboardingViewModel
    // falls back to fetching prefill from the server when both are null/blank.
    var onboardingSuggestedContactName by remember { mutableStateOf<String?>(null) }
    var onboardingSuggestedCompanyName by remember { mutableStateOf<String?>(null) }
    var hasEnteredTryMoreFlow by remember { mutableStateOf(false) }

    val sessionTryOnResults = remember { mutableStateListOf<String>() }
    // Parallel to sessionTryOnResults (same index = same result) — job IDs are short
    // enough to fit in the "download all" QR, unlike the presigned result URLs.
    val sessionTryOnJobIds = remember { mutableStateListOf<String>() }

    val tryOnUiState by tryOnViewModel.uiState.collectAsState()

    var lastNavTime by remember { mutableLongStateOf(0L) }

    val safePopBackStack: () -> Unit = {
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastNavTime >= 350L) {
            lastNavTime = now
            val currentRoute = navController.currentDestination?.route
            if (currentRoute != Screen.CategorySelection.route && navController.previousBackStackEntry != null) {
                navController.popBackStack()
            }
        }
    }

    NavHost(
        navController = navController,
        startDestination = Screen.Splash.route,
        modifier = modifier
    ) {
        // ── Splash ───────────────────────────────────────────────────────
        composable(
            route = Screen.Splash.route,
            exitTransition = { ExitTransition.None }
        ) { entry ->
            val scope = rememberCoroutineScope()
            var isCheckingSession by remember { mutableStateOf(false) }

            SplashPage(
                isLoading = isCheckingSession,
                onClick = {
                    if (isCheckingSession) return@SplashPage
                    isCheckingSession = true
                    scope.launch {
                        try {
                            val destination = if (SessionManager.hasValidSession()) {
                                ApiClient.setAccessToken(SessionManager.accessToken)
                                // A session can be valid (token not expired) while the
                                // merchant is still ONBOARDING_REQUIRED/PENDING_ACTIVATION
                                // from a previous run — re-check status rather than
                                // assuming ACTIVE, or catalog calls would 403 with no
                                // explanation right after this navigation.
                                when (val result = OnboardingRepository().getStatus()) {
                                    is OnboardingResult.Success -> when (result.data.merchantStatus) {
                                        MerchantStatus.ONBOARDING_REQUIRED -> {
                                            onboardingSuggestedContactName = result.data.prefill.contactName
                                            onboardingSuggestedCompanyName = result.data.prefill.companyName
                                            Screen.Onboarding.route
                                        }
                                        MerchantStatus.PENDING_ACTIVATION -> Screen.PendingActivation.route
                                        else -> Screen.CategorySelection.route
                                    }
                                    // Network hiccup at splash shouldn't block an otherwise
                                    // valid session — fall through to Home as before.
                                    is OnboardingResult.Failure -> Screen.CategorySelection.route
                                }
                            } else {
                                Screen.SignIn.route
                            }

                            if (entry.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                                navController.currentDestination?.route == Screen.Splash.route
                            ) {
                                navController.navigate(destination) {
                                    popUpTo(Screen.Splash.route) { inclusive = true }
                                    launchSingleTop = true
                                }
                            }
                        } catch (e: Exception) {
                            CrashReporter.recordException(e, "NavGraph")
                            val fallbackDestination = if (SessionManager.hasValidSession()) {
                                Screen.CategorySelection.route
                            } else {
                                Screen.SignIn.route
                            }
                            navController.navigate(fallbackDestination) {
                                popUpTo(Screen.Splash.route) { inclusive = true }
                            }
                        } finally {
                            isCheckingSession = false
                        }
                    }
                }
            )
        }

        // ── Sign In ──────────────────────────────────────────────────────
        composable(
            route = Screen.SignIn.route,
            enterTransition = { EnterTransition.None },
            exitTransition  = { ExitTransition.None }
        ) {
            SignInPage(
                onLoginSuccess = { response ->
                    val destination = when (response.merchantStatus) {
                        MerchantStatus.ONBOARDING_REQUIRED -> {
                            onboardingSuggestedContactName = response.onboarding?.suggestedContactName
                            onboardingSuggestedCompanyName = response.onboarding?.suggestedCompanyName
                            Screen.Onboarding.route
                        }
                        MerchantStatus.PENDING_ACTIVATION -> Screen.PendingActivation.route
                        // A null merchantStatus falls through to Home exactly like
                        // before this was wired up.
                        else -> Screen.CategorySelection.route
                    }
                    navController.navigate(destination) {
                        popUpTo(Screen.SignIn.route) { inclusive = true }
                    }
                }
            )
        }

        // ── Onboarding (merchantStatus = ONBOARDING_REQUIRED) ────────────
        composable(
            route = Screen.Onboarding.route,
            enterTransition = { EnterTransition.None },
            exitTransition  = { ExitTransition.None }
        ) {
            OnboardingPage(
                suggestedContactName = onboardingSuggestedContactName,
                suggestedCompanyName = onboardingSuggestedCompanyName,
                onOnboardingComplete = {
                    navController.navigate(Screen.CategorySelection.route) {
                        popUpTo(Screen.Onboarding.route) { inclusive = true }
                    }
                }
            )
        }

        // ── Pending Activation (merchantStatus = PENDING_ACTIVATION) ─────
        composable(
            route = Screen.PendingActivation.route,
            enterTransition = { EnterTransition.None },
            exitTransition  = { ExitTransition.None }
        ) {
            val scope = rememberCoroutineScope()
            PendingActivationPage(
                onLogout = {
                    scope.launch {
                        val refreshToken = SessionManager.refreshToken
                        if (!refreshToken.isNullOrEmpty()) {
                            UserRepository().logoutDevice(refreshToken)
                        }
                        SessionManager.clear()
                        navController.navigate(Screen.SignIn.route) {
                            popUpTo(0) { inclusive = true }
                        }
                    }
                }
            )
        }

        // ── Category Selection ───────────────────────────────────────────
        composable(
            route = Screen.CategorySelection.route,
            enterTransition = { EnterTransition.None },
            exitTransition  = { ExitTransition.None }
        ) {
            CategorySelectionPage(
                onCategorySelected = { categoryId ->
                    navController.navigate(Screen.OutfitSelection.createRoute(categoryId))
                },
                onProfileClick = {
                    navController.navigate(Screen.Profile.route)
                },
                onUploadProductsClick = {
                    navController.navigate(Screen.TryOnLibrary.route)
                },
                onReportsClick = {
                    navController.navigate(Screen.Reports.route)
                },
                onLogoutSuccess = {
                    navController.navigate(Screen.SignIn.route) {
                        popUpTo(0) { inclusive = true }
                    }
                }
            )
        }

        // ── Reports (try-on history) ─────────────────────────────────────
        composable(
            route = Screen.Reports.route,
            enterTransition = { EnterTransition.None },
            exitTransition  = { ExitTransition.None }
        ) {
            ReportsPage(onBack = { safePopBackStack() })
        }

        // ── Dedicated Profile Page ───────────────────────────────────────
        composable(
            route = Screen.Profile.route,
            enterTransition = { EnterTransition.None },
            exitTransition  = { ExitTransition.None }
        ) {
            ProfilePage(
                onBack = { safePopBackStack() },
                onLogoutSuccess = {
                    navController.navigate(Screen.SignIn.route) {
                        popUpTo(0) { inclusive = true }
                    }
                }
            )
        }

        // ── Try-On Library (in-app webview) ───────────────────────────────
        composable(
            route = Screen.TryOnLibrary.route,
            enterTransition = { EnterTransition.None },
            exitTransition  = { ExitTransition.None }
        ) {
            val tryOnLibraryBaseUrl = "https://app.tryme.com/tryon-library-app"
            var libraryUrl by remember { mutableStateOf<String?>(null) }

            // Exchanges the device session for a short-lived SSO code so the WebView
            // logs in as the same user instead of showing its own sign-in page. On
            // any failure, falls back to the plain URL so the user can still log in
            // manually rather than being stuck on a blank screen.
            LaunchedEffect(Unit) {
                libraryUrl = try {
                    val response = ApiClient.apiService.getCatalogAppDeviceCode()
                    val code = response.body()?.code
                    if (response.isSuccessful && !code.isNullOrBlank()) {
                        "$tryOnLibraryBaseUrl?code=$code"
                    } else {
                        tryOnLibraryBaseUrl
                    }
                } catch (e: Exception) {
                    CrashReporter.recordException(e, "NavGraph")
                    tryOnLibraryBaseUrl
                }
            }

            val currentLibraryUrl = libraryUrl
            if (currentLibraryUrl == null) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black),
                    contentAlignment = Alignment.Center
                ) {
                    AppLoadingIndicator(size = sdp(R.dimen._32sdp), color = Color(0xFFE7A52C))
                }
            } else {
                WebViewPage(
                    url = currentLibraryUrl,
                    onExit = {
                        navController.navigate(Screen.CategorySelection.route) {
                            popUpTo(Screen.CategorySelection.route) { inclusive = false }
                            launchSingleTop = true
                        }
                    }
                )
            }
        }

        composable(
            route = Screen.OutfitSelection.route,
            arguments = listOf(
                navArgument("category") { type = NavType.StringType }
            ),
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) { backStackEntry ->
            OutfitSelectionPage(
                category = backStackEntry.arguments?.getString("category").orEmpty(),
                onBack = { safePopBackStack() },
                onUnauthorized = {
                    navController.navigate(Screen.SignIn.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onOutfitSelected = { product, productList ->
                    selectedCategory = backStackEntry.arguments?.getString("category").orEmpty()
                    selectedProduct = product
                    fromTryMoreOutfits = false
                    activeSubcategoryProductList = productList
                    navController.navigate(Screen.OutfitDetail.route)
                },
                onUploadProductsClick = {
                    navController.navigate(Screen.TryOnLibrary.route)
                }
            )
        }

        composable(
            route = Screen.OutfitDetail.route,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) { entry ->
            selectedProduct?.let { product ->
                OutfitDetailPage(
                    product = product,
                    productList = activeSubcategoryProductList,
                    onBack = { safePopBackStack() },
                    onStartTryOn = { targetProduct ->
                        selectedProduct = targetProduct
                        val photoKey = customerPhotoR2Key
                        if (fromTryMoreOutfits && !photoKey.isNullOrBlank()) {
                            tryOnViewModel.startTryOn(targetProduct.id, photoKey)
                            navController.navigate(Screen.TryOnProcessing.route)
                        } else {
                            navController.navigate(Screen.PoseGuide.createRoute(selectedCategory))
                        }
                    }
                )
            } ?: Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
                LaunchedEffect(Unit) {
                    if (entry.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                        safePopBackStack()
                    }
                }
            }
        }

        composable(
            route = Screen.PoseGuide.route,
            arguments = listOf(
                navArgument("category") { type = NavType.StringType }
            ),
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) { backStackEntry ->
            PoseGuidePage(
                category = backStackEntry.arguments?.getString("category").orEmpty(),
                onBack = { safePopBackStack() },
                onReady = { navController.navigate(Screen.PhotoUpload.route) }
            )
        }

        composable(
            route = Screen.PhotoUpload.route,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) {
            PhotoUploadPage(
                onBack = {
                    // Exiting PhotoUpload backward always lands on the original OutfitDetail
                    // entry, not the one pushed from TryMoreOutfits — clear the reuse-photo
                    // shortcut flag or a stale true skips PhotoUpload/PhotoReview next time.
                    fromTryMoreOutfits = false
                    safePopBackStack()
                },
                onUploadSuccess = { photoUri, r2Key ->
                    // A freshly captured/uploaded photo starts a new customer's session — any
                    // try-on results still held from a previous photo must not leak into this
                    // person's Download page. (No-op if there's nothing to clear yet, e.g. a
                    // retake before any try-on completed.)
                    sessionTryOnResults.clear()
                    sessionTryOnJobIds.clear()
                    tryOnViewModel.resetState()
                    capturedPhotoUri = photoUri
                    customerPhotoR2Key = r2Key
                    hasEnteredTryMoreFlow = false
                    navController.navigate(Screen.PhotoReview.route)
                }
            )
        }

        composable(
            route = Screen.PhotoReview.route,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) { entry ->
            val handleBackToUpload: () -> Unit = {
                val now = android.os.SystemClock.uptimeMillis()
                if (now - lastNavTime >= 350L) {
                    lastNavTime = now
                    if (!navController.popBackStack(Screen.PhotoUpload.route, inclusive = false)) {
                        navController.navigate(Screen.PhotoUpload.route)
                    }
                }
            }

            capturedPhotoUri?.let { uri ->
                PhotoReviewPage(
                    photoUri = uri,
                    onBack = handleBackToUpload,
                    onRetake = handleBackToUpload,
                    onProceed = {
                        if (hasEnteredTryMoreFlow) {
                            navController.navigate(Screen.TryMoreOutfits.route) {
                                popUpTo(Screen.PhotoReview.route) { inclusive = false }
                            }
                        } else {
                            val garmentId = selectedProduct?.id
                            val photoKey = customerPhotoR2Key
                            if (!garmentId.isNullOrBlank() && !photoKey.isNullOrBlank()) {
                                tryOnViewModel.startTryOn(garmentId, photoKey)
                                navController.navigate(Screen.TryOnProcessing.route)
                            }
                        }
                    },
                    // Reached here from TryMoreOutfits (reusing an existing photo) rather than
                    // a fresh PhotoUpload — there's no upload step to go "back" to, so the top
                    // button is Home instead, guarded by PhotoReviewPage's own confirmation.
                    cameFromTryMoreOutfits = hasEnteredTryMoreFlow,
                    onGoHome = {
                        hasEnteredTryMoreFlow = false
                        sessionTryOnResults.clear()
                        tryOnViewModel.resetState()
                        navController.navigate(Screen.CategorySelection.route) {
                            popUpTo(Screen.CategorySelection.route) { inclusive = true }
                        }
                    }
                )
            } ?: Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
                LaunchedEffect(Unit) {
                    if (entry.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                        handleBackToUpload()
                    }
                }
            }
        }

        composable(
            route = Screen.TryOnProcessing.route,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) { entry ->
            LaunchedEffect(tryOnUiState.state, tryOnUiState.shareUrl) {
                val url = tryOnUiState.shareUrl
                val jobId = tryOnUiState.jobId
                if (tryOnUiState.state == TryOnState.COMPLETED && url != null) {
                    if (!sessionTryOnResults.contains(url)) {
                        sessionTryOnResults.add(url)
                        if (jobId != null) sessionTryOnJobIds.add(jobId)
                    }
                    if (entry.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                        // Collapse everything back to PhotoReview so TryOnResult always sits
                        // directly on top of it — otherwise repeated "Try Another" loops pile
                        // up TryMoreOutfits/OutfitDetail entries and back navigation has to
                        // walk back through all of them instead of returning to PhotoReview.
                        navController.navigate(Screen.TryOnResult.route) {
                            popUpTo(Screen.PhotoReview.route) { inclusive = false }
                        }
                    }
                }
            }

            val handleCancel: () -> Unit = {
                tryOnViewModel.cancelCurrentTryOnJob()
                safePopBackStack()
            }

            TryOnProcessingPage(
                videoUri = appVideoUri,
                elapsedSeconds = tryOnUiState.elapsedTimeSeconds,
                errorMessage = tryOnUiState.errorMessage,
                onBack = handleCancel,
                onCancel = handleCancel,
                onRetry = {
                    val msg = tryOnUiState.errorMessage.orEmpty().lowercase()
                    val isSessionExpired = msg.contains("expired") || msg.contains("not owned")
                    if (isSessionExpired) {
                        navController.navigate(Screen.PhotoUpload.route) {
                            popUpTo(Screen.PhotoUpload.route) { inclusive = true }
                        }
                    } else {
                        val garmentId = selectedProduct?.id
                        val photoKey = customerPhotoR2Key
                        if (!garmentId.isNullOrBlank() && !photoKey.isNullOrBlank()) {
                            tryOnViewModel.startTryOn(garmentId, photoKey)
                        }
                    }
                }
            )
        }

        composable(
            route = Screen.TryOnResult.route,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) { entry ->
            tryOnUiState.shareUrl?.let { url ->
                TryOnResultPage(
                    resultImageUrl = url,
                    onBack = {
                        hasEnteredTryMoreFlow = true
                        val now = android.os.SystemClock.uptimeMillis()
                        if (now - lastNavTime >= 350L) {
                            lastNavTime = now
                            navController.navigate(Screen.TryMoreOutfits.route) {
                                popUpTo(Screen.PhotoReview.route) { inclusive = false }
                            }
                        }
                    },
                    onTryAnother = {
                        hasEnteredTryMoreFlow = true
                        val now = android.os.SystemClock.uptimeMillis()
                        if (now - lastNavTime >= 350L) {
                            lastNavTime = now
                            navController.navigate(Screen.TryMoreOutfits.route) {
                                popUpTo(Screen.PhotoReview.route) { inclusive = false }
                            }
                        }
                    },
                    onDownload = {
                        navController.navigate(Screen.Download.route)
                    }
                )
            } ?: Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
                LaunchedEffect(Unit) {
                    if (entry.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                        safePopBackStack()
                    }
                }
            }
        }

        composable(
            route = Screen.TryMoreOutfits.route,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) {
            TryMoreOutfitsPage(
                initialCategory = selectedCategory,
                initialProduct = selectedProduct,
                resultImageUrl = tryOnUiState.shareUrl,
                sessionHistory = sessionTryOnResults,
                onUnauthorized = {
                    navController.navigate(Screen.SignIn.route) {
                        popUpTo(0) { inclusive = true }
                    }
                },
                onGoHome = {
                    hasEnteredTryMoreFlow = false
                    sessionTryOnResults.clear()
                    tryOnViewModel.resetState()
                    navController.navigate(Screen.CategorySelection.route) {
                        popUpTo(Screen.CategorySelection.route) { inclusive = true }
                    }
                },
                onGoToDownloads = {
                    navController.navigate(Screen.Download.route)
                },
                onRetake = {
                    val now = android.os.SystemClock.uptimeMillis()
                    if (now - lastNavTime >= 350L) {
                        lastNavTime = now
                        if (!navController.popBackStack(Screen.PhotoUpload.route, inclusive = false)) {
                            navController.navigate(Screen.PhotoUpload.route)
                        }
                    }
                },
                onSelectOutfitDetail = { product, subcategoryList ->
                    selectedProduct = product
                    activeSubcategoryProductList = subcategoryList
                    fromTryMoreOutfits = true
                    navController.navigate(Screen.OutfitDetail.route)
                },
                onTryLook = { newProduct ->
                    selectedProduct = newProduct
                    val photoKey = customerPhotoR2Key
                    if (!photoKey.isNullOrBlank()) {
                        tryOnViewModel.startTryOn(newProduct.id, photoKey)
                        navController.navigate(Screen.TryOnProcessing.route)
                    }
                }
            )
        }

        composable(
            route = Screen.Download.route,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) {
            DownloadPage(
                resultsList = sessionTryOnResults,
                jobIds = sessionTryOnJobIds,
                onBack = { safePopBackStack() },
                onDeleteSession = {
                    hasEnteredTryMoreFlow = false
                    sessionTryOnResults.clear()
                    sessionTryOnJobIds.clear()
                    tryOnViewModel.resetState()
                    navController.navigate(Screen.CategorySelection.route) {
                        popUpTo(Screen.CategorySelection.route) { inclusive = true }
                    }
                },
                onCreateNew = {
                    hasEnteredTryMoreFlow = false
                    sessionTryOnResults.clear()
                    tryOnViewModel.resetState()
                    navController.navigate(Screen.CategorySelection.route) {
                        popUpTo(Screen.CategorySelection.route) { inclusive = true }
                    }
                },
                onRetake = {
                    val now = android.os.SystemClock.uptimeMillis()
                    if (now - lastNavTime >= 350L) {
                        lastNavTime = now
                        if (!navController.popBackStack(Screen.PhotoUpload.route, inclusive = false)) {
                            navController.navigate(Screen.PhotoUpload.route)
                        }
                    }
                }
            )
        }
    }
}
