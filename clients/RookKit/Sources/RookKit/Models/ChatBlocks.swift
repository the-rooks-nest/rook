import Foundation

public enum ToolBlockStatus: Equatable {
    case pending
    case inputStreaming
    case ready
    case running
    case completed
    case failed
    case cancelled

    public var label: String {
        switch self {
        case .pending: return "Pending"
        case .inputStreaming: return "Preparing"
        case .ready: return "Ready"
        case .running: return "Running"
        case .completed: return "Done"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        }
    }

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled:
            return true
        default:
            return false
        }
    }
}

public struct ToolBlockState: Equatable {
    public var toolCallId: String
    public var title: String
    public var kindLabel: String
    public var status: ToolBlockStatus
    public var arguments: String
    public var output: String

    public init(toolCallId: String, title: String, kindLabel: String, status: ToolBlockStatus, arguments: String, output: String) {
        self.toolCallId = toolCallId
        self.title = title
        self.kindLabel = kindLabel
        self.status = status
        self.arguments = arguments
        self.output = output
    }
}

public struct PlanEntry: Equatable, Identifiable {
    public let id: Int
    public var content: String
    public var priority: String
    public var status: String

    public init(id: Int, content: String, priority: String, status: String) {
        self.id = id
        self.content = content
        self.priority = priority
        self.status = status
    }
}

public struct AcpUsageCost: Equatable {
    public var amount: Double
    public var currency: String

    public init(amount: Double, currency: String) {
        self.amount = amount
        self.currency = currency
    }
}

public struct AcpSessionMode: Equatable, Identifiable {
    public var id: String
    public var name: String
    public var description: String?

    public init(id: String, name: String, description: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
    }
}

public struct AcpModesState: Equatable {
    public var currentModeId: String
    public var availableModes: [AcpSessionMode]

    public init(currentModeId: String, availableModes: [AcpSessionMode]) {
        self.currentModeId = currentModeId
        self.availableModes = availableModes
    }
}

public struct AcpConfigOptionValue: Equatable, Identifiable {
    public var id: String { value }
    public var value: String
    public var name: String
    public var description: String?

    public init(value: String, name: String, description: String? = nil) {
        self.value = value
        self.name = name
        self.description = description
    }
}

public struct AcpConfigOption: Equatable, Identifiable {
    public var id: String
    public var name: String
    public var description: String?
    public var category: String?
    public var type: String
    public var currentValue: String
    public var options: [AcpConfigOptionValue]

    public init(id: String, name: String, description: String? = nil, category: String? = nil, type: String, currentValue: String, options: [AcpConfigOptionValue]) {
        self.id = id
        self.name = name
        self.description = description
        self.category = category
        self.type = type
        self.currentValue = currentValue
        self.options = options
    }
}

public struct AcpPermissionOption: Equatable, Identifiable {
    public var id: String { optionId }
    public var optionId: String
    public var name: String
    public var kind: String

    public init(optionId: String, name: String, kind: String) {
        self.optionId = optionId
        self.name = name
        self.kind = kind
    }
}

public struct AcpPermissionToolCall: Equatable {
    public var toolCallId: String
    public var title: String
    public var kind: String
    public var status: String

    public init(toolCallId: String, title: String, kind: String, status: String) {
        self.toolCallId = toolCallId
        self.title = title
        self.kind = kind
        self.status = status
    }
}

/// Friendly banner shown when the agent enters a `loc:` business environment.
/// `displayName` is the entered business's name (nil -> generic fallback text);
/// `websites` are website URLs (entered business first) used to render a favicon row.
public struct EnvironmentBanner: Equatable {
    public let displayName: String?
    public let websites: [String]

    public init(displayName: String?, websites: [String]) {
        self.displayName = displayName
        self.websites = websites
    }
}

public enum ChatBlockKind: Equatable {
    case user(text: String)
    case assistantText(text: String, streaming: Bool)
    case thinking(text: String, streaming: Bool)
    case tool(ToolBlockState)
    case error(source: String, message: String)
    case system(text: String)
    case plan(entries: [PlanEntry])
    case environment(EnvironmentBanner)
}

public struct ChatBlock: Equatable, Identifiable {
    public let id: String
    public var kind: ChatBlockKind

    public init(id: String, kind: ChatBlockKind) {
        self.id = id
        self.kind = kind
    }
}

/// Flat client-side event union parsed off the ACP websocket — the Swift
/// counterpart of the React client's `AcpClientEvent`.
public enum AcpClientEvent {
    case userMessageChunk(text: String)
    case agentMessageChunk(text: String)
    case agentThoughtChunk(text: String)
    case toolCallStarted(toolCallId: String, title: String, kind: String, status: String, rawInput: String?)
    case toolCallUpdate(toolCallId: String, status: String, toolName: String?, output: String?)
    case toolInputSnapshot(toolCallId: String, toolName: String?, text: String)
    case toolInputDelta(toolCallId: String, toolName: String?, delta: String)
    case toolCallReady(toolCallId: String, toolName: String?)
    case toolOutputSnapshot(toolCallId: String, toolName: String?, text: String)
    case toolOutputDelta(toolCallId: String, toolName: String?, delta: String)
    case permissionRequest(requestId: String, toolCall: AcpPermissionToolCall, options: [AcpPermissionOption])
    case planUpdate(entries: [PlanEntry])
    case usageUpdate(used: Int, size: Int, cost: AcpUsageCost?)
    case modesState(currentModeId: String, availableModes: [AcpSessionMode])
    case currentModeUpdate(modeId: String)
    case configOptionUpdate(configOptions: [AcpConfigOption])
    case runCompleted(stopReason: String)
    case runFailed(message: String)
    case protocolError(message: String)
    case connectionError(message: String)
    case environmentOffered(EnvironmentOffer)
    case environmentOfferResolved(environmentId: String, bundleHash: String)
    case environmentEntered(environmentId: String)
    case environmentExited(environmentId: String, error: String?)
}
