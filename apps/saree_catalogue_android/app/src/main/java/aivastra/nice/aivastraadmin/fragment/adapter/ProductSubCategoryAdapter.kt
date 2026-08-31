package tryme.nice.interactive.activity.vastra

import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.databinding.ItemVastraCategoryNewBinding
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.databinding.DataBindingUtil
import androidx.recyclerview.widget.RecyclerView
import kotlin.collections.ArrayList

class ProductSubCategoryAdapter(private val subcategoryList: List<MerchantCatalogSubcategory>,
                                private val onClickEvent:(MerchantCatalogSubcategory,Int)->Unit) : RecyclerView.Adapter<RecyclerView.ViewHolder>()
    {

        private var selectedPosition: Int = -1

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            val binding: ItemVastraCategoryNewBinding = DataBindingUtil.inflate(
                LayoutInflater.from(parent.context),
                R.layout.item_vastra_category_new, parent, false
            )
            return  RecyclerViewViewHolder(binding)
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            val itemData: MerchantCatalogSubcategory = subcategoryList.get(position)
            val viewHolder: RecyclerViewViewHolder = holder as RecyclerViewViewHolder
            viewHolder.bindItem(itemData)
            val context = viewHolder.itemView.context
            val isSelected = position == selectedPosition
            if (isSelected) {
                viewHolder.binding.llMainItemview.setBackgroundResource(R.drawable.app_gradiant_square_bg)
                viewHolder.binding.txtCatName.setTextColor(ContextCompat.getColor(context, R.color.white))
            } else {
                viewHolder.binding.llMainItemview.background = null
                viewHolder.binding.txtCatName.setTextColor(ContextCompat.getColor(context, R.color.white))
            }
            // Handle item selection
            viewHolder.itemView.setOnClickListener {
                val previousPosition = selectedPosition
                selectedPosition = position
                if (previousPosition != -1) {
                    notifyItemChanged(previousPosition) // Reset previous selection
                }
                notifyItemChanged(selectedPosition) // Highlight current selection
               selectedItemPosition(position)
            }
        }

        fun selectedItemPosition(position: Int){
            onClickEvent(subcategoryList.get(position),position) // Trigger click listener
        }

        fun selectedItemPositionDefault(position: Int){
            val previousPosition = selectedPosition
            selectedPosition = position
            if (previousPosition != -1 && previousPosition != position) {
                notifyItemChanged(previousPosition)
            }
            notifyItemChanged(position)
            onClickEvent(subcategoryList.get(position),position) // Trigger click listener
        }

        override fun getItemCount(): Int {
            return subcategoryList.size
        }

        class RecyclerViewViewHolder(binding: ItemVastraCategoryNewBinding) :
            RecyclerView.ViewHolder(binding.getRoot()) {
            var binding: ItemVastraCategoryNewBinding

            init {
                this.binding = binding
            }

            fun bindItem(itemData: MerchantCatalogSubcategory) {
                binding.txtCatName.text = itemData.name
                binding.executePendingBindings()
            }
        }
    }

