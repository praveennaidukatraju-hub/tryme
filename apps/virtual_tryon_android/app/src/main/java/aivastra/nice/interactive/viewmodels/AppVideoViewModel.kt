package tryme.nice.interactive.viewmodels

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import tryme.nice.interactive.data.repository.AppVideoRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// Activity-scoped (obtained once at the NavGraph root) so the fetch below runs exactly once
// per app session — every screen that needs the loading video reads the same cached Uri
// instead of each one re-fetching/re-downloading it.
class AppVideoViewModel @JvmOverloads constructor(
    application: Application = Application(),
    private val repository: AppVideoRepository = AppVideoRepository()
) : AndroidViewModel(application) {

    private val _videoUri = MutableStateFlow<Uri?>(null)
    val videoUri: StateFlow<Uri?> = _videoUri.asStateFlow()

    init {
        viewModelScope.launch {
            try {
                _videoUri.value = repository.fetchAppVideoUri(getApplication())
            } catch (_: Exception) {
                _videoUri.value = null
            }
        }
    }
}
