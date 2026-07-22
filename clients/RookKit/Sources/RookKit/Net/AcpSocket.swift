import Foundation

/// Connection-level JSON-RPC 2.0 ACP websocket client for `/api/ws`.
/// One logical connection can list, create, load, and prompt many sessions.
@MainActor
public final class AcpSocket {
    public var onEvent: ((AcpClientEvent) -> Void)?
    public var onConnectionChange: ((Bool) -> Void)?

    public private(set) var isConnected = false
    public private(set) var currentSessionId: String?

    private var task: URLSessionWebSocketTask?
    private var connectTask: Task<[String: Any], Error>?
    private var nextRequestID = 0
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var pendingPromptIds: Set<String> = []
    private var pendingUserMessageEchoes: [String] = []
    private var lastToolInputSnapshots: [String: String] = [:]
    private var lastToolOutputSnapshots: [String: String] = [:]
    private var runtimeIDs: [String] = []
    private var defaultRuntimeID: String?
    private var environmentOfferExtensionEnabled = false

    public init() {}

    public func connect(request socketRequest: URLRequest) async throws -> [String: Any] {
        if let connectTask {
            return try await connectTask.value
        }
        if task != nil {
            return [:]
        }
        let task = Task<[String: Any], Error> { @MainActor in
            let initialized = try await openAndInitialize(socketRequest: socketRequest)
            self.connectTask = nil
            return initialized
        }
        connectTask = task
        return try await task.value
    }

