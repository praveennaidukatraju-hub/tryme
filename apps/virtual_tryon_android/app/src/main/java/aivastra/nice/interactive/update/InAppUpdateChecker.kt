package tryme.nice.interactive.update

import android.app.Activity
import android.content.IntentSender
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import tryme.nice.interactive.ui.components.AppDialog
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability

private const val TAG = "InAppUpdateChecker"

/**
 * Checks Google Play (not our own backend) for a newer published version and, if one
 * is available, lets Play run its own "Update available" flow in the background
 * (flexible update - the app stays usable while it downloads). Once the download
 * finishes we show our own "Restart to finish updating" prompt, since Play never
 * restarts the app on its own.
 */
@Composable
fun InAppUpdateChecker() {
    val context = LocalContext.current
    val activity = context as? Activity ?: return
    val appUpdateManager = remember { AppUpdateManagerFactory.create(activity) }
    var showRestartDialog by remember { mutableStateOf(false) }

    val updateLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) {
            Log.w(TAG, "Update flow did not complete: resultCode=${result.resultCode}")
        }
    }

    fun checkForUpdate() {
        appUpdateManager.appUpdateInfo
            .addOnSuccessListener { info ->
                when {
                    info.installStatus() == InstallStatus.DOWNLOADED -> {
                        showRestartDialog = true
                    }
                    info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE &&
                        info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE) -> {
                        try {
                            appUpdateManager.startUpdateFlowForResult(
                                info,
                                updateLauncher,
                                AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build()
                            )
                        } catch (e: IntentSender.SendIntentException) {
                            Log.w(TAG, "Failed to start in-app update flow", e)
                        }
                    }
                }
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "Failed to fetch app update info", e)
            }
    }

    // Initial check on first composition (app cold start).
    LaunchedEffect(Unit) {
        checkForUpdate()
    }

    // Re-check whenever the app comes back to the foreground - catches an update that
    // finished downloading while backgrounded, or a flow interrupted mid-flight.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                checkForUpdate()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // Live progress listener - flips the restart prompt on the moment the download
    // finishes, without waiting for the next foreground check.
    DisposableEffect(appUpdateManager) {
        val listener = InstallStateUpdatedListener { state ->
            if (state.installStatus() == InstallStatus.DOWNLOADED) {
                showRestartDialog = true
            }
        }
        appUpdateManager.registerListener(listener)
        onDispose { appUpdateManager.unregisterListener(listener) }
    }

    if (showRestartDialog) {
        AppDialog(
            title = "Update Ready",
            message = "A new version has finished downloading. Restart now to finish updating.",
            icon = Icons.Default.Refresh,
            confirmText = "Restart",
            cancelText = "Later",
            onConfirm = {
                showRestartDialog = false
                appUpdateManager.completeUpdate()
                    .addOnFailureListener { e -> Log.w(TAG, "Failed to complete update", e) }
            },
            onDismiss = { showRestartDialog = false }
        )
    }
}
