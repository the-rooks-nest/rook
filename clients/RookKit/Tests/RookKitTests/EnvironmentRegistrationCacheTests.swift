import XCTest
@testable import RookKit

final class EnvironmentRegistrationCacheTests: XCTestCase {
    func testEncounterRegistersImmediately() {
        var cache = EnvironmentRegistrationCache(ttl: 285, reportInterval: 300)
        let now = Date(timeIntervalSince1970: 1_000)

        let actions = cache.encounter([candidate("web:example.com")], now: now)

        XCTAssertEqual(actions.map(\.kind), [.register])
        XCTAssertEqual(actions.first?.id, "web:example.com")
        XCTAssertEqual(cache.states["web:example.com"]?.discoveredAt, now)
        XCTAssertEqual(cache.states["web:example.com"]?.ttlExpiresAt, now.addingTimeInterval(285))
        XCTAssertEqual(cache.states["web:example.com"]?.nextReportAt, now.addingTimeInterval(300))
    }

    func testRefocusRenewsTtlWithoutReregistering() {
        var cache = EnvironmentRegistrationCache(ttl: 285, reportInterval: 300)
        let start = Date(timeIntervalSince1970: 1_000)
        _ = cache.encounter([candidate("web:example.com")], now: start)

        let refocus = start.addingTimeInterval(200)
        let actions = cache.encounter([candidate("web:example.com")], now: refocus)

        XCTAssertTrue(actions.isEmpty)
        XCTAssertEqual(cache.states["web:example.com"]?.lastVisibleAt, refocus)
        XCTAssertEqual(cache.states["web:example.com"]?.ttlExpiresAt, refocus.addingTimeInterval(285))
        XCTAssertEqual(cache.states["web:example.com"]?.nextReportAt, start.addingTimeInterval(300))
    }

    func testTtlExpiryForgetsWithoutReregistering() {
        var cache = EnvironmentRegistrationCache(ttl: 285, reportInterval: 300)
        let start = Date(timeIntervalSince1970: 1_000)
        _ = cache.encounter([candidate("web:example.com")], now: start)

        let actions = cache.maintain(now: start.addingTimeInterval(286), includeReregistration: true)

        XCTAssertEqual(actions, [.init(kind: .forget, id: "web:example.com")])
        XCTAssertNil(cache.states["web:example.com"])
    }

    func testReregistersWhenStillCachedAndReportIsDue() {
        var cache = EnvironmentRegistrationCache(ttl: 400, reportInterval: 300)
        let start = Date(timeIntervalSince1970: 1_000)
        _ = cache.encounter([candidate("web:example.com")], now: start)

        let actions = cache.maintain(now: start.addingTimeInterval(301), includeReregistration: true)

        XCTAssertEqual(actions.map(\.kind), [.reregister])
        XCTAssertEqual(actions.first?.id, "web:example.com")
        XCTAssertEqual(cache.states["web:example.com"]?.nextReportAt, start.addingTimeInterval(601))
    }

    func testServerReannounceReRegistersEverythingAndResetsReportDeadline() {
        var cache = EnvironmentRegistrationCache(ttl: 285, reportInterval: 300)
        let start = Date(timeIntervalSince1970: 1_000)
        _ = cache.encounter([candidate("app:one"), candidate("web:two/child")], now: start)

        let reannounceAt = start.addingTimeInterval(50)
        let actions = cache.reannounceAll(now: reannounceAt)

        XCTAssertEqual(actions.map(\.kind), [.register, .register])
        XCTAssertEqual(Set(actions.map(\.id)), ["app:one", "web:two/child"])
        XCTAssertEqual(cache.states["app:one"]?.nextReportAt, reannounceAt.addingTimeInterval(300))
        XCTAssertEqual(cache.states["web:two/child"]?.nextReportAt, reannounceAt.addingTimeInterval(300))
    }

    private func candidate(_ id: String) -> EnvironmentRegistrationCache.Candidate {
        .init(id: id, sourceName: id, metadata: [:])
    }
}