    public func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connectTask = nil
        currentSessionId = nil
        runtimeIDs = []
        defaultRuntimeID = nil
        environmentOfferExtensionEnabled = false
        pendingPromptIds.removeAll()
        pendingUserMessageEchoes.removeAll()
        lastToolInputSnapshots.removeAll()
        lastToolOutputSnapshots.removeAll()
        let waiting = pending
        pending = [:]
        setConnected(false)
        waiting.values.forEach { $0.resume(throwing: SocketError.disconnected) }
    }

    public func runtimeCatalog() -> [String] { runtimeIDs }
    public func defaultRuntime() -> String? { defaultRuntimeID }

    public func selectSession(_ sessionId: String?) {
        currentSessionId = sessionId
    }

    public func sessionList() async throws -> [AgentSessionSummary] {
        let result = try await request(method: "session/list", params: [:])
        let sessions = (result["sessions"] as? [Any]) ?? []
        return sessions.compactMap { item in
            guard let raw = item as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: raw),
                  let json = try? JSONDecoder().decode(JSONValue.self, from: data) else {
                return nil
            }
            return AgentSessionSummary(raw: json)
        }
    }

    public func createSession(runtimeId: String, title: String, cwd: String) async throws -> String {
        let result = try await request(method: "session/new", params: [
            "cwd": cwd,
            "mcpServers": [],
            "_meta": [
                "runtimeId": runtimeId,
                "title": title,
            ],
        ])
        guard let sessionId = result["sessionId"] as? String else {
            throw SocketError.server("Server returned no sessionId")
        }
        currentSessionId = sessionId
        _ = try await request(method: "session/load", params: ["sessionId": sessionId])
        return sessionId
    }

    public func loadSession(_ sessionId: String) async throws {
        _ = try await request(method: "session/load", params: ["sessionId": sessionId])
        currentSessionId = sessionId
    }

    public func sendCancel() {
        guard let sessionId = currentSessionId else { return }
        Task {
            _ = try? await request(method: "session/cancel", params: ["sessionId": sessionId], expectsResponse: false)
        }
    }

    public func sendPrompt(text: String) {
        guard let sessionId = currentSessionId else {
            onEvent?(.connectionError(message: "Not connected to a session"))
            return
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        nextRequestID += 1
        let requestId = "prompt-\(nextRequestID)"
        pendingPromptIds.insert(requestId)
        pendingUserMessageEchoes.append(trimmed)
        Task {
            do {
                let _ = try await sendRequest(id: requestId, method: "session/prompt", params: [
                    "sessionId": sessionId,
                    "prompt": [["type": "text", "text": trimmed]],
                ])
            } catch {
                pendingPromptIds.remove(requestId)
                onEvent?(.runFailed(message: error.localizedDescription))
            }
        }
    }

    public func setMode(_ modeId: String) async throws {
        guard let sessionId = currentSessionId else { throw SocketError.disconnected }
        let result = try await request(method: "session/set_mode", params: ["sessionId": sessionId, "modeId": modeId])
        if let modes = parseModesState(result["modes"]) {
            onEvent?(.modesState(currentModeId: modes.currentModeId, availableModes: modes.availableModes))
        } else {
            onEvent?(.currentModeUpdate(modeId: modeId))
        }
    }

    public func setConfigOption(configId: String, value: String) async throws {
        guard let sessionId = currentSessionId else { throw SocketError.disconnected }
        let result = try await request(method: "session/set_config_option", params: ["sessionId": sessionId, "configId": configId, "value": value])
        if let configOptions = parseConfigOptions(result["configOptions"]) {
            onEvent?(.configOptionUpdate(configOptions: configOptions))
        }
    }

    public func respondToPermissionRequest(requestId: String, optionId: String?) throws {
        guard let task else { throw SocketError.disconnected }
        var outcome: [String: Any] = ["outcome": "cancelled"]
        if let optionId { outcome = ["outcome": "selected", "optionId": optionId] }
        sendFrame(["jsonrpc": "2.0", "id": requestId, "result": ["outcome": outcome]], over: task)
    }

    public func resolveEnvironmentOffer(environmentId: String, bundleHash: String, decision: String) async throws {
        guard environmentOfferExtensionEnabled, let sessionId = currentSessionId else { throw SocketError.disconnected }
        _ = try await request(method: "_com.rookkeeper/environment_offer_resolve", params: [
            "sessionId": sessionId,
            "environmentId": environmentId,
            "bundleHash": bundleHash,
            "decision": decision,
        ])
    }

    public func request(method: String, params: [String: Any], expectsResponse: Bool = true) async throws -> [String: Any] {
        if task == nil {
            throw SocketError.disconnected
        }
        nextRequestID += 1
        return try await sendRequest(id: "rpc-\(nextRequestID)", method: method, params: params, expectsResponse: expectsResponse)
    }

    private func sendRequest(id: String, method: String, params: [String: Any], expectsResponse: Bool = true) async throws -> [String: Any] {
        guard let task else { throw SocketError.disconnected }
        if !expectsResponse {
            sendFrame(["jsonrpc": "2.0", "method": method, "params": params], over: task)
            return [:]
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            sendFrame(["jsonrpc": "2.0", "id": id, "method": method, "params": params], over: task) { [weak self] error in
                guard let self, let error else { return }
                Task { @MainActor in
                    self.pending.removeValue(forKey: id)?.resume(throwing: error)
                }
            }
        }
    }

    private func openAndInitialize(socketRequest: URLRequest) async throws -> [String: Any] {
        disconnect()
        let task = URLSession.shared.webSocketTask(with: socketRequest)
        self.task = task
        task.resume()
        receiveLoop(task)
        let initialize = try await request(method: "initialize", params: [
            "protocolVersion": 1,
            "clientCapabilities": [
                "_meta": [
                    "com.rookkeeper": [
                        "environmentOffers": true,
                    ],
                ],
            ],
            "clientInfo": ["name": "rook", "title": "Rook", "version": "0.1.0"],
        ])
        let meta = initialize["_meta"] as? [String: Any]
        runtimeIDs = (meta?["runtimeIds"] as? [String]) ?? []
        defaultRuntimeID = meta?["defaultRuntimeId"] as? String
        if let ext = meta?["com.rookkeeper"] as? [String: Any], ext["environmentOffers"] != nil {
            environmentOfferExtensionEnabled = true
        }
        setConnected(true)
        return initialize
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            while self?.task === task {
                do {
                    let incoming = try await task.receive()
                    guard let self else { return }
                    let text: String
                    switch incoming {
                    case .string(let value): text = value
                    case .data(let value): text = String(decoding: value, as: UTF8.self)
                    @unknown default: continue
                    }
                    self.handle(text)
                } catch {
                    self?.handleDisconnect(error)
                    return
                }
            }
        }
    }

    private func handleDisconnect(_ error: Error) {
        guard task != nil else { return }
        task = nil
        connectTask = nil
        setConnected(false)
        let waiting = pending
        pending = [:]
        waiting.values.forEach { $0.resume(throwing: error) }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        if frame["method"] as? String == "session/request_permission",
           let requestId = frame["id"],
           let params = frame["params"] as? [String: Any],
           let toolCall = parsePermissionToolCall(params["toolCall"]),
           let options = parsePermissionOptions(params["options"]) {
            onEvent?(.permissionRequest(requestId: String(describing: requestId), toolCall: toolCall, options: options))
            return
        }

        if frame["method"] as? String == "session/update",
           let params = frame["params"] as? [String: Any],
           let update = params["update"] as? [String: Any] {
            handleUpdate(update)
            return
        }

        if frame["method"] as? String == "_com.rookkeeper/environment_offer",
           let params = frame["params"] as? [String: Any] {
            handleEnvironmentOffer(params)
            return
        }

        if frame["method"] as? String == "_com.rookkeeper/environment_offer_resolved",
           let params = frame["params"] as? [String: Any],
           let environmentId = params["environmentId"] as? String,
           let bundleHash = params["bundleHash"] as? String {
            onEvent?(.environmentOfferResolved(environmentId: environmentId, bundleHash: bundleHash))
            return
        }

        if let id = frame["id"] {
            let key = String(describing: id)
            let isPromptResponse = pendingPromptIds.contains(key)
            if let continuation = pending.removeValue(forKey: key) {
                if let result = frame["result"] as? [String: Any] {
                    continuation.resume(returning: result)
                    if isPromptResponse {
                        pendingPromptIds.remove(key)
                        onEvent?(.runCompleted(stopReason: result["stopReason"] as? String ?? "end_turn"))
                    }
                } else if let error = frame["error"] as? [String: Any] {
                    continuation.resume(throwing: SocketError.server(error["message"] as? String ?? "Request failed"))
                    if isPromptResponse {
                        pendingPromptIds.remove(key)
                        onEvent?(.runFailed(message: error["message"] as? String ?? "Run failed"))
                    }
                } else {
                    continuation.resume(returning: [:])
                    if isPromptResponse {
                        pendingPromptIds.remove(key)
                        onEvent?(.runCompleted(stopReason: "end_turn"))
                    }
                }
                return
            }

            if isPromptResponse {
                pendingPromptIds.remove(key)
                if let result = frame["result"] as? [String: Any] {
                    onEvent?(.runCompleted(stopReason: result["stopReason"] as? String ?? "end_turn"))
                } else if let error = frame["error"] as? [String: Any] {
                    onEvent?(.runFailed(message: error["message"] as? String ?? "Run failed"))
                }
                return
            }
        }

        if let error = frame["error"] as? [String: Any] {
            onEvent?(.connectionError(message: error["message"] as? String ?? "Server error"))
        }
    }

    private func handleEnvironmentOffer(_ params: [String: Any]) {
        guard let environmentId = params["environmentId"] as? String,
              let bundleId = params["bundleId"] as? String,
              let bundleHash = params["bundleHash"] as? String else {
            return
        }
        onEvent?(.environmentOffered(EnvironmentOffer(
            environmentId: environmentId,
            displayName: params["displayName"] as? String,
            bundleId: bundleId,
            bundleHash: bundleHash,
            sourceName: params["sourceName"] as? String,
            canonicalSourceUrl: params["canonicalSourceUrl"] as? String,
            skills: params["skills"] as? [String] ?? [],
            mcpServers: params["mcpServers"] as? [String] ?? [],
            apps: params["apps"] as? [String] ?? []
        )))
    }

    private func handleUpdate(_ update: [String: Any]) {
        guard let kind = update["sessionUpdate"] as? String else { return }
        switch kind {
        case "user_message_chunk":
            if let text = contentText(update["content"]) {
                if pendingUserMessageEchoes.first == text { pendingUserMessageEchoes.removeFirst() }
                else { onEvent?(.userMessageChunk(text: text)) }
            }
        case "agent_message_chunk":
            if let text = contentText(update["content"]) { onEvent?(.agentMessageChunk(text: text)) }
        case "agent_thought_chunk":
            if let text = contentText(update["content"]) { onEvent?(.agentThoughtChunk(text: text)) }
        case "tool_call":
            guard let toolCallId = update["toolCallId"] as? String else { return }
            let rawInput = stringifyToolPayload(update["rawInput"])
            if let rawInput { lastToolInputSnapshots[toolCallId] = rawInput }
            onEvent?(.toolCallStarted(toolCallId: toolCallId, title: update["title"] as? String ?? "Tool", kind: update["kind"] as? String ?? "", status: update["status"] as? String ?? "pending", rawInput: rawInput))
        case "tool_call_update":
            guard let toolCallId = update["toolCallId"] as? String else { return }
            if let inputText = stringifyToolPayload(update["rawInput"]) {
                lastToolInputSnapshots[toolCallId] = inputText
                onEvent?(.toolInputSnapshot(toolCallId: toolCallId, toolName: nil, text: inputText))
            }
            let outputSnapshot = contentItemsText(update["content"]) ?? stringifyToolPayload(update["rawOutput"])
            if let outputSnapshot {
                lastToolOutputSnapshots[toolCallId] = outputSnapshot
                onEvent?(.toolOutputSnapshot(toolCallId: toolCallId, toolName: nil, text: outputSnapshot))
            }
            onEvent?(.toolCallUpdate(toolCallId: toolCallId, status: update["status"] as? String ?? "in_progress", toolName: nil, output: nil))
        case "plan":
            guard let rawEntries = update["entries"] as? [[String: Any]] else { return }
            onEvent?(.planUpdate(entries: rawEntries.enumerated().map { index, entry in PlanEntry(id: index, content: entry["content"] as? String ?? "", priority: entry["priority"] as? String ?? "medium", status: entry["status"] as? String ?? "pending") }))
        case "usage_update":
            guard let used = intValue(update["used"]), let size = intValue(update["size"]) else { return }
            onEvent?(.usageUpdate(used: used, size: size, cost: parseUsageCost(update["cost"])))
        case "current_mode_update":
            if let modeId = update["modeId"] as? String { onEvent?(.currentModeUpdate(modeId: modeId)) }
        case "config_option_update":
            if let configOptions = parseConfigOptions(update["configOptions"]) { onEvent?(.configOptionUpdate(configOptions: configOptions)) }
        default:
            break
        }
    }

    private func setConnected(_ connected: Bool) {
        guard isConnected != connected else { return }
        isConnected = connected
        onConnectionChange?(connected)
    }

    private func sendFrame(_ frame: [String: Any], over task: URLSessionWebSocketTask, completion: @escaping (Error?) -> Void = { _ in }) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let json = String(data: data, encoding: .utf8) else {
            completion(SocketError.encoding)
            return
        }
        task.send(.string(json), completionHandler: completion)
    }

    private func contentText(_ value: Any?) -> String? {
        guard let content = value as? [String: Any] else { return nil }
        return content["text"] as? String
    }

    private func contentItemsText(_ value: Any?) -> String? {
        guard let items = value as? [[String: Any]] else { return nil }
        let texts = items.compactMap { item -> String? in
            if let nested = item["content"] as? [String: Any] { return nested["text"] as? String }
            return item["text"] as? String
        }.filter { !$0.isEmpty }
        return texts.isEmpty ? nil : texts.joined(separator: "\n")
    }

    private func stringifyToolPayload(_ value: Any?) -> String? {
        guard let value else { return nil }
        if let text = value as? String { return text }
        if let dict = value as? [String: Any], dict.isEmpty { return nil }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted]),
              let text = String(data: data, encoding: .utf8) else {
            return String(describing: value)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == "{}" ? nil : trimmed
    }

    private func parseUsageCost(_ value: Any?) -> AcpUsageCost? {
        guard let dict = value as? [String: Any], let amount = doubleValue(dict["amount"]), let currency = dict["currency"] as? String else { return nil }
        return AcpUsageCost(amount: amount, currency: currency)
    }

    private func parseModesState(_ value: Any?) -> AcpModesState? {
        guard let dict = value as? [String: Any], let currentModeId = dict["currentModeId"] as? String, let availableModesValue = dict["availableModes"] as? [[String: Any]] else { return nil }
        return AcpModesState(currentModeId: currentModeId, availableModes: availableModesValue.compactMap(parseSessionMode))
    }

    private func parseSessionMode(_ value: [String: Any]) -> AcpSessionMode? {
        guard let id = value["id"] as? String, let name = value["name"] as? String else { return nil }
        return AcpSessionMode(id: id, name: name, description: value["description"] as? String)
    }

    private func parseConfigOptions(_ value: Any?) -> [AcpConfigOption]? {
        guard let items = value as? [[String: Any]] else { return nil }
        return items.compactMap(parseConfigOption)
    }

    private func parseConfigOption(_ value: [String: Any]) -> AcpConfigOption? {
        guard let id = value["id"] as? String, let name = value["name"] as? String, let type = value["type"] as? String, let currentValue = value["currentValue"] as? String, let optionsValue = value["options"] as? [[String: Any]] else { return nil }
        return AcpConfigOption(id: id, name: name, description: value["description"] as? String, category: value["category"] as? String, type: type, currentValue: currentValue, options: optionsValue.compactMap(parseConfigOptionValue))
    }

    private func parseConfigOptionValue(_ value: [String: Any]) -> AcpConfigOptionValue? {
        guard let rawValue = value["value"] as? String, let name = value["name"] as? String else { return nil }
        return AcpConfigOptionValue(value: rawValue, name: name, description: value["description"] as? String)
    }

    private func parsePermissionToolCall(_ value: Any?) -> AcpPermissionToolCall? {
        guard let dict = value as? [String: Any], let toolCallId = dict["toolCallId"] as? String, let title = dict["title"] as? String, let kind = dict["kind"] as? String, let status = dict["status"] as? String else { return nil }
        return AcpPermissionToolCall(toolCallId: toolCallId, title: title, kind: kind, status: status)
    }

    private func parsePermissionOptions(_ value: Any?) -> [AcpPermissionOption]? {
        guard let items = value as? [[String: Any]] else { return nil }
        return items.compactMap { item in
            guard let optionId = item["optionId"] as? String, let name = item["name"] as? String, let kind = item["kind"] as? String else { return nil }
            return AcpPermissionOption(optionId: optionId, name: name, kind: kind)
        }
    }

    private func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let number = value as? NSNumber { return number.intValue }
        return nil
    }

    private func doubleValue(_ value: Any?) -> Double? {
        if let double = value as? Double { return double }
        if let int = value as? Int { return Double(int) }
        if let number = value as? NSNumber { return number.doubleValue }
        return nil
    }

    public enum SocketError: LocalizedError {
        case disconnected
        case encoding
        case server(String)

        public var errorDescription: String? {
            switch self {
            case .disconnected: return "Not connected to Rook server"
            case .encoding: return "Failed to encode websocket request"
            case .server(let message): return message
            }
        }
    }
}
