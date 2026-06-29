# GPX trace fixtures (real OSM public traces)

Real-world GPX traces used by `gpx.test.ts` to exercise `parseGpxPoints` against
varied creators/formats. All are public GPS traces from OpenStreetMap, in **NC/TN**
(the two states whose ptiles `buildings_v8` index is currently valid, so they also
work with the `trace:map` diagnostic).

Source: `https://www.openstreetmap.org/traces/<id>/data` (originals were bzip2-compressed
and have been decompressed here). OSM GPS trace data is licensed **ODbL**.

| File | OSM trace id | Uploader | Area |
|------|--------------|----------|------|
| tn-middle-tennessee-3605997.gpx | 3605997 | V-JF | Nashville, TN (roads) |
| tn-maryville-trails-1283272.gpx | 1283272 | Jack Kittle | Maryville, TN |
| tn-maryville-hike-1063250.gpx | 1063250 | Jack Kittle | Maryville, TN (hike) |
| nc-umstead-trails-1184467.gpx | 1184467 | runbananas | Umstead / Raleigh, NC |
| nc-mine-creek-1184364.gpx | 1184364 | runbananas | Raleigh, NC |
| nc-sals-branch-1191748.gpx | 1191748 | runbananas | Raleigh, NC |

Re-download example:
```
curl -fsSL "https://www.openstreetmap.org/traces/1184467/data" | bunzip2 > nc-umstead-trails-1184467.gpx
```
