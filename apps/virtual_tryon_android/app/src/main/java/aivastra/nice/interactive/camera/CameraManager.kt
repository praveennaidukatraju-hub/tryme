package tryme.nice.interactive.camera

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

object CameraManager {
    fun createPhotoUri(context: Context): Uri {
        val directory = File(context.cacheDir, "captured_photos").apply { mkdirs() }
        val photo = File.createTempFile("customer_", ".jpg", directory)
        return FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            photo
        )
    }
}
