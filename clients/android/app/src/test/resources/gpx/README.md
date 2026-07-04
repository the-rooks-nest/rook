# GPX trace fixtures (copied from the server)

Real OpenStreetMap public GPS traces, copied verbatim from
`server/src/server/location/test-fixtures/gpx/` so `GpxRouteTest` can replay them through the
Android movement classifier hermetically (no cross-module build path). They are immutable
third-party downloads — keep them byte-identical to the server copies.

Licensed **ODbL** (OpenStreetMap GPS trace data). See the server directory's `README.md` for
the per-file OSM trace ids, uploaders, and areas. Five are foot routes (hikes/trails in
NC/TN); `tn-middle-tennessee-3605997.gpx` is a Nashville roads (vehicular) trace.
