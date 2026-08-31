package tryme.nice.trymeadmin.dialog

import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.databinding.DialogSelectedVastraThemeBinding
import tryme.nice.trymeadmin.fragment.adapter.VastraSliderAdapter
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.view.isVisible
import androidx.fragment.app.DialogFragment
import androidx.viewpager2.widget.ViewPager2

class SelectedVastraThemePreviewDialog(
    private val selectedVastraSubcat: MerchantCatalogSubcategory,
    private val items: List<MerchantCatalogItem>,
    private val selectedVastraItem: MerchantCatalogItem,
    private val dismissCallback: (MerchantCatalogItem) -> Unit
) : DialogFragment() {

    private lateinit var binding: DialogSelectedVastraThemeBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setStyle(STYLE_NORMAL, R.style.FullScreenDialog)
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        binding = DialogSelectedVastraThemeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.txtCatName.text = selectedVastraSubcat.name
        binding.viewpagerSlider.adapter = VastraSliderAdapter(requireActivity(), items)
        binding.viewpagerSlider.post {
            val initialIndex = items.indexOfFirst { it.id == selectedVastraItem.id }
            if (initialIndex >= 0) {
                binding.viewpagerSlider.setCurrentItem(initialIndex, false)
            }
        }
        binding.viewpagerSlider.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                binding.btnPrevious.isVisible = position > 0
                binding.btnNext.isVisible = position < items.lastIndex
            }
        })
        binding.imgBack.setOnClickListener { dismiss() }
        binding.btnPrevious.setOnClickListener {
            val curr = binding.viewpagerSlider.currentItem
            if (curr > 0) binding.viewpagerSlider.setCurrentItem(curr - 1, true)
        }
        binding.btnNext.setOnClickListener {
            val curr = binding.viewpagerSlider.currentItem
            if (curr < items.lastIndex) binding.viewpagerSlider.setCurrentItem(curr + 1, true)
        }
    }

    override fun onStart() {
        super.onStart()
        dialog?.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
    }
}