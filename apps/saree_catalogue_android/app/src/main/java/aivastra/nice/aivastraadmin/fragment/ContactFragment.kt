package tryme.nice.trymeadmin.fragment

import android.annotation.SuppressLint
import android.os.Bundle
import androidx.fragment.app.Fragment
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import tryme.nice.trymeadmin.databinding.FragmentContactBinding

class ContactFragment : Fragment() {

    private lateinit var binding: FragmentContactBinding

    companion object {
        private const val CONTACT_URL = "https://tryme.com/contact/"

        @JvmStatic
        fun newInstance() = ContactFragment()
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        binding = FragmentContactBinding.inflate(inflater, container, false)
        return binding.root
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        // Prevent black flash: white background while page loads
        binding.webView.setBackgroundColor(android.graphics.Color.WHITE)
        // Hide WebView until page is ready
        binding.webView.visibility = View.INVISIBLE

        binding.webView.apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false

            // Keep all navigation inside the WebView
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean = false  // false = load inside WebView

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    // Guard: fragment may have been detached before page finished
                    if (!isAdded || this@ContactFragment.view == null) return
                    binding.webView.animate()
                        .alpha(1f)
                        .setDuration(200)
                        .withStartAction { binding.webView.visibility = View.VISIBLE }
                        .start()
                }
            }

            // Drive the ProgressBar from page load progress
            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView, newProgress: Int) {
                    binding.webProgress.progress = newProgress
                    binding.webProgress.visibility =
                        if (newProgress == 100) View.GONE else View.VISIBLE
                }
            }

            // Start fully transparent so the fade-in is smooth
            alpha = 0f
            loadUrl(CONTACT_URL)
        }
    }

    /** Allow back-navigation inside the WebView history */
    fun canGoBack(): Boolean = runCatching { binding.webView.canGoBack() }.getOrDefault(false)

    fun goBack() = runCatching { binding.webView.goBack() }

    override fun onDestroyView() {
        binding.webView.destroy()
        super.onDestroyView()
    }
}