package tryme.nice.interactive.viewmodels

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import tryme.nice.interactive.data.repository.PhotoUploadRepository
import tryme.nice.interactive.data.repository.PhotoUploadResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PhotoUploadUiState(
    val isQrLoading: Boolean = true,
    val qrUrl: String? = null,
    val isUploading: Boolean = false,
    val uploadedR2Key: String? = null,
    val capturedPhotoUri: String? = null,
    val errorMessage: String? = null
)

class PhotoUploadViewModel @JvmOverloads constructor(
    application: Application = Application(),
    private val repository: PhotoUploadRepository = PhotoUploadRepository()
) : AndroidViewModel(application) {
    private val _uiState = MutableStateFlow(PhotoUploadUiState())
    val uiState: StateFlow<PhotoUploadUiState> = _uiState.asStateFlow()
    private var pollingJob: Job? = null
    private var currentToken: String? = null

    private var sessionJob: Job? = null

    init {
        createQrSession()
    }

    fun createQrSession(forceNew: Boolean = false) {
        if (!forceNew && sessionJob?.isActive == true) return
        sessionJob?.cancel()
        pollingJob?.cancel()
        currentToken = null
        _uiState.update { it.copy(isQrLoading = true, qrUrl = null, errorMessage = null) }
        sessionJob = viewModelScope.launch {
            try {
                when (val result = repository.createUploadSession()) {
                    is PhotoUploadResult.Success -> {
                        currentToken = result.data.token
                        _uiState.update { it.copy(isQrLoading = false, qrUrl = result.data.qrUrl) }
                        pollUploadStatus(result.data.token)
                    }
                    is PhotoUploadResult.Failure -> _uiState.update {
                        it.copy(isQrLoading = false, errorMessage = result.message)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isQrLoading = false, errorMessage = e.message ?: "Failed to create upload session")
                }
            }
        }
    }

    fun resetStateAndRefreshQr() {
        pollingJob?.cancel()
        sessionJob?.cancel()
        currentToken = null
        _uiState.update {
            PhotoUploadUiState(
                isQrLoading = true,
                qrUrl = null,
                isUploading = false,
                uploadedR2Key = null,
                capturedPhotoUri = null,
                errorMessage = null
            )
        }
        createQrSession(forceNew = true)
    }

    fun ensureActiveSession() {
        val token = currentToken
        if (_uiState.value.qrUrl == null || token == null) {
            createQrSession()
        } else if (pollingJob?.isActive != true) {
            pollUploadStatus(token)
        }
    }

    fun uploadCapturedPhoto(uri: Uri) {
        pollingJob?.cancel()
        _uiState.update {
            it.copy(isUploading = true, capturedPhotoUri = uri.toString(), errorMessage = null)
        }
        viewModelScope.launch {
            try {
                val bytes = try {
                    getApplication<Application>().contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: error("Unable to read captured photo")
                } catch (exception: CancellationException) {
                    throw exception
                } catch (exception: Exception) {
                    _uiState.update { it.copy(isUploading = false, errorMessage = exception.message) }
                    return@launch
                }
                when (val result = repository.uploadJpeg(bytes)) {
                    is PhotoUploadResult.Success -> _uiState.update {
                        it.copy(isUploading = false, uploadedR2Key = result.data)
                    }
                    is PhotoUploadResult.Failure -> _uiState.update {
                        it.copy(isUploading = false, errorMessage = result.message)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update { it.copy(isUploading = false, errorMessage = e.message ?: "Photo upload failed") }
            }
        }
    }

    fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    fun clearUploadedPhoto() {
        _uiState.update { it.copy(uploadedR2Key = null, capturedPhotoUri = null, isUploading = false) }
    }

    fun clearError() {
        _uiState.update { it.copy(errorMessage = null) }
    }

    private fun pollUploadStatus(token: String) {
        pollingJob?.cancel()
        pollingJob = viewModelScope.launch {
            var consecutiveFailures = 0
            while (true) {
                delay(1_500) // Poll every 1.5s for fast status update
                try {
                    when (val result = repository.checkUploadStatus(token)) {
                        is PhotoUploadResult.Success -> {
                            consecutiveFailures = 0
                            result.data?.let { r2Key ->
                                when (val cacheResult = repository.fetchAndCachePhoto(getApplication(), r2Key)) {
                                    is PhotoUploadResult.Success -> {
                                        _uiState.update {
                                            it.copy(
                                                uploadedR2Key = r2Key,
                                                capturedPhotoUri = cacheResult.data.toString(),
                                                isQrLoading = false
                                            )
                                        }
                                        return@launch
                                    }
                                    is PhotoUploadResult.Failure -> {
                                        _uiState.update { it.copy(errorMessage = cacheResult.message) }
                                        return@launch
                                    }
                                }
                            }
                        }
                        is PhotoUploadResult.Failure -> {
                            // If session expired on server (410), auto-refresh QR session!
                            if (result.message.contains("expired", ignoreCase = true)) {
                                createQrSession()
                                return@launch
                            }
                            consecutiveFailures++
                            if (consecutiveFailures >= 5) {
                                // Auto-recreate QR session if connection was lost & recovered
                                createQrSession()
                                return@launch
                            }
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    consecutiveFailures++
                    if (consecutiveFailures >= 5) {
                        createQrSession()
                        return@launch
                    }
                }
            }
        }
    }

    override fun onCleared() {
        pollingJob?.cancel()
        super.onCleared()
    }
}
