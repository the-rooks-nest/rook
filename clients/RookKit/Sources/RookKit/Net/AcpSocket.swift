import Foundation

/// JSON-RPC 2.0 websocket client for `/api/ws?sessionId=...`.
///
/// Sends ACP requests over the websocket and reduces ACP-shaped notifications
/// into flat `AcpClientEvent`s. Mirrors the web client's behavior closely:
/// `user_message_chunk` echoes and `_rookery_run_*`/`_rookery_status_changed`
/// updates are ignored; prompt completion comes from the JSON-RPC response for
/// the corresponding `session/prompt` request id.
@MainActor
public final class AcpSocket {
    public var onEvent: ((AcpClientEvent) -> Void)?
    public var onConnectionChange: ((Bool) -> Void)?

    public private(set) var isConnected = false

    private var task: URLSessionWebSocketTask?
    private var sessionId: String?
    private var generation = 0
    private var requestCounter = 0
    private var pendingPromptIds: Set<String> = []
    private var pendingRequests: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var pendingUserMessageEchoes: [String] = []
    private var lastToolInputSnapshots: [String: String] = [:]
    private var lastToolOutputSnapshots: [String: String] = [:]

    public init() {}

    public func connect(sessionId: String, request: URLRequest) {
        teardown()
        generation += 1
        let currentGeneration = generation
        self.sessionId = sessionId

        let task = URLSession.shared.webSocketTask(with: request)
        self.task = task
        task.resume()
        setConnected(true)
        receiveLoop(task: task, generation: currentGeneration)
    }

    public func disconnect() {
        teardown()
    }

    /// Cancel the in-flight turn (ACP `session/cancel` notification).
    public func sendCancel() {
        guard let task, let sessionId else {
            return
        }
        sendFrame([
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": ["sessionId": sessionId],
        ], over: task)
    }

    public func sendPrompt(text: String) {
        guard let task, let sessionId else {
            onEvent?(.connectionError(message: "Not connected to the session"))
            return
        }
        requestCounter += 1
        let requestId = "prompt-\(requestCounter)"
        pendingPromptIds.insert(requestId)
        pendingUserMessageEchoes.append(text)
        sendFrame([
            "jsonrpc": "2.0",
            "id": requestId,
            "method": "session/prompt",
            "params": [
                "sessionId": sessionId,
                "prompt": [["type": "text", "text": text]],
            ],
        ], over: task) { [weak self] error in
            guard let error else {
                return
            }
            Task { @MainActor in
                self?.handleTransportFailure(error)
            }
        }
    }

