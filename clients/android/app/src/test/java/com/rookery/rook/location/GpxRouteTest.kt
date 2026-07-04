// Replays the real OSM GPX trace fixtures through the Android movement classifier
// (MovementClassifier.emit + VoteDebouncer) and asserts the debounced movement matches each
// trace's known nature. Same fixtures the server validates its parser against
// (server/src/server/location/test-fixtures/gpx/), copied into test resources.
//
// GPX carries no accelerometer, so this validates the SPEED-driven classification only:
// - the VoteDebouncer must reject transient GPS speed spikes (no false Driving on hikes),
// - a sustained vehicular segment must produce Driving,
// - a slow walk (< 2.2 m/s) with no accel reads Stationary (the documented caveat).
// Assertions were validated against the actual replay output before being locked (e.g.
// tn-maryville-trails contains a real drive-to-the-trailhead segment → it DOES yield Driving).
package com.rookery.rook.location

import com.rookery.rook.movement.AccelStats
import com.rookery.rook.movement.MovementClassifier
import com.rookery.rook.movement.MovementType
import com.rookery.rook.movement.VoteDebouncer
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GpxRouteTest {

    private data class Replay(val types: List<MovementType>, val pointCount: Int, val maxSpeedMps: Double) {
        fun hasDriving() = types.contains(MovementType.Driving)
    }

    private fun readFixture(name: String): String =
        javaClass.getResourceAsStream("/gpx/$name")?.bufferedReader()?.use { it.readText() }
            ?: error("missing fixture: $name")

    private fun replay(name: String): Replay {
        val points = parseGpxTrack(readFixture(name)).filter { it.t != null }
        val debouncer = VoteDebouncer()
        val types = mutableListOf<MovementType>()
        var maxSpeed = 0.0
        var prev: GpxTrackPoint? = null
        for (p in points) {
            val a = prev; prev = p
            val ta = a?.t; val tb = p.t
            if (a == null || ta == null || tb == null) continue
            val dtMs = tb - ta
            if (dtMs <= 0 || dtMs > MAX_GAP_MS) continue // unreliable-gap gate
            val speed = Geo.metersBetween(a.lat, a.lon, p.lat, p.lon) / (dtMs / 1000.0)
            if (speed > maxSpeed) maxSpeed = speed
            val vote = MovementClassifier.emit(speed, gpsAccuracyM = null, nearestRoad = null, accel = AccelStats.EMPTY)
            types.add(debouncer.tick(vote, tb))
        }
        return Replay(types, points.size, maxSpeed)
    }

    @Test
    fun debouncerRejectsTransientSpeedSpikesOnHikes() {
        // These hikes contain GPS speed spikes above the driving floor, yet a spike isn't
        // sustained long enough to clear the debouncer's 3-vote + latency gate — so no Driving.
        for (f in SPIKY_HIKES) {
            val r = replay(f)
            assertTrue("$f should contain a >driving-floor spike", r.maxSpeedMps > MovementClassifier.DRIVING_FLOOR_MPS)
            assertFalse("$f (a hike) must not debounce to Driving despite spikes", r.hasDriving())
        }
    }

    @Test
    fun sustainedVehicularSegmentsYieldDriving() {
        // The roads trace is a drive; tn-maryville-trails embeds a real drive-to-trailhead leg.
        for (f in listOf(ROADS, MIXED_WITH_DRIVE)) {
            assertTrue("$f should debounce to Driving over its vehicular segment", replay(f).hasDriving())
        }
    }

    @Test
    fun slowHikeWithoutAccelReadsNonDriving() {
        // maxSpeed ~3.4 m/s throughout; with no accelerometer the slow-walk falls to the
        // accel-only fallback and reads Stationary. The point: it never falsely reads Driving.
        val r = replay(SLOW_HIKE)
        assertFalse("$SLOW_HIKE must not read Driving", r.hasDriving())
        assertTrue("$SLOW_HIKE should be dominated by Stationary (no-accel slow walk)",
            r.types.count { it == MovementType.Stationary } > r.types.size / 2)
    }

    @Test
    fun allTracesParseManyTimestampedPoints() {
        for (f in ALL) {
            val n = parseGpxTrack(readFixture(f)).count { it.t != null }
            assertTrue("$f should parse >100 timestamped points (got $n)", n > 100)
        }
    }

    companion object {
        private const val MAX_GAP_MS = 15_000L
        private const val ROADS = "tn-middle-tennessee-3605997.gpx"
        private const val MIXED_WITH_DRIVE = "tn-maryville-trails-1283272.gpx"
        private const val SLOW_HIKE = "tn-maryville-hike-1063250.gpx"
        private val SPIKY_HIKES = listOf(
            "nc-mine-creek-1184364.gpx",
            "nc-sals-branch-1191748.gpx",
            "nc-umstead-trails-1184467.gpx"
        )
        private val ALL = SPIKY_HIKES + listOf(ROADS, MIXED_WITH_DRIVE, SLOW_HIKE)
    }
}
