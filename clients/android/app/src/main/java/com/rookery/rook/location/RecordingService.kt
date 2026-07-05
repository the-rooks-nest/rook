// Continuous accelerometer + GPS recorder → one CSV per session, for gathering real
// labeled sensor data to tune the movement classifier (which the GPX fixtures can't do —
// they have no accelerometer).
//
// Timestamps use each event's NATIVE elapsed-realtime nanoseconds — SensorEvent.timestamp
// for accel and Location.elapsedRealtimeNanos for GPS — both on the same monotonic clock,
// so cross-stream timing is hardware-accurate regardless of file layout. The header records
// a wall-clock anchor so the relative ns can be converted to absolute time (e.g. to rebuild
// GPX). Rows are tagged (kind=accel|gps) in a single file: sort by elapsed_ns, filter by kind.
package com.rookery.rook.location

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.ContentValues
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.ContextCompat
import com.rookery.rook.MainActivity
import java.io.BufferedWriter
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RecordingService : Service(), SensorEventListener {

    private lateinit var controller: LocationController
    private var sensorManager: SensorManager? = null
    private var locationSource: LocationSource? = null
    private var writerThread: HandlerThread? = null
    private var writer: BufferedWriter? = null
    private var finalizeSink: (() -> Unit)? = null
    private var sinkUri: android.net.Uri? = null
    private val writeLock = Any()
    private var rowsSinceFlush = 0
    private var rowCount = 0

    // A CSV sink plus a display path, an optional MediaStore URI (10+), and a finalize hook.
    private class Sink(val writer: BufferedWriter, val displayPath: String, val uri: android.net.Uri? = null, val finalize: () -> Unit)

    override fun onCreate() {
        super.onCreate()
        controller = LocationController.getInstance(this)
        sensorManager = getSystemService(SENSOR_SERVICE) as? SensorManager
        createNotificationChannel()
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!hasLocationPermission()) { stopSelf(); return START_NOT_STICKY }
        val sink = openSink() ?: run { stopSelf(); return START_NOT_STICKY }
        writer = sink.writer
        finalizeSink = sink.finalize
        sinkUri = sink.uri
        writeHeader()
        // Clear IS_PENDING now so the file is visible in file managers immediately.
        sinkUri?.let { uri ->
            contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        }
        startForegroundNotification()
        startCapture()
        controller.setRecording(RecordingInfo(sink.displayPath, System.currentTimeMillis()))
        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy: wrote $rowCount rows total")
        runCatching { sensorManager?.unregisterListener(this) }
        runCatching { locationSource?.stop() }
        synchronized(writeLock) {
            runCatching { writer?.flush(); writer?.close() }
            writer = null
        }
        runCatching { finalizeSink?.invoke() } // MediaStore: ensure IS_PENDING clear (may be no-op if cleared early)
        finalizeSink = null
        writerThread?.quitSafely()
        controller.clearRecording()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // Millisecond-precision name → every recording is a distinct file (no overwrite).
    private fun fileName() = "rook-" + SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(Date()) + ".csv"

    private fun openSink(): Sink? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) openDownloadsSink() else openLegacyDownloadsSink()

    // Android 10+: MediaStore Downloads — public Downloads/Rook/, no storage permission.
    private fun openDownloadsSink(): Sink? = runCatching {
        val name = fileName()
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "text/csv")
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Rook")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return@runCatching null
        val stream = contentResolver.openOutputStream(uri) ?: return@runCatching null
        Sink(stream.bufferedWriter(), "Download/Rook/$name", uri) {
            contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        }
    }.getOrNull()

    // Pre-10: direct file in public Downloads/Rook/ (needs WRITE_EXTERNAL_STORAGE, maxSdk 28).
    private fun openLegacyDownloadsSink(): Sink? = runCatching {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Rook").apply { mkdirs() }
        val file = File(dir, fileName())
        Sink(file.bufferedWriter(), file.absolutePath) {}
    }.getOrNull()

    private fun writeHeader() {
        synchronized(writeLock) {
            val w = writer ?: return
            runCatching {
                w.write("# rook recording\n")
                w.write("# started_at_epoch_ms=${System.currentTimeMillis()}\n")
                w.write("# started_at_elapsed_ns=${SystemClock.elapsedRealtimeNanos()}\n")
                w.write("elapsed_ns,kind,lat,lon,alt,speed,accuracy,ax,ay,az\n")
                w.flush()
            }.onFailure { Log.e(TAG, "writeHeader failed", it) }
            Log.i(TAG, "Header written, file visible in Downloads/Rook/")
        }
    }

    private fun startCapture() {
        // Accel on a background thread so 50 Hz file writes never touch the main thread.
        val thread = HandlerThread("rook-rec").also { it.start() }
        writerThread = thread
        val hasAccel = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME, Handler(thread.looper))
            true
        } ?: false
        Log.i(TAG, "startCapture: accel=$hasAccel")
        val src = LocationSource.create(this)
        locationSource = src
        src.start(RECORD_GPS_INTERVAL_MS) { writeGps(it) } // GPS callbacks on the main looper (~1 Hz)
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        writeRow("${event.timestamp},accel,,,,,,${event.values[0]},${event.values[1]},${event.values[2]}")
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun writeGps(loc: Location) {
        val alt = if (loc.hasAltitude()) loc.altitude.toString() else ""
        val speed = if (loc.hasSpeed()) loc.speed.toString() else ""
        val acc = if (loc.hasAccuracy()) loc.accuracy.toString() else ""
        writeRow("${loc.elapsedRealtimeNanos},gps,${loc.latitude},${loc.longitude},$alt,$speed,$acc,,,")
    }

    private fun writeRow(row: String) {
        synchronized(writeLock) {
            val w = writer ?: return
            runCatching {
                w.write(row)
                w.write("\n")
                if (++rowsSinceFlush >= FLUSH_EVERY) { w.flush(); rowsSinceFlush = 0 }
                rowCount++
            }.onFailure { Log.e(TAG, "writeRow failed (row $rowCount)", it) }
        }
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun startForegroundNotification() {
        val launch = Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP }
        val pending = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("Rook — recording")
            .setContentText("Logging accelerometer + GPS")
            .setSmallIcon(com.rookery.rook.R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(pending)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Recording", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Recording accelerometer + GPS to a file"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    companion object {
        private const val TAG = "RookRec"
        private const val CHANNEL_ID = "rook_recording"
        private const val NOTIFICATION_ID = 43
        private const val RECORD_GPS_INTERVAL_MS = 1000L
        private const val FLUSH_EVERY = 128
    }
}
