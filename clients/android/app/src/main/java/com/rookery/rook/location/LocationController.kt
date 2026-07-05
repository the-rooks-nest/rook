// Mirrors clients/iphone/Sources/Location/LocationProvider.swift (ArrivalContext, the
// onArrival/onRegionChange/onVisitArrival callbacks, and the pure arrivalContext gate).
//
// Foreground control surface + process-wide singleton. The MovementService (the long-lived
// owner of GPS/accel/classifier) emits arrivals/region-changes through this object; the
// RookViewModel subscribes to the callbacks while the UI is alive. When the process is dead
// the service falls back to its own RookApi (see MovementService) — this indirection is what
// lets the same callback contract as iOS drive the ViewModel without a bound service/AIDL.
package com.rookery.rook.location

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import androidx.core.content.ContextCompat
import com.rookery.rook.model.Place
import com.rookery.rook.net.AuthTokenStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Context captured when the device appears to have arrived somewhere. */
data class ArrivalContext(
    val latitude: Double,
    val longitude: Double,
    val horizontalAccuracy: Double?,
    val dwellSeconds: Double?,
    val isStationary: Boolean,
    val speedMetersPerSecond: Double?
)

/** Coarse authorization state driving the Settings 3-step location flow. */
enum class LocationAuthStatus { DENIED, FOREGROUND, BACKGROUND }

/** Active recording session (null when not recording). */
data class RecordingInfo(val filePath: String, val startedAtMs: Long)

class LocationController private constructor(private val appContext: Context) {

    val placeStore = PlaceStore(appContext.getSharedPreferences(PLACES_PREFS, Context.MODE_PRIVATE))

    // Wired once by RookViewModel.start(); null when no UI is bound (dead-process path).
    var onArrival: ((ArrivalContext) -> Unit)? = null
    var onRegionChange: ((Place?) -> Unit)? = null
    var onVisitArrival: ((Double, Double) -> Unit)? = null

    private val _authorizationStatus = MutableStateFlow(currentAuthStatus())
    val authorizationStatus: StateFlow<LocationAuthStatus> = _authorizationStatus.asStateFlow()

    private val locationSource by lazy { LocationSource.create(appContext) }
    private val _currentLocation = MutableStateFlow<Location?>(null)
    val currentLocation: StateFlow<Location?> = _currentLocation.asStateFlow()

    /** One-shot current fix for the "save this place" flow (PlacesScreen). */
    fun requestCurrentLocation() {
        if (currentAuthStatus() == LocationAuthStatus.DENIED) return
        locationSource.requestCurrent { loc -> if (loc != null) _currentLocation.value = loc }
    }

    private val settings = appContext.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)
    private val authTokenStore = AuthTokenStore(appContext)

    /** Persisted server base URL — the dead-process service reads this to build a RookApi. */
    var baseUrl: String
        get() = settings.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
        set(value) { settings.edit().putString(KEY_BASE_URL, value).apply() }

    /** Persisted auth token (Keystore-backed via EncryptedSharedPreferences). */
    var authToken: String
        get() = authTokenStore.get()
        set(value) { authTokenStore.set(value) }

    fun refreshAuthorizationStatus() {
        _authorizationStatus.value = currentAuthStatus()
    }

    fun startService() {
        ContextCompat.startForegroundService(appContext, Intent(appContext, MovementService::class.java))
    }

    fun stopService() {
        appContext.stopService(Intent(appContext, MovementService::class.java))
    }

    fun startPresenceService() {
        ContextCompat.startForegroundService(appContext, Intent(appContext, com.rookery.rook.RookPresenceService::class.java))
    }

    // MARK: - Recording (accel + GPS capture, RecordingService owns the file)

    private val _recording = MutableStateFlow<RecordingInfo?>(null)
    val recording: StateFlow<RecordingInfo?> = _recording.asStateFlow()

    fun startRecording() {
        ContextCompat.startForegroundService(appContext, Intent(appContext, RecordingService::class.java))
    }

    fun stopRecording() {
        appContext.stopService(Intent(appContext, RecordingService::class.java))
    }

    fun setRecording(info: RecordingInfo) { _recording.value = info }
    fun clearRecording() { _recording.value = null }

    // Called by the service; routes to the ViewModel when bound.
    fun emitArrival(context: ArrivalContext) {
        placeStore.recordVisit(context.latitude, context.longitude) // ungated (mirrors onVisitArrival)
        onVisitArrival?.invoke(context.latitude, context.longitude)
        onArrival?.invoke(context)
    }

    fun emitRegionChange(place: Place?) {
        onRegionChange?.invoke(place)
    }

    /** True when no UI is bound — the service must POST register-location itself. */
    fun hasArrivalSink(): Boolean = onArrival != null

    /** Test/emulator seam: synthesize a settled arrival (mirrors LocationProvider.simulateArrival). */
    fun simulateArrival(latitude: Double, longitude: Double) {
        emitArrival(
            ArrivalContext(
                latitude = latitude,
                longitude = longitude,
                horizontalAccuracy = null,
                dwellSeconds = 300.0,
                isStationary = true,
                speedMetersPerSecond = 0.0
            )
        )
    }

    private fun currentAuthStatus(): LocationAuthStatus {
        val fine = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (fine != PackageManager.PERMISSION_GRANTED && coarse != PackageManager.PERMISSION_GRANTED) {
            return LocationAuthStatus.DENIED
        }
        val background = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        } else true // pre-Q: foreground grant covers background
        return if (background) LocationAuthStatus.BACKGROUND else LocationAuthStatus.FOREGROUND
    }

    companion object {
        const val STATIONARY_SPEED_THRESHOLD = 1.5
        const val DEFAULT_BASE_URL = "http://10.0.2.2:3000"

        private const val PLACES_PREFS = "rook_places"
        private const val SETTINGS_PREFS = "rook_settings"
        private const val KEY_BASE_URL = "baseUrl"

        @Volatile
        private var instance: LocationController? = null

        fun getInstance(context: Context): LocationController =
            instance ?: synchronized(this) {
                instance ?: LocationController(context.applicationContext).also { instance = it }
            }

        /**
         * Pure arrival gate — mirrors LocationProvider.arrivalContext. The settled-speed
         * check and !isAutomotive reject are the load-bearing logic; everything else is
         * field derivation (nil-if-negative accuracy/speed, dwell null-safety). Unknown
         * speed is treated as settled (0). Returns null if it isn't a settled arrival.
         */
        fun arrivalContext(
            latitude: Double,
            longitude: Double,
            arrivalTimeMs: Long?,
            horizontalAccuracy: Double,
            speed: Double?,
            isAutomotive: Boolean,
            nowMs: Long
        ): ArrivalContext? {
            val slowOrUnknown = (speed ?: 0.0) <= STATIONARY_SPEED_THRESHOLD
            if (!(slowOrUnknown && !isAutomotive)) return null
            val dwellSeconds = if (arrivalTimeMs == null) null else (nowMs - arrivalTimeMs) / 1000.0
            return ArrivalContext(
                latitude = latitude,
                longitude = longitude,
                horizontalAccuracy = if (horizontalAccuracy >= 0) horizontalAccuracy else null,
                dwellSeconds = dwellSeconds,
                isStationary = true,
                speedMetersPerSecond = if ((speed ?: -1.0) >= 0) speed else null
            )
        }
    }
}
