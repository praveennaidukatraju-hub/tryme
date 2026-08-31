package tryme.nice.trymeadmin.activity

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.utils.PrefsManager
import android.content.Intent

class SplashScreenActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_splash_screen)
        initView()
    }

    private fun initView() {
        if(PrefsManager.isUserExist){
            val intent = Intent(this@SplashScreenActivity, DashBoardActivity::class.java)
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
            startActivity(intent)
            overridePendingTransition(R.anim.fade_and_scale_in, R.anim.fade_and_scale_out)
        }else{
            val intent = Intent(this@SplashScreenActivity, LoginActivity::class.java)
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
            startActivity(intent)
            overridePendingTransition(R.anim.fade_and_scale_in, R.anim.fade_and_scale_out)
        }
    }
}