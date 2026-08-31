package tryme.nice.interactive

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color as ComposeColor
import androidx.core.view.WindowCompat
import androidx.navigation.compose.rememberNavController
import tryme.nice.interactive.data.repository.AppVideoRepository
import tryme.nice.interactive.data.session.SessionManager
import tryme.nice.interactive.navigation.AppNavGraph
import tryme.nice.interactive.ui.components.NoInternetBanner
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.update.InAppUpdateChecker

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawableResource(android.R.color.black)
        SessionManager.initialize(applicationContext)

        // Enable edge-to-edge with transparent status bar and white status bar icons
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
        )

        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContent {
            TryMeTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = ComposeColor.Black
                ) {
                    Box(modifier = Modifier.fillMaxSize()) {
                        val navController = rememberNavController()

                        AppNavGraph(
                            navController = navController,
                            modifier = Modifier.fillMaxSize()
                        )

                        InAppUpdateChecker()

                        // Observes NetworkMonitor directly and lives above every screen, so
                        // connectivity loss/recovery is visible app-wide without each screen
                        // wiring its own check.
                        NoInternetBanner(modifier = Modifier.align(Alignment.TopCenter))
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        // Force the loading video to re-download on the next app open (rather than relying on
        // whatever's left in cacheDir) so a backend video change shows up without a reinstall.
        AppVideoRepository.clearCache(applicationContext)
        super.onDestroy()
    }
}
