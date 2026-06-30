import CoreLocation
import CoreMotion
import Foundation

/// Context captured when the device appears to have meaningfully arrived
/// somewhere, used to ask the server which `loc:` environments are available.
struct ArrivalContext {
    let coordinate: CLLocationCoordinate2D
    let horizontalAccuracy: Double?
    let dwellSeconds: Double?
    let isStationary: Bool
    let speedMetersPerSecond: Double?
}

/// CoreLocation environment provider — the iOS analog of the macOS
/// `ForegroundAppMonitor`. Monitors geofenced places (CLCircularRegion region
/// monitoring, which relaunches the app on entry when Always-authorized) and
/// emits `onRegionChange` with the entered place (or `nil` on leaving all
/// regions). The model turns that into `loc:<slug>` register/unregister.
@MainActor
final class LocationProvider: NSObject, ObservableObject, CLLocationManagerDelegate {
    var onRegionChange: ((Place?) -> Void)?
    var onVisitArrival: ((CLLocationCoordinate2D) -> Void)?
    /// Fires only when the arrival passes the dwell/motion gate (stationary,
    /// not driving) — the trigger for server-side environment identification.
    var onArrival: ((ArrivalContext) -> Void)?

    @Published private(set) var authorizationStatus: CLAuthorizationStatus
    @Published private(set) var currentLocation: CLLocation?
    private(set) var current: Place?

    private let manager = CLLocationManager()
    private var monitoredPlaces: [String: Place] = [:]

    /// Speed (m/s) at or below which we treat the device as effectively settled.
    private let stationarySpeedThreshold: Double = 1.5

    /// Motion activity (used only to reject driving-like arrivals). Requested via a separate
    /// opt-in button in Settings — never on first launch, never bundled with location.
    private let motionManager = CMMotionActivityManager()
    private var latestActivityIsAutomotive = false
    private let motionRequestedKey = "RookMotionRequested"
    /// Whether the user has opted into motion (persisted). Published so the Settings button
    /// can hide once it's been used.
    @Published private(set) var motionRequested: Bool {
        didSet { UserDefaults.standard.set(motionRequested, forKey: motionRequestedKey) }
    }

    /// Whether CoreMotion activity is available on this device (false in the Simulator).
    var motionAvailable: Bool { CMMotionActivityManager.isActivityAvailable() }

    override init() {
        authorizationStatus = manager.authorizationStatus
        motionRequested = UserDefaults.standard.bool(forKey: motionRequestedKey)
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        // Resume motion updates for users who already opted in (no new prompt).
        if motionRequested { startMotionUpdatesIfAvailable() }
    }

    /// Opt into motion-based drive-by filtering. Triggers the OS Motion prompt the first time.
    func requestMotion() {
        if startMotionUpdatesIfAvailable() { motionRequested = true }
    }

    /// Start CoreMotion activity updates. Calling this is what triggers the OS Motion
    /// permission prompt the first time. Returns false when activity isn't available
    /// (e.g. the iOS Simulator never supports it), so callers don't mark it consumed.
    @discardableResult
    private func startMotionUpdatesIfAvailable() -> Bool {
        guard CMMotionActivityManager.isActivityAvailable() else { return false }
        motionManager.startActivityUpdates(to: .main) { [weak self] activity in
            guard let self, let activity else { return }
            self.latestActivityIsAutomotive = activity.automotive && activity.confidence != .low
        }
        return true
    }

    var isAuthorized: Bool {
        authorizationStatus == .authorizedAlways || authorizationStatus == .authorizedWhenInUse
    }

    var hasAlways: Bool {
        authorizationStatus == .authorizedAlways
    }

    func requestAuthorization() {
        // Two-step: When-In-Use first (iOS shows the Always upgrade prompt later).
        if authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else if authorizationStatus == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
    }

    func requestCurrentLocation() {
        manager.requestLocation()
    }

    /// Fire a synthesized stationary arrival (for Simulator/E2E validation, since CLVisit
    /// never fires in the Simulator). Drives the same `onArrival` path as a real dwell.
    func simulateArrival(latitude: Double, longitude: Double) {
        onArrival?(ArrivalContext(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            horizontalAccuracy: 10,
            dwellSeconds: 300,
            isStationary: true,
            speedMetersPerSecond: 0
        ))
    }

    /// CLVisit-based "where you spend time" detection (Phase E). Fires
    /// `onVisitArrival` when you settle at a place — used to suggest naming it.
    func startMonitoringVisits() {
        manager.startMonitoringVisits()
    }

