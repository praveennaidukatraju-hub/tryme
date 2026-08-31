package tryme.nice.trymeadmin.app

import android.app.Application
import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import com.example.facewixlatest.ApiUtils.APICaller

class MyAPP : Application(), DefaultLifecycleObserver {

    override fun onCreate() {
        super<Application>.onCreate()
        appContext = applicationContext
        APICaller.init(applicationContext)
    }

    public override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
    }

    companion object {
        var appContext: Context? = null
    }

}
