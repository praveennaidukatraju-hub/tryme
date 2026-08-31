package tryme.nice.trymeadmin.fragment

import android.os.Bundle
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.core.view.isVisible
import androidx.core.widget.addTextChangedListener
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import tryme.nice.trymeadmin.databinding.FragmentVastraProductCategoryBinding
import tryme.nice.trymeadmin.dialog.SelectedVastraThemePreviewDialog
import tryme.nice.trymeadmin.fragment.adapter.ProductCategoryItemAdapter
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory
import tryme.nice.trymeadmin.viewmodels.ProductUploadViewModel
import tryme.nice.interactive.Loader.LoaderManager
import tryme.nice.interactive.activity.vastra.ProductSubCategoryAdapter
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class VastraProductCategoryFragment : Fragment() {
    private lateinit var binding: FragmentVastraProductCategoryBinding
    private lateinit var vm: ProductUploadViewModel
    private lateinit var itemAdapter: ProductCategoryItemAdapter
    private var searchAdapter: ProductCategoryItemAdapter? = null
    private lateinit var selected: MerchantCatalogSubcategory
    private var browseItems: List<MerchantCatalogItem> = emptyList()
    private var searchResultItems: List<MerchantCatalogItem> = emptyList()
    private var isSearchMode = false
    private var searchJob: Job? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        binding = FragmentVastraProductCategoryBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        vm = ViewModelProvider(this)[ProductUploadViewModel::class.java]
        itemAdapter = ProductCategoryItemAdapter { item, _ -> preview(browseItems, item) }
        binding.recyclerVastraItem.adapter = itemAdapter
        searchAdapter = ProductCategoryItemAdapter { item, _ -> preview(searchResultItems, item) }
        binding.recyclerSearchProductItem.adapter = searchAdapter

        // Registered once — catalogItems is reused for both category-browse and search
        // results, so a single observer dispatching on isSearchMode avoids piling up a
        // fresh observer (and its stale-captured state) on every category tap / search.
        vm.catalogItems.observe(viewLifecycleOwner) { list ->
            if (isSearchMode) {
                searchResultItems = list
                binding.recyclerVastraItem.isVisible = false
                binding.recyclerSearchProductItem.isVisible = true
                searchAdapter?.submitList(list)
            } else {
                browseItems = list
                binding.recyclerVastraItem.isVisible = true
                binding.recyclerSearchProductItem.isVisible = false
                itemAdapter.submitList(list)
            }
        }

        load()
        search()
    }

    private fun load() {
        LoaderManager.show(requireActivity(), requireActivity().findViewById(android.R.id.content), true)
        vm.fetchSubcategories("women")
        vm.error.observe(viewLifecycleOwner) {
            if (it != null) {
                LoaderManager.remove(requireActivity())
                binding.txtNoData.isVisible = true
            }
        }
        vm.subcategories.observe(viewLifecycleOwner) { list ->
            LoaderManager.remove(requireActivity())
            if (list.isEmpty()) {
                binding.txtNoData.isVisible = true
            } else {
                selected = list[0]
                val categoryAdapter = ProductSubCategoryAdapter(list) { sub, _ ->
                    selected = sub
                    isSearchMode = false
                    vm.fetchItems(sub.id)
                }
                binding.recyclerVastraCategory.adapter = categoryAdapter
                binding.rlMainCatlist.isVisible = true
                categoryAdapter.selectedItemPositionDefault(0)
            }
        }
    }

    private fun search() {
        binding.etProductSearch.addTextChangedListener {
            searchJob?.cancel()
            val query = it?.toString()?.trim().orEmpty()
            searchJob = lifecycleScope.launch {
                delay(500)
                if (query.isNotEmpty()) {
                    isSearchMode = true
                    vm.searchItems(query)
                }
            }
        }
        binding.etProductSearch.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH || event?.keyCode == KeyEvent.KEYCODE_ENTER) {
                searchJob?.cancel()
                isSearchMode = true
                vm.searchItems(binding.etProductSearch.text.toString().trim())
                true
            } else {
                false
            }
        }
    }

    private fun preview(list: List<MerchantCatalogItem>, item: MerchantCatalogItem) {
        SelectedVastraThemePreviewDialog(selected, list, item) {}.show(childFragmentManager, "SelectedVastraThemePreviewDialog")
    }
}
