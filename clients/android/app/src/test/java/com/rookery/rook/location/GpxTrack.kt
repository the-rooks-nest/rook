// Mirrors server/src/server/location/gpx.ts (parseGpxTrack) — test-only.
//
// Extracts ordered <trkpt>/<rtept> points with their <time> child parsed to epoch ms (when
// present), handling both self-closing and child-bearing point tags. Used by GpxRouteTest to
// replay the real OSM trace fixtures through the movement classifier.
package com.rookery.rook.location

import java.time.Instant

data class GpxTrackPoint(val lat: Double, val lon: Double, val t: Long?)

private val POINT_RE = Regex(
    """<(?:trkpt|rtept)\b([^>]*?)/>|<(?:trkpt|rtept)\b([^>]*)>([\s\S]*?)</(?:trkpt|rtept)>"""
)
private val LAT_RE = Regex("""\blat\s*=\s*"([-0-9.]+)"""")
private val LON_RE = Regex("""\blon\s*=\s*"([-0-9.]+)"""")
private val TIME_RE = Regex("""<time>([^<]+)</time>""")

fun parseGpxTrack(xml: String): List<GpxTrackPoint> {
    val points = mutableListOf<GpxTrackPoint>()
    for (m in POINT_RE.findAll(xml)) {
        val attrs = m.groupValues[1].ifEmpty { m.groupValues[2] }
        val body = m.groupValues[3]
        val lat = LAT_RE.find(attrs)?.groupValues?.get(1)?.toDoubleOrNull() ?: continue
        val lon = LON_RE.find(attrs)?.groupValues?.get(1)?.toDoubleOrNull() ?: continue
        val t = TIME_RE.find(body)?.groupValues?.get(1)?.let {
            runCatching { Instant.parse(it).toEpochMilli() }.getOrNull()
        }
        points.add(GpxTrackPoint(lat, lon, t))
    }
    return points
}
