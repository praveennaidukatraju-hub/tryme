package tryme.nice.interactive.utils

import com.google.gson.Gson
import com.google.gson.JsonObject
import retrofit2.Response

object ErrorParser {
    /**
     * Parses a Retrofit failure response into a human-readable error string.
     * Extracts top-level "message" (String or Array), "error" object/string, or "detail".
     * Never returns raw JSON strings or empty responses.
     */
    fun <T> parseErrorMessage(response: Response<T>, defaultMsg: String = "Something went wrong"): String {
        val errorJson = try {
            response.errorBody()?.string()
        } catch (_: Exception) {
            null
        }
        return parseErrorMessage(errorJson, defaultMsg)
    }

    /**
     * Parses a raw JSON error string into a clean user-facing error message.
     */
    fun parseErrorMessage(errorJson: String?, defaultMsg: String = "Something went wrong"): String {
        if (errorJson.isNullOrBlank()) return defaultMsg

        // If it doesn't look like JSON (e.g. plain text error message), return it directly if clean
        val trimmed = errorJson.trim()
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
            return if (trimmed.length < 200) trimmed else defaultMsg
        }

        return try {
            val json = Gson().fromJson(trimmed, JsonObject::class.java) ?: return defaultMsg

            // 1. Check top-level "message" field
            if (json.has("message")) {
                val elem = json.get("message")
                if (elem.isJsonPrimitive && elem.asJsonPrimitive.isString) {
                    val msg = elem.asString.trim()
                    if (msg.isNotBlank() && !msg.startsWith("{")) return msg
                } else if (elem.isJsonArray) {
                    val arr = elem.asJsonArray
                    val joined = arr.mapNotNull { if (it.isJsonPrimitive) it.asString.trim() else null }
                        .filter { it.isNotBlank() }
                        .joinToString(", ")
                    if (joined.isNotBlank()) return joined
                }
            }

            // 2. Check "error" field (can be an object or a primitive string)
            if (json.has("error")) {
                val elem = json.get("error")
                if (elem.isJsonObject) {
                    val errObj = elem.asJsonObject
                    if (errObj.has("message") && errObj.get("message").isJsonPrimitive) {
                        val msg = errObj.get("message").asString.trim()
                        if (msg.isNotBlank()) return msg
                    }
                    if (errObj.has("code") && errObj.get("code").isJsonPrimitive) {
                        val code = errObj.get("code").asString.trim()
                        if (code.isNotBlank()) return code
                    }
                } else if (elem.isJsonPrimitive && elem.asJsonPrimitive.isString) {
                    val errStr = elem.asString.trim()
                    if (errStr.isNotBlank() && !errStr.startsWith("{")) return errStr
                }
            }

            // 3. Check "detail" or "msg" field
            if (json.has("detail") && json.get("detail").isJsonPrimitive) {
                val detail = json.get("detail").asString.trim()
                if (detail.isNotBlank()) return detail
            }
            if (json.has("msg") && json.get("msg").isJsonPrimitive) {
                val msg = json.get("msg").asString.trim()
                if (msg.isNotBlank()) return msg
            }

            defaultMsg
        } catch (_: Exception) {
            defaultMsg
        }
    }
}
