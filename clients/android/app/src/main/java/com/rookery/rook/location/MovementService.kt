// Mirrors clients/iphone/Sources/Location/LocationProvider.swift — the arrival/region
// engine — but the trigger is a movement classifier over a continuous Fused-GPS + accel
// stream (user directive: persistent-notification foreground service, NOT geofences).
//
// The service is the long-lived owner of GPS + accelerometer + MovementClassifier +
// VoteDebouncer. Per fix it: emit()s a vote, debounces it, checks point-in-circle region
// membership against PlaceStore.places, and — on the debounced transition into Stationary —
// fires an arrival. Arrivals route through LocationController when the UI is bound; when the
// process was restarted headless, the service POSTs register-location itself.
package com.rookery.rook.location

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity
import com.rookery.rook.MainActivity
import com.rookery.rook.model.IdentifyAvailableRequest
import com.rookery.rook.model.Place
import com.rookery.rook.movement.AccelStats
import com.rookery.rook.movement.MovementClassifier
import com.rookery.rook.movement.MovementType
import com.rookery.rook.movement.VoteDebouncer
import com.rookery.rook.net.AuthTokenStore
import com.rookery.rook.net.RookApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant
import kotlin.math.sqrt

class MovementService : Service(), SensorEventListener {

    private lateinit var controller: LocationController
    private lateinit var locationSource: LocationSource
    private var sensorManager: SensorManager? = null
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val classifier = MovementClassifier
    private val debouncer = VoteDebouncer()

    // Accelerometer ring buffers (last ~ACCEL_CAPACITY samples), guarded by `accelLock`.
    private val accelLock = Any()
    private val ax = ArrayDeque<Float>()
    private val ay = ArrayDeque<Float>()
    private val az = ArrayDeque<Float>()

    @Volatile private var isAutomotive = false
    private var lastStable: MovementType = MovementType.Unknown
    private var rawStationarySinceMs: Long? = null
    private var currentRegion: Place? = null