    public func sendSteeringMessage(text: String) async throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        _ = try await sendSocketRequest(method: "_rookery/steering_prompt", params: ["text": text])
    }

    public func setMode(_ modeId: String) async throws {
        let result = try await sendSocketRequest(method: "session/set_mode", params: ["modeId": modeId])
        if let modes = parseModesState(result["modes"]) {
            onEvent?(.modesState(currentModeId: modes.currentModeId, availableModes: modes.availableModes))
        } else {
            onEvent?(.currentModeUpdate(modeId: modeId))
        }
    }

    public func setConfigOption(configId: String, value: String) async throws {
        let result = try await sendSocketRequest(method: "session/set_config_option", params: ["configId": configId, "value": value])
        if let configOptions = parseConfigOptions(result["configOptions"]) {
            onEvent?(.configOptionUpdate(configOptions: configOptions))
        }
    }

    public func respondToPermissionRequest(requestId: String, optionId: String?) throws {
        guard let task else {
            throw SocketRequestError.notConnected
        }
        var outcome: [String: Any] = ["outcome": "cancelled"]
        if let optionId {
            outcome = ["outcome": "selected", "optionId": optionId]
        }
        sendFrame([
            "jsonrpc": "2.0",
            "id": requestId,
            "result": ["outcome": outcome],
        ], over: task)
    }

    // MARK: - Receive

    private func receiveLoop(task: URLSessionWebSocketTask, generation: Int) {
        Task { [weak self] in
            while true {
                guard let self, self.generation == generation else {
                    return
                }
                do {
                    let message = try await task.receive()
                    guard self.generation == generation else {
                        return
                    }
                    self.handleMessage(message)
                } catch {
                    if self.generation == generation {
                        self.handleTransportFailure(error)
                    }
                    return
                }
            }
        }
    }

    private func handleTransportFailure(_ error: Error) {
        guard isConnected else {
            return
        }
        pendingPromptIds.removeAll()
        let continuations = pendingRequests
        pendingRequests.removeAll()
        task = nil
        setConnected(false)
        continuations.values.forEach { $0.resume(throwing: error) }
    }

    private func setConnected(_ connected: Bool) {
        guard isConnected != connected else {
            return
        }
        isConnected = connected
        onConnectionChange?(connected)
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let value):
            text = value
        case .data(let value):
            text = String(data: value, encoding: .utf8) ?? ""
        @unknown default:
            return
        }
        guard let data = text.data(using: .utf8),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        handleFrame(frame)
    }

    private func handleFrame(_ frame: [String: Any]) {
        if frame["method"] as? String == "session/request_permission",
           let requestId = frame["id"],
           let params = frame["params"] as? [String: Any],
           let toolCall = parsePermissionToolCall(params["toolCall"]),
           let options = parsePermissionOptions(params["options"]) {
            onEvent?(.permissionRequest(
                requestId: String(describing: requestId),
                toolCall: toolCall,
                options: options
            ))
            return
        }

        if frame["method"] as? String == "session/update",
           let params = frame["params"] as? [String: Any],
           let update = params["update"] as? [String: Any] {
            handleUpdate(update)
            return
        }

        if let requestId = frame["id"] {
            let requestIdString = String(describing: requestId)
            if let continuation = pendingRequests.removeValue(forKey: requestIdString) {
                if let result = frame["result"] as? [String: Any] {
                    continuation.resume(returning: result)
                } else if let error = frame["error"] as? [String: Any] {
                    continuation.resume(throwing: SocketRequestError.server(error["message"] as? String ?? "Request failed"))
                } else {
                    continuation.resume(returning: [:])
                }
                return
            }

            if pendingPromptIds.contains(requestIdString) {
                pendingPromptIds.remove(requestIdString)
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

    private func handleUpdate(_ update: [String: Any]) {
        guard let kind = update["sessionUpdate"] as? String else {
            return
        }
        switch kind {
        case "user_message_chunk":
            if let text = contentText(update["content"]) {
                if pendingUserMessageEchoes.first == text {
                    pendingUserMessageEchoes.removeFirst()
                } else {
                    onEvent?(.userMessageChunk(text: text))
                }
            }
        case "agent_message_chunk":
            if let text = contentText(update["content"]) {
                onEvent?(.agentMessageChunk(text: text))
            }
        case "agent_thought_chunk":
            if let text = contentText(update["content"]) {
                onEvent?(.agentThoughtChunk(text: text))
            }
        case "tool_call":
            guard let toolCallId = update["toolCallId"] as? String else {
                return
            }
            let meta = rookeryMeta(update)
            let rawInput = stringifyToolPayload(update["rawInput"]) ?? stringifyToolPayload(meta?["rawInput"])
            if let rawInput {
                lastToolInputSnapshots[toolCallId] = rawInput
            }
            onEvent?(.toolCallStarted(
                toolCallId: toolCallId,
                title: update["title"] as? String ?? "Tool",
                kind: update["kind"] as? String ?? "",
                status: update["status"] as? String ?? "pending",
                rawInput: rawInput
            ))
        case "tool_call_update":
            guard let toolCallId = update["toolCallId"] as? String else {
                return
            }
            let meta = rookeryMeta(update)
            if let inputText = stringifyToolPayload(update["rawInput"]) {
                lastToolInputSnapshots[toolCallId] = inputText
                onEvent?(.toolInputSnapshot(
                    toolCallId: toolCallId,
                    toolName: meta?["toolName"] as? String,
                    text: inputText
                ))
            }
            let validStatuses: Set<String> = ["pending", "in_progress", "completed", "failed", "cancelled"]
            let status = (update["status"] as? String).flatMap { validStatuses.contains($0) ? $0 : nil } ?? "in_progress"
            let outputSnapshot = contentItemsText(update["content"]) ?? stringifyToolPayload(update["rawOutput"])
            if let outputSnapshot {
                lastToolOutputSnapshots[toolCallId] = outputSnapshot
                onEvent?(.toolOutputSnapshot(
                    toolCallId: toolCallId,
                    toolName: meta?["toolName"] as? String,
                    text: outputSnapshot
                ))
            }
            onEvent?(.toolCallUpdate(
                toolCallId: toolCallId,
                status: status,
                toolName: meta?["toolName"] as? String,
                output: nil
            ))
        case "_rookery_tool_input_delta":
            guard let toolCallId = update["toolCallId"] as? String,
                  let delta = update["delta"] as? String else {
                return
            }
            onEvent?(.toolInputDelta(
                toolCallId: toolCallId,
                toolName: update["toolName"] as? String,
                delta: delta
            ))
        case "_rookery_tool_call_ready":
            guard let toolCallId = update["toolCallId"] as? String else {
                return
            }
            onEvent?(.toolCallReady(toolCallId: toolCallId, toolName: update["toolName"] as? String))
        case "_rookery_tool_output_delta":
            guard let toolCallId = update["toolCallId"] as? String,
                  let delta = update["delta"] as? String else {
                return
            }
            onEvent?(.toolOutputDelta(
                toolCallId: toolCallId,
                toolName: update["toolName"] as? String,
                delta: delta
            ))
        case "plan":
            guard let rawEntries = update["entries"] as? [[String: Any]] else {
                return
            }
            let entries = rawEntries.enumerated().map { index, entry in
                PlanEntry(
                    id: index,
                    content: entry["content"] as? String ?? "",
                    priority: entry["priority"] as? String ?? "medium",
                    status: entry["status"] as? String ?? "pending"
                )
            }
            onEvent?(.planUpdate(entries: entries))
        case "usage_update":
            guard let used = intValue(update["used"]), let size = intValue(update["size"]) else {
                return
            }
            onEvent?(.usageUpdate(
                used: used,
                size: size,
                cost: parseUsageCost(update["cost"])
            ))
        case "_rookery_modes_state":
            if let modes = parseModesState(update["modes"]) {
                onEvent?(.modesState(currentModeId: modes.currentModeId, availableModes: modes.availableModes))
            }
        case "current_mode_update":
            if let modeId = update["modeId"] as? String {
                onEvent?(.currentModeUpdate(modeId: modeId))
            }
        case "config_option_update":
            if let configOptions = parseConfigOptions(update["configOptions"]) {
                onEvent?(.configOptionUpdate(configOptions: configOptions))
            }
        case "_rookery_environment_event":
            handleEnvironmentEvent(update)
        case "_rookery_status_changed":
            // Agent stderr — surfaced so runtime diagnostics are visible in the UI.
            if let message = update["message"] as? String, !message.isEmpty {
                onEvent?(.protocolError(message: message))
            }
        case "_rookery_protocol_error":
            onEvent?(.protocolError(message: update["error"] as? String ?? "Protocol error"))
        case "_rookery_connection_error":
            onEvent?(.connectionError(message: update["error"] as? String ?? "Connection error"))
        default:
            // user_message_chunk echoes, _rookery_run_*, _rookery_assistant_* —
            // intentionally ignored. Run failures are surfaced through the
            // JSON-RPC error response path, not through the event stream.
            break
        }
    }

    private func handleEnvironmentEvent(_ update: [String: Any]) {
        guard let kind = update["kind"] as? String else {
            return
        }
        let payload = update["payload"] as? [String: Any] ?? [:]
        guard let environmentId = payload["environmentId"] as? String else {
            return
        }
        switch kind {
        case "environment_offer_available":
            guard let bundleId = payload["bundleId"] as? String,
                  let bundleHash = payload["bundleHash"] as? String else {
                return
            }
            onEvent?(.environmentOffered(EnvironmentOffer(
                environmentId: environmentId,
                bundleId: bundleId,
                bundleHash: bundleHash,
                sourceName: payload["sourceName"] as? String,
                canonicalSourceUrl: payload["canonicalSourceUrl"] as? String,
                skills: payload["skills"] as? [String] ?? [],
                mcpServers: payload["mcpServers"] as? [String] ?? [],
                apps: payload["apps"] as? [String] ?? []
            )))
        case "environment_offer_resolved":
            guard let bundleHash = payload["bundleHash"] as? String else {
                return
            }
            onEvent?(.environmentOfferResolved(environmentId: environmentId, bundleHash: bundleHash))
        case "environment_entered":
            onEvent?(.environmentEntered(environmentId: environmentId))
        case "environment_exited":
            onEvent?(.environmentExited(environmentId: environmentId, error: payload["error"] as? String))
        default:
            break
        }
    }

    // MARK: - Helpers

    private func teardown() {
        generation += 1
        pendingPromptIds.removeAll()
        let continuations = pendingRequests
        pendingRequests.removeAll()
        pendingUserMessageEchoes.removeAll()
        lastToolInputSnapshots.removeAll()
        lastToolOutputSnapshots.removeAll()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        sessionId = nil
        isConnected = false
        continuations.values.forEach { $0.resume(throwing: SocketRequestError.notConnected) }
    }

    private func sendSocketRequest(method: String, params: [String: Any]) async throws -> [String: Any] {
        guard let task, let sessionId else {
            throw SocketRequestError.notConnected
        }
        requestCounter += 1
        let requestId = "rpc-\(requestCounter)"
        var mergedParams = params
        mergedParams["sessionId"] = sessionId
        return try await withCheckedThrowingContinuation { continuation in
            pendingRequests[requestId] = continuation
            sendFrame([
                "jsonrpc": "2.0",
                "id": requestId,
                "method": method,
                "params": mergedParams,
            ], over: task) { [weak self] error in
                guard let self, let error else {
                    return
                }
                if let continuation = self.pendingRequests.removeValue(forKey: requestId) {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func sendFrame(_ frame: [String: Any], over task: URLSessionWebSocketTask, completion: @escaping (Error?) -> Void = { _ in }) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let json = String(data: data, encoding: .utf8) else {
            completion(SocketRequestError.encoding)
            return
        }
        task.send(.string(json), completionHandler: completion)
    }

    private func rookeryMeta(_ update: [String: Any]) -> [String: Any]? {
        (update["_meta"] as? [String: Any])?["rookery"] as? [String: Any]
    }

    private func contentText(_ value: Any?) -> String? {
        guard let content = value as? [String: Any] else {
            return nil
        }
        return content["text"] as? String
    }

    private func contentItemsText(_ value: Any?) -> String? {
        guard let items = value as? [[String: Any]] else {
            return nil
        }
        let texts = items.compactMap { item -> String? in
            if let nested = item["content"] as? [String: Any] {
                return nested["text"] as? String
            }
            return item["text"] as? String
        }.filter { !$0.isEmpty }
        guard !texts.isEmpty else {
            return nil
        }
        return texts.joined(separator: "\n")
    }

    private func stringifyToolPayload(_ value: Any?) -> String? {
        guard let value else {
            return nil
        }
        if let text = value as? String {
            return text
        }
        if let dict = value as? [String: Any], dict.isEmpty {
            return nil
        }
        guard JSONSerialization.isValidJSONObject(value) else {
            return String(describing: value)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted]),
              let text = String(data: data, encoding: .utf8) else {
            return String(describing: value)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == "{}" ? nil : trimmed
    }

    private func parseUsageCost(_ value: Any?) -> AcpUsageCost? {
        guard let dict = value as? [String: Any],
              let amount = doubleValue(dict["amount"]),
              let currency = dict["currency"] as? String else {
            return nil
        }
        return AcpUsageCost(amount: amount, currency: currency)
    }

    private func parseModesState(_ value: Any?) -> AcpModesState? {
        guard let dict = value as? [String: Any],
              let currentModeId = dict["currentModeId"] as? String,
              let availableModesValue = dict["availableModes"] as? [[String: Any]] else {
            return nil
        }
        let availableModes = availableModesValue.compactMap(parseSessionMode)
        return AcpModesState(currentModeId: currentModeId, availableModes: availableModes)
    }

    private func parseSessionMode(_ value: [String: Any]) -> AcpSessionMode? {
        guard let id = value["id"] as? String,
              let name = value["name"] as? String else {
            return nil
        }
        return AcpSessionMode(id: id, name: name, description: value["description"] as? String)
    }

    private func parseConfigOptions(_ value: Any?) -> [AcpConfigOption]? {
        guard let items = value as? [[String: Any]] else {
            return nil
        }
        return items.compactMap(parseConfigOption)
    }

    private func parseConfigOption(_ value: [String: Any]) -> AcpConfigOption? {
        guard let id = value["id"] as? String,
              let name = value["name"] as? String,
              let type = value["type"] as? String,
              let currentValue = value["currentValue"] as? String,
              let optionsValue = value["options"] as? [[String: Any]] else {
            return nil
        }
        let options = optionsValue.compactMap(parseConfigOptionValue)
        return AcpConfigOption(
            id: id,
            name: name,
            description: value["description"] as? String,
            category: value["category"] as? String,
            type: type,
            currentValue: currentValue,
            options: options
        )
    }

    private func parseConfigOptionValue(_ value: [String: Any]) -> AcpConfigOptionValue? {
        guard let rawValue = value["value"] as? String,
              let name = value["name"] as? String else {
            return nil
        }
        return AcpConfigOptionValue(value: rawValue, name: name, description: value["description"] as? String)
    }

    private func parsePermissionToolCall(_ value: Any?) -> AcpPermissionToolCall? {
        guard let dict = value as? [String: Any],
              let toolCallId = dict["toolCallId"] as? String,
              let title = dict["title"] as? String,
              let kind = dict["kind"] as? String,
              let status = dict["status"] as? String else {
            return nil
        }
        return AcpPermissionToolCall(toolCallId: toolCallId, title: title, kind: kind, status: status)
    }

    private func parsePermissionOptions(_ value: Any?) -> [AcpPermissionOption]? {
        guard let items = value as? [[String: Any]] else {
            return nil
        }
        return items.compactMap { item in
            guard let optionId = item["optionId"] as? String,
                  let name = item["name"] as? String,
                  let kind = item["kind"] as? String else {
                return nil
            }
            return AcpPermissionOption(optionId: optionId, name: name, kind: kind)
        }
    }

    private func snapshotDelta(for toolCallId: String, next: String, in snapshots: inout [String: String]) -> String? {
        let previous = snapshots[toolCallId] ?? ""
        snapshots[toolCallId] = next
        if next == previous {
            return nil
        }
        if !previous.isEmpty, next.hasPrefix(previous) {
            return String(next.dropFirst(previous.count))
        }
        return next
    }

    private func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int {
            return int
        }
        if let number = value as? NSNumber {
            return number.intValue
        }
        return nil
    }

    private func doubleValue(_ value: Any?) -> Double? {
        if let double = value as? Double {
            return double
        }
        if let int = value as? Int {
            return Double(int)
        }
        if let number = value as? NSNumber {
            return number.doubleValue
        }
        return nil
    }
}

private enum SocketRequestError: LocalizedError {
    case notConnected
    case encoding
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Not connected to the session"
        case .encoding:
            return "Failed to encode websocket request"
        case .server(let message):
            return message
        }
    }
}
