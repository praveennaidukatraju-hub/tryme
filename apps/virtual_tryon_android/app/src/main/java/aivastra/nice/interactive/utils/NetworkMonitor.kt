package tryme.nice.interactive.utils

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Single, process-wide source of truth for internet connectivity. One [ConnectivityManager]
 * callback is registered for the whole app lifetime and republished as [isConnected], so every
 * screen, ViewModel, or repository reacts to the same live value instead of each polling its own
 * `ConnectivityManager` — that's what makes this "dynamic": no explicit check call is needed,
 * state changes push out to every collector the instant Wi-Fi/mobile data actually flips.
 *
 * Uses NET_CAPABILITY_VALIDATED, not just "a network is connected" — a phone joined to a Wi-Fi
 * network with no real internet (captive portal, router with a dead uplink) reports as offline
 * here, matching what the app can actually reach, not just what radio is active.
 */
object NetworkMonitor {
    private lateinit var connectivityManager: ConnectivityManager
    private var isInitialized = false

    // A device can hold multiple validated networks at once (Wi-Fi + cellular during handoff);
    // track the set so losing one doesn't flip isConnected to false while another still works.
    private val validatedNetworks = mutableSetOf<Network>()

    private val _isConnected = MutableStateFlow(true)

    /** True while at least one active network has real, validated internet access. */
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            reconcile(network, connectivityManager.getNetworkCapabilities(network))
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            reconcile(network, capabilities)
        }

        override fun onLost(network: Network) {
            validatedNetworks.remove(network)
            _isConnected.value = validatedNetworks.isNotEmpty()
        }

        private fun reconcile(network: Network, capabilities: NetworkCapabilities?) {
            val hasValidatedInternet = capabilities != null &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            if (hasValidatedInternet) {
                validatedNetworks.add(network)
            } else {
                validatedNetworks.remove(network)
            }
            _isConnected.value = validatedNetworks.isNotEmpty()
        }
    }

    /** Call once, e.g. from `Application.onCreate()`. Safe to call more than once — later calls no-op. */
    fun initialize(context: Context) {
        if (isInitialized) return
        isInitialized = true

        connectivityManager = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        _isConnected.value = isCurrentlyConnected()

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivityManager.registerNetworkCallback(request, networkCallback)
    }

    /**
     * One-shot synchronous check for call sites that can't observe [isConnected] as a flow
     * (e.g. a plain repository function). Returns `true` if queried before [initialize] runs,
     * so a missed init never blocks a caller — the underlying network call will surface its own
     * failure if the device is actually offline.
     */
    fun isCurrentlyConnected(): Boolean {
        if (!isInitialized) return true
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
