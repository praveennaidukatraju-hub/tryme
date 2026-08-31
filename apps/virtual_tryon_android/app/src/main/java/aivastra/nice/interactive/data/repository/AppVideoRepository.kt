package tryme.nice.interactive.data.repository

import android.content.Context
import android.net.Uri
import android.util.Log
import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

class AppVideoRepository(
    private val apiService: ApiService = ApiClient.apiService,
    private val storageClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
) {
    companion object {
        // Fixed filename (not timestamped) — each session's fetch overwrites the previous one.
        private const val CACHE_FILE_NAME = "session_app_video.mp4"

        // Called from MainActivity.onDestroy() so a backend video change is picked up on the
        // very next app open instead of only after the OS happens to reclaim cacheDir - closing
        // the app is what's supposed to force a fresh download, not just a lucky low-storage purge.
        fun clearCache(context: Context) {
            try {
                File(context.cacheDir, CACHE_FILE_NAME).delete()
                File(context.cacheDir, "$CACHE_FILE_NAME.tmp").delete()
            } catch (e: Exception) {
                Log.e("AppVideoRepository", "Failed to clear cached app video", e)
            }
        }
    }

    suspend fun fetchAppVideoUri(context: Context): Uri? = withContext(Dispatchers.IO) {
        try {
            val response = apiService.getAppVideoConfig()
            val videoUrl = response.body()?.videoUrl
            if (!response.isSuccessful || videoUrl.isNullOrBlank()) return@withContext null

            val cacheFile = File(context.cacheDir, CACHE_FILE_NAME)
            val tempFile = File(context.cacheDir, "$CACHE_FILE_NAME.tmp")
            val request = Request.Builder().url(videoUrl).build()
            storageClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.e("AppVideoRepository", "Video download HTTP error: ${response.code}")
                    return@withContext null
                }
                response.body?.byteStream()?.use { input ->
                    FileOutputStream(tempFile).use { output -> input.copyTo(output) }
                } ?: return@withContext null
            }
            tempFile.renameTo(cacheFile)
            Uri.fromFile(cacheFile)
        } catch (e: Exception) {
            Log.e("AppVideoRepository", "Failed to fetch/cache app video", e)
            null
        }
    }
}
