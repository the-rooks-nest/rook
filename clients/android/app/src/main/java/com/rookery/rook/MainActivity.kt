package com.rookery.rook

import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.rookery.rook.location.LocationController
import com.rookery.rook.net.RookApi
import com.rookery.rook.ui.theme.RookTheme

// Mirrors clients/iphone/Sources/Views/RootView.swift (navigation host, wired up by RookApp.kt)
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // run-rook.sh's android target passes this via `adb shell am start --es server_url <url>`
        // when --server-url is given, mirroring iOS's ROOK_SERVER_BASE_URL launch-env override.
        val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL)
        // Process-wide singleton owning PlaceStore + the arrival callbacks; the MovementService
        // shares this instance while the app is alive.
        val controller = LocationController.getInstance(applicationContext)
        serverUrl?.let { controller.baseUrl = it }
        controller.startPresenceService()
        // DEBUG/E2E: `am start --es simulate_arrival "lat,lon"` fires a synthetic arrival —
        // the Android analog of iOS's ROOK_SIMULATE_ARRIVAL. Debuggable builds only (≈ #if DEBUG).
        val simulateArrival = if (isDebuggable()) parseLatLon(intent.getStringExtra(EXTRA_SIMULATE_ARRIVAL)) else null
        setContent {
            RookTheme {
                val viewModel: RookViewModel = viewModel(
                    factory = viewModelFactory {
                        initializer {
                            RookViewModel(
                                api = RookApi(controller.baseUrl, controller.authToken),
                                locationController = controller
                            )
                        }
                    }
                )
                RookApp(viewModel, simulateArrival)
            }
        }
    }

    private fun isDebuggable(): Boolean =
        (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    companion object {
        private const val EXTRA_SERVER_URL = "server_url"
        private const val EXTRA_SIMULATE_ARRIVAL = "simulate_arrival"

        private fun parseLatLon(raw: String?): Pair<Double, Double>? {
            val parts = raw?.split(",") ?: return null
            if (parts.size != 2) return null
            val lat = parts[0].trim().toDoubleOrNull() ?: return null
            val lon = parts[1].trim().toDoubleOrNull() ?: return null
            return lat to lon
        }
    }
}
