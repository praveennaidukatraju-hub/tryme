package tryme.nice.interactive.viewmodels

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import tryme.nice.interactive.data.repository.TryOnRepository
import tryme.nice.interactive.data.repository.TryOnResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class TryOnState {
    IDLE,
    CREATING_JOB,
    PROCESSING,
    COMPLETED,
    FAILED,
    CANCELLED
}

data class TryOnUiState(
    val state: TryOnState = TryOnState.IDLE,
    val jobId: String? = null,
    val shareUrl: String? = null,
    val errorMessage: String? = null,
    val elapsedTimeSeconds: Int = 0
)

class TryOnViewModel @JvmOverloads constructor(
    application: Application = Application(),
    private val repository: TryOnRepository = TryOnRepository()
) : AndroidViewModel(application) {

    private val _uiState = MutableStateFlow(TryOnUiState())
    val uiState: StateFlow<TryOnUiState> = _uiState.asStateFlow()

    private var pollingJob: Job? = null

    fun startTryOn(garmentId: String, customerPhotoKey: String) {
        pollingJob?.cancel()
        _uiState.value = TryOnUiState(state = TryOnState.CREATING_JOB)

        viewModelScope.launch {
            try {
                when (val result = repository.createTryOnJob(garmentId, customerPhotoKey)) {
                    is TryOnResult.Success -> {
                        val jobId = result.data
                        _uiState.update { it.copy(state = TryOnState.PROCESSING, jobId = jobId) }
                        pollJobStatus(jobId)
                    }
                    is TryOnResult.Failure -> {
                        _uiState.update {
                            it.copy(
                                state = TryOnState.FAILED,
                                errorMessage = result.message
                            )
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        state = TryOnState.FAILED,
                        errorMessage = e.message ?: "Failed to initiate try-on job"
                    )
                }
            }
        }
    }

    private fun pollJobStatus(jobId: String) {
        pollingJob = viewModelScope.launch {
            try {
                val maxSeconds = 900 // 15 minutes max timeout
                val pollIntervalMs = 2000L
                val maxAttempts = maxSeconds / (pollIntervalMs / 1000).toInt() // 450 attempts

                var consecutiveFailures = 0

                for (attempt in 1..maxAttempts) {
                    delay(pollIntervalMs)
                    _uiState.update { it.copy(elapsedTimeSeconds = attempt * 2) }

                    when (val result = repository.checkJobStatus(jobId)) {
                        is TryOnResult.Success -> {
                            consecutiveFailures = 0
                            val response = result.data
                            val status = response.status.uppercase()
                            when (status) {
                                "COMPLETED", "SUCCESS" -> {
                                    val finalUrl = response.shareUrl
                                        ?: response.resultKey?.let { key ->
                                            if (key.startsWith("http")) key
                                            else "https://pub-2e9ee0f339f44a8fb927958ce786a345.r2.dev/$key"
                                        }
                                    if (finalUrl != null) {
                                        _uiState.update {
                                            it.copy(
                                                state = TryOnState.COMPLETED,
                                                shareUrl = finalUrl
                                            )
                                        }
                                    } else {
                                        _uiState.update {
                                            it.copy(
                                                state = TryOnState.FAILED,
                                                errorMessage = "Try-on completed but no result image was returned. Please try again."
                                            )
                                        }
                                    }
                                    return@launch
                                }
                                "FAILED", "ERROR", "EXPIRED", "TIMED_OUT" -> {
                                    _uiState.update {
                                        it.copy(
                                            state = TryOnState.FAILED,
                                            errorMessage = response.errorCode ?: "Try-on generation failed. Please try again."
                                        )
                                    }
                                    return@launch
                                }
                                "CANCELLED" -> {
                                    _uiState.update {
                                        it.copy(
                                            state = TryOnState.CANCELLED,
                                            errorMessage = response.errorCode ?: "Try-on job cancelled"
                                        )
                                    }
                                    return@launch
                                }
                                else -> {
                                    // Status is GENERATING, PROCESSING, PENDING... keep polling
                                }
                            }
                        }
                        is TryOnResult.Failure -> {
                            consecutiveFailures++
                            if (consecutiveFailures >= 10) {
                                _uiState.update {
                                    it.copy(
                                        state = TryOnState.FAILED,
                                        errorMessage = result.message
                                    )
                                }
                                return@launch
                            }
                        }
                    }
                }

                // If max attempts reached without completion
                _uiState.update {
                    it.copy(
                        state = TryOnState.FAILED,
                        errorMessage = "Try-on generation timed out. Please try again."
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        state = TryOnState.FAILED,
                        errorMessage = e.message ?: "An unexpected error occurred during processing."
                    )
                }
            }
        }
    }

    fun cancelCurrentTryOnJob() {
        val currentJobId = _uiState.value.jobId
        pollingJob?.cancel()
        pollingJob = null
        _uiState.update { it.copy(state = TryOnState.CANCELLED) }

        if (!currentJobId.isNullOrBlank()) {
            viewModelScope.launch {
                try {
                    repository.deleteJob(currentJobId)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Handled gracefully if job already finished or non-cancellable
                }
            }
        }
    }

    fun resetState() {
        pollingJob?.cancel()
        _uiState.value = TryOnUiState()
    }

    override fun onCleared() {
        pollingJob?.cancel()
        super.onCleared()
    }
}
