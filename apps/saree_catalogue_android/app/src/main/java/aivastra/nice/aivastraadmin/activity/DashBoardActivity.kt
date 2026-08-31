package tryme.nice.trymeadmin.activity

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.databinding.ActivityDashBoardBinding
import tryme.nice.trymeadmin.fragment.ContactFragment
import tryme.nice.trymeadmin.fragment.UploadVastraFragment
import tryme.nice.trymeadmin.fragment.VastraProductCategoryFragment
import tryme.nice.trymeadmin.utils.ViewControll
import com.example.facewixlatest.ApiUtils.APICaller

import android.view.MenuItem
import androidx.activity.addCallback
import androidx.navigation.NavController
import androidx.navigation.fragment.NavHostFragment

class DashBoardActivity : AppCompatActivity() {

    lateinit var binding: ActivityDashBoardBinding
    private lateinit var navController: NavController

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDashBoardBinding.inflate(layoutInflater)
        setContentView(binding.root)
        initView()
        // The one authenticated container in the app — registers here so any authed API call,
        // from any fragment/ViewModel, redirects to a clean login instead of leaving the user
        // stuck on a broken screen after the session dies (see APICaller.setSessionExpiredListener).
        APICaller.setSessionExpiredListener {
            runOnUiThread { goToLoginAfterSessionExpired() }
        }
    }

    private fun goToLoginAfterSessionExpired() {
        if (isFinishing || isDestroyed) return
        ViewControll.showMessage(this, "Your session has expired. Please log in again.")
        val intent = Intent(this, LoginActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        startActivity(intent)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        APICaller.setSessionExpiredListener(null)
    }

    private fun initView() {
        // Setup Navigation Controller
        val navHostFragment =
            supportFragmentManager.findFragmentById(R.id.nav_host_fragment) as NavHostFragment
        navController = navHostFragment.navController

        // Select Home tab by default
        binding.bottomNav.llBottomNav.selectedItemId = R.id.btn_upload_fragment

        binding.bottomNav.llBottomNav.setOnItemSelectedListener { item: MenuItem ->
            when (item.itemId) {
                R.id.btn_upload_fragment -> {
                    safeNavigate(R.id.uploadFragment)
                    true
                }
                R.id.btn_product_fragment -> {
                    safeNavigate(R.id.productsFragment)
                    true
                }
                R.id.btn_contact_fragment -> {
                    safeNavigate(R.id.contactFragment)
                    true
                }
                else -> false
            }
        }

        onBackPressedDispatcher.addCallback(this) {
            handleBackPress()
        }
    }

    private fun selectTab(itemId: Int) {
        binding.bottomNav.llBottomNav.selectedItemId = itemId
    }

    /** Prevents IllegalStateException crash when navigating to an already-visible destination */
    private fun safeNavigate(destinationId: Int) {
        try {
            if (navController.currentDestination?.id != destinationId) {
                navController.navigate(destinationId)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun handleBackPress() {
        val fragment = supportFragmentManager.findFragmentById(R.id.nav_host_fragment)
            ?.childFragmentManager?.fragments?.firstOrNull()

        when (fragment) {
            is ContactFragment -> {
                // Let WebView navigate back within its own history first
                if (fragment.canGoBack()) {
                    fragment.goBack()
                } else {
                    selectTab(R.id.btn_upload_fragment)
                    safeNavigate(R.id.uploadFragment)
                }
            }
            is UploadVastraFragment -> {
                fragment.handleBack()
            }
            is VastraProductCategoryFragment -> {
                selectTab(R.id.btn_upload_fragment)
                safeNavigate(R.id.uploadFragment)
            }
            else -> {
                if (!navController.popBackStack()) {
                    finish()
                }
            }
        }
    }

    fun navigateToProductFrag() {
        selectTab(R.id.btn_product_fragment)
        safeNavigate(R.id.productsFragment)
    }
}
