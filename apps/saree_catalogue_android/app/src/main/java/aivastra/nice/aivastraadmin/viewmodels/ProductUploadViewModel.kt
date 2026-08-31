package tryme.nice.trymeadmin.viewmodels

import tryme.nice.trymeadmin.utils.PrefsManager
import tryme.nice.interactive.viewmodel.Login.UserSession
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.facewixlatest.ApiUtils.APIConstant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

data class DeviceLimitState(
    val message: String,
    val forceLogoutToken: String,
)

class ProductUploadViewModel : ViewModel() {

    private val _error = MutableLiveData<String?>()
    val error: LiveData<String?> get() = _error

    private val _sessionResult = MutableLiveData<UserSession?>()
    val sessionResult: LiveData<UserSession?> get() = _sessionResult

    private val _deviceLimitReached = MutableLiveData<DeviceLimitState?>()
    val deviceLimitReached: LiveData<DeviceLimitState?> get() = _deviceLimitReached

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
            } catch (e: DeviceLimitReachedException) {
                _deviceLimitReached.postValue(DeviceLimitState(e.message.orEmpty(), e.forceLogoutToken))
            } catch (e: Exception) {
                _error.postValue(AuthRepository.errorMessage(e))
            }
        }
    }

    fun forceLogoutOtherDeviceAndLogin(forceLogoutToken: String, deviceId: String) {
        viewModelScope.launch {
            try {
                val session = AuthRepository.forceDeviceLogin(forceLogoutToken, deviceId)
                PrefsManager.saveSession(session)
                PrefsManager.saveRefreshToken(session.refreshToken)
                _deviceLimitReached.postValue(null)
                _sessionResult.postValue(session)
            } catch (e: Exception) {
                _error.postValue(AuthRepository.errorMessage(e))
            }
        }
    }

    fun resetDeviceLimitState() {
        _deviceLimitReached.postValue(null)
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
    private val _sareeStyles = MutableLiveData<List<MerchantCatalogSareeStyle>>()
    val sareeStyles: LiveData<List<MerchantCatalogSareeStyle>> get() = _sareeStyles
    private val _subcategories = MutableLiveData<List<MerchantCatalogSubcategory>>()
    val subcategories: LiveData<List<MerchantCatalogSubcategory>> get() = _subcategories
    private val _catalogItems = MutableLiveData<List<MerchantCatalogItem>>()
    val catalogItems: LiveData<List<MerchantCatalogItem>> get() = _catalogItems

    fun fetchSareeStyles() { viewModelScope.launch { try { _sareeStyles.postValue(MerchantCatalogRepository.fetchSareeStyles()) } catch (e: Exception) { _error.postValue(AuthRepository.errorMessage(e)) } } }
    fun fetchSubcategories(category: String = "women") { viewModelScope.launch { try { _subcategories.postValue(MerchantCatalogRepository.fetchSubcategories(category)) } catch (e: Exception) { _error.postValue(AuthRepository.errorMessage(e)) } } }
    fun fetchItems(subcategoryId: String) { viewModelScope.launch { try { _catalogItems.postValue(MerchantCatalogRepository.fetchItems(subcategoryId = subcategoryId)) } catch (e: Exception) { _error.postValue(AuthRepository.errorMessage(e)) } } }
    fun searchItems(query: String) { viewModelScope.launch { try { _catalogItems.postValue(MerchantCatalogRepository.fetchItems(search = query)) } catch (e: Exception) { _error.postValue(AuthRepository.errorMessage(e)) } } }
    fun resetSubcategories() { _subcategories.postValue(emptyList()); _error.postValue(null) }

    sealed class GenerateState {
        object Uploading : GenerateState()
        object Generating : GenerateState()
        data class Completed(val resultUrl: String) : GenerateState()
        data class Failed(val message: String) : GenerateState()
    }

    private val _generateState = MutableLiveData<GenerateState?>()
    val generateState: LiveData<GenerateState?> get() = _generateState

    private var pendingItemId: String? = null

    fun resetGenerateState() {
        _generateState.postValue(null)
    }

    private fun getContentType(file: java.io.File): String {
        val name = file.name.lowercase()
        return when {
            name.endsWith(".png") -> "image/png"
            name.endsWith(".webp") -> "image/webp"
            else -> "image/jpeg"
        }
    }

    fun generateProduct(
        file: java.io.File,
        subcategoryId: String,
        sareeStyleId: String? = null,
        secondaryFile: java.io.File? = null
    ) {
        _generateState.postValue(null)
        viewModelScope.launch {
            try {
                val maxSizeBytes = 20 * 1024 * 1024L
                if (file.length() > maxSizeBytes || (secondaryFile != null && secondaryFile.length() > maxSizeBytes)) {
                    _generateState.postValue(GenerateState.Failed("Image size exceeds maximum limit of 20MB"))
                    return@launch
                }

                _generateState.postValue(GenerateState.Uploading)
                val bodyContentType = getContentType(file)
                val presign = MerchantCatalogRepository.presignFlatImage(bodyContentType, file.length())
                MerchantCatalogRepository.uploadFlatImage(presign.uploadUrl, file, bodyContentType)

                val presign2 = if (secondaryFile != null) {
                    val palluContentType = getContentType(secondaryFile)
                    val presignSec = MerchantCatalogRepository.presignFlatImage(palluContentType, secondaryFile.length())
                    MerchantCatalogRepository.uploadFlatImage(presignSec.uploadUrl, secondaryFile, palluContentType)
                    presignSec
                } else null

                _generateState.postValue(GenerateState.Generating)
                val jobId = MerchantCatalogRepository.generate(subcategoryId, presign.r2Key, presign2?.r2Key, sareeStyleId)

                val startedAt = System.currentTimeMillis()
                var status: MerchantCatalogGenerateStatus
                do {
                    delay(2500)
                    status = MerchantCatalogRepository.pollGenerateStatus(jobId)
                    if (System.currentTimeMillis() - startedAt > 1_800_000) {
                        _generateState.postValue(GenerateState.Failed(APIConstant.serverTimeOut))
                        return@launch
                    }
                } while (!isTerminalGenerateStatus(status.status))

                val resultUrl = status.resultUrl
                if (status.status != "COMPLETED" || resultUrl == null) {
                    _generateState.postValue(GenerateState.Failed(APIConstant.errorSomethingWrong))
                    return@launch
                }

                val item = MerchantCatalogRepository.import(jobId, subcategoryId)
                pendingItemId = item.id
                _generateState.postValue(GenerateState.Completed(resultUrl))
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
}
