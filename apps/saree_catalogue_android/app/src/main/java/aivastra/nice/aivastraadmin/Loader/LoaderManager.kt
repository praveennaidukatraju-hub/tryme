package tryme.nice.interactive.Loader

import tryme.nice.trymeadmin.R
import android.app.Activity
import android.content.Context
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.TextView
import androidx.core.view.isVisible
import java.util.WeakHashMap

object LoaderManager {

    private val loaderMap = WeakHashMap<Activity, View>()
    private var cachedMessage: String? = null

    fun show(context: Context, parent: ViewGroup, isMessageShow: Boolean) {
        // Ensure we're on the main thread
        if (Looper.myLooper() != Looper.getMainLooper()) {
            parent.post { show(context, parent, isMessageShow) }
            return
        }

        val activity = context as? Activity ?: return
        if (activity.isFinishing || activity.isDestroyed) return

        var loaderView = loaderMap[activity]
        if (loaderView == null) {
            loaderView = LayoutInflater.from(context).inflate(R.layout.loader_overlay, parent, false)
            loaderMap[activity] = loaderView
            parent.addView(loaderView)
        }

        loaderView?.visibility = View.VISIBLE

        val loaderText = loaderView?.findViewById<TextView>(R.id.loader_text)
        loaderText?.isVisible = isMessageShow

        // If message was cached before view was created
        cachedMessage?.let {
            loaderText?.text = it
        }

        activity.window.setFlags(
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        )
    }

    fun setMessage(message: String) {
        cachedMessage = message
        loaderMap.values.forEach { loader ->
            loader.findViewById<TextView>(R.id.loader_text)?.text = message
        }
    }

    fun hide(context: Context) {
        val activity = context as? Activity ?: return
        if (activity.isFinishing || activity.isDestroyed) return

        /*loaderMap[activity]?.visibility = View.GONE*/
        loaderMap[activity]?.let { loader ->
            (loader.parent as? ViewGroup)?.removeView(loader)
            loaderMap.remove(activity)
        }

        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
    }

    fun remove(context: Context) {
        val activity = context as? Activity ?: return
        loaderMap[activity]?.let { loader ->
            (loader.parent as? ViewGroup)?.removeView(loader)
            loaderMap.remove(activity)
        }

        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
    }
}