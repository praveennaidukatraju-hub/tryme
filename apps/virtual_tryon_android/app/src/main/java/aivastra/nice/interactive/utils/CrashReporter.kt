package tryme.nice.interactive.utils

import android.util.Log
import tryme.nice.interactive.BuildConfig
import com.google.firebase.crashlytics.FirebaseCrashlytics

/**
 * Single entry point for Firebase Crashlytics. Keeps call sites free of direct
 * FirebaseCrashlytics references so the reporting backend can change in one place,
 * and always logs locally too since collection is disabled in debug builds.
 */
object CrashReporter {
    private const val TAG = "CrashReporter"

    private val crashlytics: FirebaseCrashlytics by lazy { FirebaseCrashlytics.getInstance() }

    /**
     * Debug builds run on developer/kiosk-test devices constantly; reporting every one
     * of those would drown out real user crashes in the release Crashlytics dashboard.
     */
    fun init() {
        crashlytics.setCrashlyticsCollectionEnabled(!BuildConfig.DEBUG)
        crashlytics.setCustomKey("build_type", if (BuildConfig.DEBUG) "debug" else "release")
        crashlytics.setCustomKey("version_name", BuildConfig.VERSION_NAME)
        crashlytics.setCustomKey("version_code", BuildConfig.VERSION_CODE)
    }

    /** Associates subsequent crashes/logs with this device's signed-in user (opaque id, never email). */
    fun setUserId(userId: String?) {
        crashlytics.setUserId(userId.orEmpty())
    }

    /** Breadcrumb visible in the crash/non-fatal timeline leading up to the event. */
    fun log(message: String) {
        crashlytics.log(message)
    }

    fun setCustomKey(key: String, value: String) {
        crashlytics.setCustomKey(key, value)
    }

    /** Reports a caught exception as a non-fatal issue without crashing the app. */
    fun recordException(throwable: Throwable, tag: String = TAG) {
        Log.e(tag, throwable.message, throwable)
        crashlytics.recordException(throwable)
    }
}