    /// (Re)build the monitored geofences from the user's places.
    func updateMonitoredPlaces(_ places: [Place]) {
        for region in manager.monitoredRegions {
            manager.stopMonitoring(for: region)
        }
        monitoredPlaces.removeAll()
        for place in places {
            let region = CLCircularRegion(
                center: CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude),
                radius: place.radius,
                identifier: place.id
            )
            region.notifyOnEntry = true
            region.notifyOnExit = true
            monitoredPlaces[place.id] = place
            manager.startMonitoring(for: region)
            // Ask immediately whether we're already inside (e.g. app just launched here).
            manager.requestState(for: region)
        }
        // If the place we were "in" is gone, leave it.
        if let current, monitoredPlaces[current.id] == nil {
            self.current = nil
            onRegionChange?(nil)
        }
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            let wasAuthorized = self.isAuthorized
            self.authorizationStatus = status
            if status == .authorizedAlways {
                manager.allowsBackgroundLocationUpdates = true
                manager.startMonitoringVisits()
            }
            if status == .authorizedAlways || status == .authorizedWhenInUse {
                // Grab an initial fix so the "save a place" UI has coordinates
                // and the first Save works without a second tap.
                manager.requestLocation()
                // Newly granted When-In-Use → escalate toward Always, since
                // background geofencing (the headline feature) requires it. iOS
                // shows the upgrade prompt once; PlacesScreen also offers a
                // manual upgrade if the user declines here.
                if !wasAuthorized && status == .authorizedWhenInUse {
                    manager.requestAlwaysAuthorization()
                }
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        Task { @MainActor in
            guard let place = monitoredPlaces[region.identifier] else {
                return
            }
            current = place
            onRegionChange?(place)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        Task { @MainActor in
            if current?.id == region.identifier {
                current = nil
                onRegionChange?(nil)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        Task { @MainActor in
            guard let place = monitoredPlaces[region.identifier] else {
                return
            }
            if state == .inside, current?.id != place.id {
                current = place
                onRegionChange?(place)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else {
            return
        }
        Task { @MainActor in
            currentLocation = last
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        // departureDate == distantFuture ⇒ an arrival (you're still here).
        guard visit.departureDate == Date.distantFuture else {
            return
        }
        let departureDate = visit.departureDate
        let coordinate = visit.coordinate
        let arrivalDate = visit.arrivalDate
        let accuracy = visit.horizontalAccuracy
        Task { @MainActor in
            // Always feed place-suggestion detection on arrival.
            onVisitArrival?(coordinate)

            // Gate the identification trigger: settled (low speed) and not driving.
            guard let context = Self.arrivalContext(
                departureDate: departureDate,
                coordinate: coordinate,
                arrivalDate: arrivalDate,
                horizontalAccuracy: accuracy,
                speed: currentLocation?.speed,
                // Reject driving-past arrivals when Motion is available (granted with Always);
                // false (permissive) otherwise — speed + the server dwell gate still apply.
                isAutomotive: latestActivityIsAutomotive,
                now: Date(),
                stationarySpeedThreshold: stationarySpeedThreshold
            ) else { return }
            onArrival?(context)
        }
    }

    /// Pure dwell/motion gate (no CoreLocation/CoreMotion state) so it can be unit-tested.
    /// Returns the `ArrivalContext` for a settled, not-driving arrival, else `nil`.
    nonisolated static func arrivalContext(
        departureDate: Date,
        coordinate: CLLocationCoordinate2D,
        arrivalDate: Date,
        horizontalAccuracy: CLLocationAccuracy,
        speed: CLLocationSpeed?,
        isAutomotive: Bool,
        now: Date,
        stationarySpeedThreshold: CLLocationSpeed
    ) -> ArrivalContext? {
        // Still here (an arrival, not a departure).
        guard departureDate == Date.distantFuture else { return nil }
        // Settled: speed at/below threshold (unknown speed treated as settled) and not driving.
        let slowOrUnknown = (speed ?? 0) <= stationarySpeedThreshold
        guard slowOrUnknown && !isAutomotive else { return nil }

        let dwellSeconds = arrivalDate == Date.distantPast ? nil : now.timeIntervalSince(arrivalDate)
        return ArrivalContext(
            coordinate: coordinate,
            horizontalAccuracy: horizontalAccuracy >= 0 ? horizontalAccuracy : nil,
            dwellSeconds: dwellSeconds,
            isStationary: true,
            speedMetersPerSecond: (speed ?? -1) >= 0 ? speed : nil
        )
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Best-effort; region monitoring continues.
    }
}
