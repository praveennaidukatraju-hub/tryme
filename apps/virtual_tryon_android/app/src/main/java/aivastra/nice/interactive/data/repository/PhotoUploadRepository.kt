package tryme.nice.interactive.data.repository

import android.content.Context
import android.net.Uri
import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.PresignRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.UnknownHostException
import java.net.SocketTimeoutException

data class UploadSession(val qrUrl: String, val token: String)

sealed interface PhotoUploadResult<out T> {
    data class Success<T>(val data: T) : PhotoUploadResult<T>
    data class Failure(val message: String) : PhotoUploadResult<Nothing>
}

class PhotoUploadRepository(
    private val service: ApiService = ApiClient.apiService,
    private val storageClient: OkHttpClient = OkHttpClient()
) {
    suspend fun createUploadSession(): PhotoUploadResult<UploadSession> = safeCall {
        val response = service.createUploadSession()
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            error("Unable to create upload session (${response.code()})")
        }
        val token = body.token?.takeIf { it.isNotBlank() }
            ?: body.qrUrl.substringBefore('?').substringAfterLast('/').takeIf { it.isNotBlank() }
            ?: error("Upload session token is missing")
        UploadSession(body.qrUrl, token)
    }

    suspend fun checkUploadStatus(token: String): PhotoUploadResult<String?> = safeCall {
        val response = service.getUploadSessionStatus(token)
        if (!response.isSuccessful) {
            error(if (response.code() == 410) "Upload session expired" else "Unable to check upload status")
        }
        val body = response.body() ?: error("Empty upload status")
        if (body.status.equals("uploaded", true)) body.r2Key else null
    }

    suspend fun uploadJpeg(bytes: ByteArray): PhotoUploadResult<String> = safeCall {
        require(bytes.isNotEmpty()) { "Captured photo is empty" }
        val presignResponse = service.presignCustomerPhoto(
            PresignRequest(contentLength = bytes.size.toLong())
        )
        val presign = presignResponse.body()
        if (!presignResponse.isSuccessful || presign == null) {
            error("Unable to prepare photo upload (${presignResponse.code()})")
        }

        val uploadRequest = Request.Builder()
            .url(presign.uploadUrl)
            .put(bytes.toRequestBody("image/jpeg".toMediaType()))
            .header("Content-Type", "image/jpeg")
            .build()
        storageClient.newCall(uploadRequest).execute().use { response ->
            if (!response.isSuccessful) error("Photo upload failed (${response.code})")
        }
        presign.r2Key
    }

    suspend fun fetchAndCachePhoto(context: Context, r2Key: String): PhotoUploadResult<Uri> = safeCall {
        val response = service.getPhotoUrl(r2Key)
        val body = response.body()
        if (!response.isSuccessful || body == null || body.url.isBlank()) {
            error("Unable to get photo URL (${response.code()})")
        }
        val request = Request.Builder().url(body.url).build()
        val file = File(context.cacheDir, "qr_downloaded_${System.currentTimeMillis()}.jpg")
        storageClient.newCall(request).execute().use { res ->
            if (!res.isSuccessful) error("Failed to download customer photo (${res.code})")
            res.body?.byteStream()?.use { input ->
                FileOutputStream(file).use { output ->
                    input.copyTo(output)
                }
            } ?: error("Downloaded photo body was empty")
        }
        Uri.fromFile(file)
    }

    private suspend fun <T> safeCall(block: suspend () -> T): PhotoUploadResult<T> =
        withContext(Dispatchers.IO) {
            try {
                PhotoUploadResult.Success(block())
            } catch (exception: CancellationException) {
                throw exception
            } catch (exception: Exception) {
                PhotoUploadResult.Failure(exception.toFriendlyMessage())
            }
        }

    // Raw exception text (e.g. "Unable to resolve host ...") is confusing on a customer-facing
    // kiosk screen — surface a plain-language message for connectivity failures instead.
    private fun Exception.toFriendlyMessage(): String = when (this) {
        is UnknownHostException -> "No internet connection. Please check your network and try again."
        is SocketTimeoutException -> "The connection timed out. Please check your network and try again."
        is IOException -> "Network error. Please check your connection and try again."
        else -> message ?: "Something went wrong. Please try again."
    }
}
