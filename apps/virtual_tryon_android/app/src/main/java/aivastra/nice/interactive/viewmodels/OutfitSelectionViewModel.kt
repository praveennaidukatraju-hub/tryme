package tryme.nice.interactive.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import tryme.nice.interactive.data.models.CatalogProduct
import tryme.nice.interactive.data.models.GarmentSubcategory
import tryme.nice.interactive.data.repository.CatalogRepository
import tryme.nice.interactive.data.repository.CatalogResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

data class OutfitSelectionUiState(
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val category: String = "",
    val subcategories: List<GarmentSubcategory> = emptyList(),
    val products: List<CatalogProduct> = emptyList(),
    val selectedSubcategoryId: String? = null,
    val errorMessage: String? = null,
    val isUnauthorized: Boolean = false
) {
    val visibleProducts: List<CatalogProduct>
        get() = selectedSubcategoryId?.let { id ->
            products.filter { it.subcategoryId == id }
        } ?: products
}

class OutfitSelectionViewModel(
    private val repository: CatalogRepository = CatalogRepository()
) : ViewModel() {
    private val _uiState = MutableStateFlow(OutfitSelectionUiState())
    val uiState: StateFlow<OutfitSelectionUiState> = _uiState.asStateFlow()

    private var catalogJob: Job? = null

    fun loadCatalog(category: String, forceReload: Boolean = false) {
        val normalizedCategory = category.trim().lowercase()
        val currentState = _uiState.value

        val shouldForceReload = forceReload || currentState.products.isEmpty()

        if (!shouldForceReload && currentState.category == normalizedCategory && currentState.products.isNotEmpty()) {
            _uiState.update { it.copy(isLoading = false, isRefreshing = false) }
            return
        }

        catalogJob?.cancel()

        val hasExistingContent =
            currentState.category == normalizedCategory && currentState.products.isNotEmpty()

        _uiState.update { state ->
            if (hasExistingContent) {
                state.copy(
                    isLoading = false,
                    isRefreshing = true,
                    category = normalizedCategory,
                    errorMessage = null,
                    isUnauthorized = false
                )
            } else {
                OutfitSelectionUiState(
                    isLoading = true,
                    category = normalizedCategory,
                    errorMessage = null,
                    isUnauthorized = false
                )
            }
        }

        catalogJob = viewModelScope.launch {
            try {
                val result = withTimeoutOrNull(20000L) {
                    repository.getCatalog(normalizedCategory, shouldForceReload)
                }

                if (result == null) {
                    _uiState.update { state ->
                        state.copy(
                            isLoading = false,
                            isRefreshing = false,
                            errorMessage = "Loading timed out. Check connection and tap Retry.",
                            isUnauthorized = false
                        )
                    }
                } else {
                    when (result) {
                        is CatalogResult.Success -> _uiState.update { state ->
                            val selectedSubcategoryId = resolveSelectedSubcategoryId(
                                subcategories = result.data.subcategories,
                                products = result.data.products,
                                preferredId = state.selectedSubcategoryId
                            )
                            state.copy(
                                isLoading = false,
                                isRefreshing = false,
                                category = normalizedCategory,
                                subcategories = result.data.subcategories,
                                products = result.data.products,
                                selectedSubcategoryId = selectedSubcategoryId,
                                errorMessage = null,
                                isUnauthorized = false
                            )
                        }

                        is CatalogResult.Failure -> _uiState.update { state ->
                            state.copy(
                                isLoading = false,
                                isRefreshing = false,
                                errorMessage = result.message,
                                isUnauthorized = result.isUnauthorized
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                _uiState.update { state ->
                    state.copy(
                        isLoading = false,
                        isRefreshing = false,
                        errorMessage = e.message ?: "Failed to load catalog. Tap Retry.",
                        isUnauthorized = false
                    )
                }
            }
        }
    }

    fun retry() {
        val category = _uiState.value.category
        if (category.isNotBlank()) {
            CatalogRepository.clearCache()
            loadCatalog(category, forceReload = true)
        }
    }

    fun refresh() {
        retry()
    }

    fun selectSubcategory(id: String?) {
        _uiState.update { it.copy(selectedSubcategoryId = id) }
    }

    private fun resolveSelectedSubcategoryId(
        subcategories: List<GarmentSubcategory>,
        products: List<CatalogProduct>,
        preferredId: String?
    ): String? {
        val productSubcategoryIds = products.mapTo(hashSetOf()) { it.subcategoryId }

        if (preferredId != null && preferredId in productSubcategoryIds) {
            return preferredId
        }

        return subcategories
            .firstOrNull { it.id in productSubcategoryIds }
            ?.id
    }
}
