package tryme.nice.trymeadmin.activity

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.databinding.ActivityLoginBinding
import tryme.nice.trymeadmin.utils.PrefsManager
import tryme.nice.trymeadmin.utils.ViewControll
import tryme.nice.trymeadmin.viewmodels.DeviceLimitState
import tryme.nice.trymeadmin.viewmodels.ProductUploadViewModel
import tryme.nice.interactive.Loader.LoaderManager
import android.app.AlertDialog
import android.content.Intent
import android.provider.Settings
import android.view.View
import androidx.lifecycle.Observer
import androidx.lifecycle.ViewModelProvider

class LoginActivity : AppCompatActivity(), View.OnClickListener {

    private lateinit var binding:ActivityLoginBinding
    private lateinit var productUploadViewModel: ProductUploadViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)
        initView()
    }

    private fun initView() {
        productUploadViewModel = ViewModelProvider(this).get(ProductUploadViewModel::class.java)
        binding.btnLogin.setOnClickListener(this)
    }

    override fun onClick(v: View?) {
        val id = v?.id
        if(id==R.id.btn_login){
            if(checkValidation()){
                callAppLoginAPI()
            }
        }
    }

    private fun checkValidation(): Boolean {
        if(binding.etUsername.text.trim().isEmpty()){
            ViewControll.showMessage(this,"Please enter username")
            return false
        }else if(binding.etPassword.text?.trim().isNullOrEmpty()){
            ViewControll.showMessage(this,"Please enter password")
            return false
        }else{
            return true
        }
    }

    private fun callAppLoginAPI(){
        val deviceId = Settings.Secure.getString(this.contentResolver, Settings.Secure.ANDROID_ID)
        val email = binding.etUsername.text.toString().trim()
        val password = binding.etPassword.text?.toString()?.trim() ?: ""
        LoaderManager.show(this,findViewById(android.R.id.content),false)
        productUploadViewModel.deviceLogin(email, password, deviceId)
        observeLoginResult(deviceId)
    }

    private fun callForceLoginAPI(forceLogoutToken: String, deviceId: String) {
        LoaderManager.show(this, findViewById(android.R.id.content), false)
        resetObserver()
        productUploadViewModel.forceLogoutOtherDeviceAndLogin(forceLogoutToken, deviceId)
        observeLoginResult(deviceId)
    }

    private fun observeLoginResult(deviceId: String) {
        productUploadViewModel.sessionResult.observe(this, Observer { session->
            LoaderManager.remove(this)
            if(session!=null){
                gotoNextScreen()
            }
        })
        productUploadViewModel.deviceLimitReached.observe(this, Observer { state ->
            LoaderManager.remove(this)
            if (state != null) {
                showDeviceLimitDialog(state, deviceId)
            }
        })
        productUploadViewModel.error.observe(this, Observer { errorMsg->
            LoaderManager.remove(this)
            if(errorMsg!=null){
                productUploadViewModel.resetSessionResult()
                ViewControll.showSnackErrorMsg(this,errorMsg)
                resetObserver()
            }
        })
    }

    private fun showDeviceLimitDialog(state: DeviceLimitState, deviceId: String) {
        AlertDialog.Builder(this)
            .setTitle("Device limit reached")
            .setMessage("${state.message}\n\nLogout from the other device and continue here?")
            .setNegativeButton("Cancel") { dialog, _ ->
                dialog.dismiss()
                productUploadViewModel.resetDeviceLimitState()
                resetObserver()
            }
            .setPositiveButton("Logout Other Device") { dialog, _ ->
                dialog.dismiss()
                callForceLoginAPI(state.forceLogoutToken, deviceId)
            }
            .show()
    }

    private fun gotoNextScreen(){
        val intent = Intent(this@LoginActivity, DashBoardActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        startActivity(intent)
        overridePendingTransition(R.anim.fade_and_scale_in, R.anim.fade_and_scale_out)
    }

    private fun resetObserver(){
        productUploadViewModel.error.removeObservers(this)
        productUploadViewModel.sessionResult.removeObservers(this)
        productUploadViewModel.deviceLimitReached.removeObservers(this)
    }
}