    override fun onCreate() {
        super.onCreate()
        controller = LocationController.getInstance(this)
        locationSource = LocationSource.create(this) // Fused when Play Services present, else LocationManager
        sensorManager = getSystemService(SENSOR_SERVICE) as? SensorManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Activity-recognition callbacks are delivered back into the service.
        if (intent != null && ActivityRecognitionResult.hasResult(intent)) {
            ActivityRecognitionResult.extractResult(intent)?.let { updateAutomotive(it) }
            return START_STICKY
        }

        // Must hold location permission before startForeground(TYPE_LOCATION) on API 34+
        // (a START_STICKY restart after a permission revoke can land here without it).
        if (!hasLocationPermission()) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundNotification()
        startSensors()
        return START_STICKY
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        runCatching { locationSource.stop() }
        runCatching { sensorManager?.unregisterListener(this) }
        runCatching { ActivityRecognition.getClient(this).removeActivityUpdates(activityPendingIntent()) }
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // MARK: - Sensor wiring

    private fun startSensors() {
        locationSource.start(GPS_INTERVAL_MS) { handleFix(it) }

        sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }

        // ARC automotive signal — optional; needs Play Services + ACTIVITY_RECOGNITION.
        // Absent → isAutomotive stays false (the classifier still detects Driving from speed).
        val arcPermitted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED
        if (LocationSource.playServicesAvailable(this) && arcPermitted) {
            runCatching {
                ActivityRecognition.getClient(this).requestActivityUpdates(GPS_INTERVAL_MS, activityPendingIntent())
            }
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        synchronized(accelLock) {
            ax.addLast(event.values[0]); ay.addLast(event.values[1]); az.addLast(event.values[2])
            while (ax.size > ACCEL_CAPACITY) { ax.removeFirst(); ay.removeFirst(); az.removeFirst() }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun updateAutomotive(result: ActivityRecognitionResult) {
        val vehicle = result.probableActivities.firstOrNull { it.type == DetectedActivity.IN_VEHICLE }
        isAutomotive = vehicle != null && vehicle.confidence >= AUTOMOTIVE_CONFIDENCE
    }

    // MARK: - Per-fix pipeline

    private fun handleFix(location: Location) {
        val stats = snapshotAccelStats()
        val speed = if (location.hasSpeed()) location.speed.toDouble() else null
        val accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else null
        val vote = classifier.emit(speed, accuracy, nearestRoad = null, accel = stats)

        val nowMs = SystemClock.elapsedRealtime()
        // Track the start of the current raw-stationary run for dwell estimation.
        rawStationarySinceMs = if (vote.type == MovementType.Stationary) rawStationarySinceMs ?: nowMs else null

        val stable = debouncer.tick(vote, nowMs)
        updateRegion(location)

        if (stable == MovementType.Stationary && lastStable != MovementType.Stationary) {
            fireArrival(location)
        }
        lastStable = stable
    }

    private fun updateRegion(location: Location) {
        val place = controller.placeStore.places.value
            .filter { Geo.metersBetween(it.latitude, it.longitude, location.latitude, location.longitude) <= it.radius }
            .minByOrNull { Geo.metersBetween(it.latitude, it.longitude, location.latitude, location.longitude) }
        if (place?.id != currentRegion?.id) {
            currentRegion = place
            // Region registration (preview → register loc:<slug>) needs the ViewModel; when
            // headless it re-announces on next app open. ponytail: dead-process region
            // register is deferred to reconnect, arrival identify still fires below.
            controller.emitRegionChange(place)
        }
    }

    private fun fireArrival(location: Location) {
        val context = LocationController.arrivalContext(
            latitude = location.latitude,
            longitude = location.longitude,
            arrivalTimeMs = rawStationarySinceMs,
            horizontalAccuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else -1.0,
            speed = if (location.hasSpeed()) location.speed.toDouble() else null,
            isAutomotive = isAutomotive,
            nowMs = SystemClock.elapsedRealtime()
        ) ?: return

        if (controller.hasArrivalSink()) {
            controller.emitArrival(context) // UI bound: ViewModel POSTs + renders the banner.
        } else {
            controller.placeStore.recordVisit(context.latitude, context.longitude)
            postArrivalDirectly(context) // headless: POST register-location ourselves.
        }
    }

    // Dead-process path — no ViewModel, so build our own RookApi from persisted prefs.
    private fun postArrivalDirectly(context: ArrivalContext) {
        val api = RookApi(baseUrl = controller.baseUrl, authToken = AuthTokenStore(this).get())
        serviceScope.launch {
            runCatching {
                api.registerLocation(
                    IdentifyAvailableRequest(
                        latitude = context.latitude,
                        longitude = context.longitude,
                        horizontalAccuracy = context.horizontalAccuracy,
                        source = "visit",
                        dwellSeconds = context.dwellSeconds,
                        isStationary = context.isStationary,
                        speedMetersPerSecond = context.speedMetersPerSecond,
                        observedAt = Instant.now().toString()
                    )
                )
            }
        }
    }

    private fun snapshotAccelStats(): AccelStats {
        val x: FloatArray; val y: FloatArray; val z: FloatArray
        synchronized(accelLock) {
            x = ax.toFloatArray(); y = ay.toFloatArray(); z = az.toFloatArray()
        }
        if (x.isEmpty()) return AccelStats.EMPTY
        return AccelStats.calculate(x, y, z, ACCEL_SAMPLE_RATE_HZ)
    }

    private fun activityPendingIntent(): PendingIntent {
        val intent = Intent(this, MovementService::class.java)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getService(this, ARC_REQUEST_CODE, intent, flags)
    }

    // MARK: - Foreground notification

    private fun startForegroundNotification() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val launch = Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP }
        val pending = PendingIntent.getActivity(
            this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        return builder
            .setContentTitle("Rook")
            .setContentText("Detecting places you visit")
            .setSmallIcon(com.rookery.rook.R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(pending)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Location", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps detecting places while Rook is in the background"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private companion object {
        const val CHANNEL_ID = "rook_location"
        const val NOTIFICATION_ID = 42
        const val ARC_REQUEST_CODE = 4201
        const val GPS_INTERVAL_MS = 7000L
        const val ACCEL_SAMPLE_RATE_HZ = 50
        const val ACCEL_CAPACITY = 200 // ~4 s at 50 Hz
        const val AUTOMOTIVE_CONFIDENCE = 50
    }
}
