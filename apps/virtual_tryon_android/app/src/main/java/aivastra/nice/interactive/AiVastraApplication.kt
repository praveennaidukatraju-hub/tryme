package tryme.nice.interactive

import android.app.Application
import tryme.nice.interactive.utils.CrashReporter
import tryme.nice.interactive.utils.NetworkMonitor

class TryMeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashReporter.init()
        NetworkMonitor.initialize(this)
    }
}
