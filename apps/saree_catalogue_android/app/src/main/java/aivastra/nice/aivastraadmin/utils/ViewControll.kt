package tryme.nice.trymeadmin.utils

import tryme.nice.trymeadmin.R
import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.ContextCompat.getColor
import androidx.swiperefreshlayout.widget.CircularProgressDrawable
import com.google.android.material.snackbar.Snackbar
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody


class ViewControll {
    companion object{

        private var dialog: Dialog? = null

        fun showMessage(activity: Activity, message: String) {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }


        fun convertStringToRequestBody(itemValue: String): RequestBody {
            return itemValue.toRequestBody("multipart/form-data".toMediaTypeOrNull())
        }


        fun checkStoragePermission(activity: Activity): Boolean {
            return true // Storage permission is no longer required
        }

        fun hideDialog() {
            try {
                if (dialog != null && dialog?.isShowing() == true) {
                    dialog?.dismiss()
                    dialog = null
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }

        fun diableActivityClick(activity: Activity){
            activity.window.setFlags(
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        }
        fun enableActivityClick(activity: Activity){
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
        }

        fun setLoaderDrawble(activity: Activity): Drawable {
            val drawable = CircularProgressDrawable(activity)
            drawable.setColorSchemeColors(
                activity.getColor(R.color.white),
                activity.getColor(R.color.brown),
                activity.getColor(R.color.black),
                activity.getColor(R.color.app_theme),
            )
            drawable.centerRadius = 30f
            drawable.strokeWidth = 5f
            drawable.start()
            return drawable
        }

        fun hideKeyboard(activity: Activity) {
            val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            val view = activity.currentFocus ?: View(activity) // Fallback to a new View if no focus
            imm.hideSoftInputFromWindow(view.windowToken, 0)
        }

        fun showSnackErrorMsg(activity: Activity,erroMsg:String,onOkClick: (() -> Unit)? = null){
            if (activity.isFinishing || activity.isDestroyed) return

            val snackbar = Snackbar.make(
                activity.findViewById(android.R.id.content),
                erroMsg,
                Snackbar.LENGTH_INDEFINITE
            )
            val snackbarView = snackbar.view
            val density = activity.resources.displayMetrics.density

            // Make it a floating card by setting side margins
            val params = snackbarView.layoutParams
            if (params is ViewGroup.MarginLayoutParams) {
                val marginSide = (24 * density).toInt()
                val marginBottom = (32 * density).toInt()
                params.setMargins(marginSide, marginSide, marginSide, marginBottom)
                snackbarView.layoutParams = params
            }

            // Create a stylish rounded card shape
            val shape = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(Color.WHITE)
                cornerRadius = 16 * density
                setStroke((1.5f * density).toInt(), Color.parseColor("#E5E5E5"))
            }
            snackbarView.background = shape
            snackbarView.elevation = 8 * density

            val textView =
                snackbarView.findViewById<TextView>(com.google.android.material.R.id.snackbar_text)
            textView.maxLines = Int.MAX_VALUE
            textView.ellipsize = null
            textView.setTextColor(Color.parseColor("#212121"))
            textView.textSize = 15f

            snackbar.setBackgroundTint(Color.WHITE)
            snackbar.setActionTextColor(activity.getColor(R.color.app_theme))

            snackbar.setAction("OK") {
                snackbar.dismiss()
                onOkClick?.invoke()
            }
            snackbar.show()
        }
    }
}