package tryme.nice.trymeadmin.fragment.adapter

import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.databinding.ItemVastraBinding
import tryme.nice.trymeadmin.viewmodels.DiffMerchantCatalogItemCallback
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.databinding.DataBindingUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import java.util.*
import kotlin.collections.ArrayList

class ProductCategoryItemAdapter(private val onClickEvent:(MerchantCatalogItem,Int)->Unit)
    :  ListAdapter<MerchantCatalogItem,
        ProductCategoryItemAdapter.RecyclerViewViewHolder>(DiffMerchantCatalogItemCallback())

    {

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerViewViewHolder {
            val binding: ItemVastraBinding = DataBindingUtil.inflate(
                LayoutInflater.from(parent.context),
                R.layout.item_vastra, parent, false
            )
            return  RecyclerViewViewHolder(binding)
        }

        override fun onBindViewHolder(holder: RecyclerViewViewHolder, position: Int) {
            val itemData: MerchantCatalogItem = getItem(position)
            val viewHolder: RecyclerViewViewHolder = holder as RecyclerViewViewHolder
            viewHolder.bindItem(itemData)
            // Handle item selection
            viewHolder.itemView.setOnClickListener {
               selectedItemPosition(position)
            }
        }

        fun selectedItemPosition(position: Int){
            onClickEvent(getItem(position),position) // Trigger click listener
        }

        class RecyclerViewViewHolder(binding: ItemVastraBinding) :
            RecyclerView.ViewHolder(binding.getRoot()) {
            var binding: ItemVastraBinding

            init {
                this.binding = binding
            }

            fun bindItem(itemData: MerchantCatalogItem) {
                try {
                    Glide.with(binding.root.context)
                        .load(itemData.thumbnailUrl ?: itemData.imageUrl)
                        .thumbnail(0.1f)                // shows preview immediately
                        .diskCacheStrategy(DiskCacheStrategy.ALL)
                        .skipMemoryCache(false)
                        .dontAnimate()
                        .into(binding.imgVastraItem)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
                binding.executePendingBindings()
            }
        }
    }

