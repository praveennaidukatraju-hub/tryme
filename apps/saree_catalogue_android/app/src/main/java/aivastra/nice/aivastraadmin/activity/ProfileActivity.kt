package tryme.nice.trymeadmin.activity

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.databinding.ActivityProfileBinding
import tryme.nice.trymeadmin.dialog.ShowErrorAlertDialog
import tryme.nice.trymeadmin.utils.PrefsManager
import tryme.nice.trymeadmin.utils.ViewControll
import tryme.nice.trymeadmin.viewmodels.ProductUploadViewModel
import tryme.nice.interactive.Loader.LoaderManager
import android.content.Intent
import androidx.lifecycle.ViewModelProvider

class ProfileActivity : AppCompatActivity() {

    private lateinit var binding:ActivityProfileBinding
    private lateinit var productUploadViewmodel: ProductUploadViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityProfileBinding.inflate(layoutInflater)
        setContentView(binding.root)
        initView()
    }

    private fun initView() {
        productUploadViewmodel = ViewModelProvider(this).get(ProductUploadViewModel::class.java)
        if(PrefsManager.isUserExist){
            val session = PrefsManager.session
            binding.txtUsername.text = session.user.displayName ?: session.user.email
            binding.txtEmail.text = session.user.email
        }
        binding.imgBack.setOnClickListener {
            onBackPressedDispatcher.onBackPressed()
        }
        binding.btnLogout.setOnClickListener {
            showLogoutAlertDialog()
        }
    }

    private fun showLogoutAlertDialog(){
        val showErrorAlertDialog = ShowErrorAlertDialog(ShowErrorAlertDialog.ImageSourceType.FromDrawbleRes(R.drawable.ic_profile_stylish),
            getString(R.string.logout),
            getString(R.string.alert_logout),
            getString(R.string.cancel),
            getString(R.string.logout)){

            LoaderManager.show(this,findViewById(android.R.id.content),false)
            productUploadViewmodel.logout {
                LoaderManager.remove(this)
                ViewControll.showMessage(this,"User logout successfully")
                val intent = Intent(this@ProfileActivity, LoginActivity::class.java)
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                startActivity(intent)
                overridePendingTransition(R.anim.fade_and_scale_in, R.anim.fade_and_scale_out)
            }
        }
        showErrorAlertDialog.show(supportFragmentManager, "ShowErrorAlertDialog")
    }
}