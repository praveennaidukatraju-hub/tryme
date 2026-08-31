package tryme.nice.trymeadmin.fragment.adapter
import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.utils.ViewControll
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogItem
import android.app.Activity
import android.graphics.Paint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
class VastraSliderAdapter(private val context: Activity, private val images: List<MerchantCatalogItem>) : RecyclerView.Adapter<VastraSliderAdapter.Holder>() {
 inner class Holder(view: View):RecyclerView.ViewHolder(view){val image:ImageView=view.findViewById(R.id.img_vastra_theme);val txtPrice:TextView=view.findViewById(R.id.txt_price);val txtOfferPrice:TextView=view.findViewById(R.id.txt_offer_price);val txtSkuNumber:TextView=view.findViewById(R.id.txt_sku_number)}
 override fun onCreateViewHolder(p:ViewGroup,v:Int)=Holder(LayoutInflater.from(p.context).inflate(R.layout.item_slider_image,p,false))
 override fun onBindViewHolder(h:Holder,p:Int){val i=images[p];Glide.with(context).load(i.imageUrl).thumbnail(.1f).diskCacheStrategy(DiskCacheStrategy.ALL).skipMemoryCache(false).placeholder(ViewControll.setLoaderDrawble(context)).dontAnimate().into(h.image);h.txtSkuNumber.text="SKU No : ${i.sku ?: ""}";h.txtOfferPrice.text="Price : Rs${i.offerPrice}";h.txtPrice.text="Rs${i.actualPrice}";h.txtPrice.paintFlags=h.txtPrice.paintFlags or Paint.STRIKE_THRU_TEXT_FLAG}
 override fun getItemCount()=images.size
}