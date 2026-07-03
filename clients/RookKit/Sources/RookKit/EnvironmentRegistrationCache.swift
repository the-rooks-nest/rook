import Foundation

public struct EnvironmentRegistrationCache {
    public struct Candidate: Equatable {
        public let id: String
        public let sourceName: String
        public let metadata: [String: JSONValue]

        public init(id: String, sourceName: String, metadata: [String: JSONValue]) {
            self.id = id
            self.sourceName = sourceName
            self.metadata = metadata
        }
    }

    public struct State: Equatable {
        public var sourceName: String
        public var metadata: [String: JSONValue]
        public var discoveredAt: Date
        public var lastVisibleAt: Date
        public var ttlExpiresAt: Date
        public var nextReportAt: Date
    }

    public enum ActionKind: Equatable {
        case register
        case reregister
        case forget
    }

    public struct Action: Equatable {
        public let kind: ActionKind
        public let id: String
        public let sourceName: String?
        public let metadata: [String: JSONValue]?

        public init(kind: ActionKind, id: String, sourceName: String? = nil, metadata: [String: JSONValue]? = nil) {
            self.kind = kind
            self.id = id
            self.sourceName = sourceName
            self.metadata = metadata
        }
    }

    public private(set) var states: [String: State] = [:]

    private let ttl: TimeInterval
    private let reportInterval: TimeInterval
    private let depth: (String) -> Int

    public init(
        ttl: TimeInterval,
        reportInterval: TimeInterval,
        depth: @escaping (String) -> Int = { _ in 0 }
    ) {
        self.ttl = ttl
        self.reportInterval = reportInterval
        self.depth = depth
    }

    public mutating func encounter(_ candidates: [Candidate], now: Date) -> [Action] {
        var actions: [Action] = []

        for candidate in candidates {
            if var existing = states[candidate.id] {
                existing.sourceName = candidate.sourceName
                existing.metadata = candidate.metadata
                existing.lastVisibleAt = now
                existing.ttlExpiresAt = now.addingTimeInterval(ttl)
                states[candidate.id] = existing
                continue
            }

            var metadata = candidate.metadata
            metadata["registeredAt"] = .string(Self.iso8601String(from: now))
            states[candidate.id] = State(
                sourceName: candidate.sourceName,
                metadata: metadata,
                discoveredAt: now,
                lastVisibleAt: now,
                ttlExpiresAt: now.addingTimeInterval(ttl),
                nextReportAt: now.addingTimeInterval(reportInterval)
            )
            actions.append(Action(kind: .register, id: candidate.id, sourceName: candidate.sourceName, metadata: metadata))
        }

        return actions
    }

    public mutating func maintain(now: Date, includeReregistration: Bool) -> [Action] {
        var actions: [Action] = []

        for id in states.keys.sorted(by: { depth($0) > depth($1) }) {
            guard let state = states[id] else {
                continue
            }

            if state.ttlExpiresAt <= now {
                states.removeValue(forKey: id)
                actions.append(Action(kind: .forget, id: id))
                continue
            }

            guard includeReregistration, state.nextReportAt <= now else {
                continue
            }

            var refreshed = state
            refreshed.metadata["registeredAt"] = .string(Self.iso8601String(from: now))
            refreshed.nextReportAt = now.addingTimeInterval(reportInterval)
            states[id] = refreshed
            actions.append(Action(kind: .reregister, id: id, sourceName: refreshed.sourceName, metadata: refreshed.metadata))
        }

        return actions
    }

    public mutating func reannounceAll(now: Date) -> [Action] {
        var actions: [Action] = []

        for id in states.keys.sorted(by: { depth($0) < depth($1) }) {
            guard var state = states[id] else {
                continue
            }
            state.metadata["registeredAt"] = .string(Self.iso8601String(from: now))
            state.nextReportAt = now.addingTimeInterval(reportInterval)
            states[id] = state
            actions.append(Action(kind: .register, id: id, sourceName: state.sourceName, metadata: state.metadata))
        }

        return actions
    }

    private static let iso8601Formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func iso8601String(from date: Date) -> String {
        iso8601Formatter.string(from: date)
    }
}
