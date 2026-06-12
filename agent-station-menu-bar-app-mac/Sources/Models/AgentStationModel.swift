import AppKit
import Foundation
import Security
import SwiftUI

enum PanelMode: Equatable {
    case home
    case sessions(agentId: String)
    case chat
    case environmentOffer
}

enum ServerState: Equatable {
    case unknown
    case offline
    case starting
    case online
}

@MainActor
final class AgentStationModel: ObservableObject {
    static weak var shared: AgentStationModel?

    // Navigation lives on the model (not view @State) so the panel reopens
    // where the user left off after the MenuBarExtra window closes.
    @Published var panelMode: PanelMode = .home

    // Server / control plane
    @Published var serverState: ServerState = .unknown
    @Published var managedServerRunning = false
    @Published var agents: [AgentDefinition] = []
    @Published var agentsError = ""

    // Session selection
    @Published var sessions: [AgentSessionSummary] = []
    @Published var sessionsLoading = false
    @Published var sessionsError = ""
    @Published var startingSession = false

    // Chat
    @Published var currentSession: AgentSessionSummary?
    @Published var blocks: [ChatBlock] = []
    @Published var queuedMessages: [String] = []
    @Published var isRunning = false
    @Published var statusLine = ""
    @Published var socketConnected = false
    @Published var reconnecting = false
    @Published var contextUsage: (used: Int, size: Int)?
    @Published var scrollTick = 0

    // Environment offers
    @Published var pendingOffer: EnvironmentOffer?
    @Published var offerSkills: [SkillPreview] = []
    @Published var offerLoading = false
    @Published var offerError = ""

    // Foreground-app environment provider + Mac bridge (Tier 1/2)
    @Published var foregroundEnvironmentId: String?
    @Published var foregroundAppName: String?
    @Published var foregroundWindowTitle: String?
    @Published var accessibilityTrusted = false
    @Published var screenRecordingTrusted = false
    @Published var computerControlEnabled = false
    @Published var bridgePort: UInt16 = 0

    // Voice
    @Published var voiceModeEnabled = false
    @Published var voiceAuthorized = false
    @Published var voiceListening = false
    @Published var voiceSpeaking = false
    @Published var voicePartial = ""

    let api = AgentStationAPI()
    private let socket = AcpSocket()
    private let serverController = ServerController()
    private let foregroundMonitor = ForegroundAppMonitor()
    private let bridge = MacBridge()
    private let voice = VoiceController()
    private let hotKey = HotKey()
    private var healthTimer: Timer?
    private var blockCounter = 0
    private var enteredEnvironments: Set<String> = []
    private var spokenTurnBuffer = ""
    private var autoResumeAttempted = false
    private var reconnectTask: Task<Void, Never>?
    private var panelWindow: NSWindow?

    init() {
        AgentStationModel.shared = self
        // Escape hatch for crowded menu bars (macOS hides overflow status
        // items behind the notch): `defaults write com.rookery.AgentStationMenuBar
        // ShowPanelWindow -bool true` opens the panel as a regular window.
        if UserDefaults.standard.bool(forKey: "ShowPanelWindow") {
            DispatchQueue.main.async { [weak self] in
                self?.openPanelWindow()
            }
        }
        socket.onEvent = { [weak self] event in
            self?.handleSocketEvent(event)
        }
        socket.onConnectionChange = { [weak self] connected in
            self?.handleSocketConnectionChange(connected)
        }
        serverController.onTermination = { [weak self] in
            guard let self else {
                return
            }
            self.managedServerRunning = false
            Task {
                await self.refreshHealth()
            }
        }
        healthTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refreshHealth()
            }
        }
        foregroundMonitor.onForegroundChange = { [weak self] app in
            self?.handleForegroundApp(app)
        }
        foregroundMonitor.onContextRefresh = { [weak self] app, title in
            self?.handleContextRefresh(app: app, title: title)
        }
        computerControlEnabled = UserDefaults.standard.bool(forKey: "EnableComputerControl")
        voiceModeEnabled = UserDefaults.standard.bool(forKey: "EnableVoiceMode")
        setupVoice()
        startBridge()
        foregroundMonitor.start()
        accessibilityTrusted = AXReader.isTrusted()
        screenRecordingTrusted = ScreenCapturer.hasPermission()
        Task {
            await refreshHealth()
        }
    }

    // MARK: - Menu bar status

    var menuBarSystemImage: String {
        if pendingOffer != nil {
            return "bird.fill"
        }
        return "bird"
    }

    var menuBarTint: Color {
        if pendingOffer != nil {
            return PanelPalette.warning
        }
        if isRunning {
            return PanelPalette.info
        }
        return Color.primary
    }

    var menuBarHelp: String {
        switch serverState {
        case .online:
            if let session = currentSession {
                return "Agent Station — \(session.agent) · \(session.name)"
            }
            return "Agent Station — server online"
        case .starting:
            return "Agent Station — server starting…"
        default:
            return "Agent Station — server offline"
        }
    }

    var serverStatusTint: Color {
        switch serverState {
        case .online:
            return PanelPalette.success
        case .starting:
            return PanelPalette.warning
        case .offline:
            return PanelPalette.danger
        case .unknown:
            return PanelPalette.secondaryText
        }
    }

    var serverPrimaryLine: String {
        switch serverState {
        case .online:
            return agents.isEmpty ? "Server online" : "Server online · \(agents.count) agents"
        case .starting:
            return "Server starting…"
        case .offline:
            return "Server offline"
        case .unknown:
            return "Checking server…"
        }
    }

    var serverSecondaryLine: String {
        if let session = currentSession {
            return "\(session.agent) · \(session.name)"
        }
        return api.baseURL.absoluteString
    }

    /// Agents ordered as a tree: roots first, profile children directly after
    /// their parent. Pairs each agent with its indent depth for rendering.
    var agentTree: [(agent: AgentDefinition, depth: Int)] {
        let roots = agents.filter { $0.parentId == nil }
        var result: [(AgentDefinition, Int)] = []
        func append(_ agent: AgentDefinition, depth: Int) {
            result.append((agent, depth))
            for child in agents where child.parentId == agent.id {
                append(child, depth: depth + 1)
            }
        }
        for root in roots {
            append(root, depth: 0)
        }
        // Orphans whose parent isn't registered still show up at the root.
        for agent in agents where !result.contains(where: { $0.0.id == agent.id }) {
            result.append((agent, 0))
        }
        return result
    }

    // MARK: - Server lifecycle

    func refreshHealth() async {
        let healthy = await api.health()
        if healthy {
            let wasOnline = serverState == .online
            serverState = .online
            if !wasOnline {
                await loadAgents()
                reannounceForegroundEnvironment()
                await autoResumeRecentSessionIfNeeded()
            }
        } else if serverState != .starting || !managedServerRunning {
            serverState = managedServerRunning ? .starting : .offline
        }
        managedServerRunning = serverController.isManagedServerRunning
    }

    func startServer() {
        guard serverState != .online else {
            return
        }
        serverController.start()
        managedServerRunning = serverController.isManagedServerRunning
        if managedServerRunning {
            serverState = .starting
        }
    }

    func stopServer() {
        serverController.stop()
        managedServerRunning = false
        Task {
            await refreshHealth()
        }
    }

    func openWebApp() {
        NSWorkspace.shared.open(api.webAppURL)
    }

    func openServerLog() {
        NSWorkspace.shared.open(ServerController.logFileURL)
    }

    func refreshNow() {
        Task {
            await refreshHealth()
            if serverState == .online {
                await loadAgents()
            }
        }
    }

    func openPanelWindow() {
        if let panelWindow {
            panelWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let controller = NSHostingController(rootView: AgentStationMenuView(model: self))
        controller.sizingOptions = [.preferredContentSize]
        let window = NSWindow(contentViewController: controller)
        window.title = "Agent Station"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panelWindow = window
    }

    func quitApp() {
        socket.disconnect()
        foregroundMonitor.stop()
        bridge.stop()
        hotKey.stop()
        voice.stopSpeaking()
        let environmentToRelease = foregroundEnvironmentId
        Task {
            // Best-effort: end the foreground episode so the server doesn't
            // keep a stale availability after we're gone.
            if let environmentToRelease {
                try? await api.markEnvironmentUnavailable(id: environmentToRelease)
            }
            if managedServerRunning {
                serverController.stop()
            }
            NSApplication.shared.terminate(nil)
        }
    }

    // MARK: - Agents & sessions

    func loadAgents() async {
        do {
            agents = try await api.agents()
            agentsError = ""
        } catch {
            agentsError = error.localizedDescription
        }
    }

    private func autoResumeRecentSessionIfNeeded() async {
        guard !autoResumeAttempted, currentSession == nil else {
            return
        }
        autoResumeAttempted = true
        guard let recent = try? await api.recentSession() else {
            return
        }
        await resumeSession(recent, switchToChat: false)
    }

    func openAgentSessions(_ agentId: String) {
        sessions = []
        sessionsError = ""
        withAnimation(.easeInOut(duration: 0.16)) {
            panelMode = .sessions(agentId: agentId)
        }
        Task {
            await loadSessions(agentId: agentId)
        }
    }

    func loadSessions(agentId: String) async {
        sessionsLoading = true
        defer {
            sessionsLoading = false
        }
        do {
            sessions = try await api.sessions(agent: agentId)
            sessionsError = ""
        } catch {
            sessionsError = error.localizedDescription
        }
    }

    func startNewSession(agentId: String, name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        startingSession = true
        Task {
            defer {
                startingSession = false
            }
            do {
                let session = try await api.startSession(
                    agent: agentId,
                    sessionName: trimmed.isEmpty ? nil : trimmed
                )
                enterChat(session: session, resumed: false)
            } catch {
                sessionsError = error.localizedDescription
            }
        }
    }

    func resumeSession(_ session: AgentSessionSummary) {
        startingSession = true
        Task {
            defer {
                startingSession = false
            }
            await resumeSession(session, switchToChat: true)
        }
    }

    private func resumeSession(_ session: AgentSessionSummary, switchToChat: Bool) async {
        do {
            let started = try await api.resumeSession(session)
            enterChat(session: started, resumed: true, switchToChat: switchToChat)
        } catch {
            sessionsError = error.localizedDescription
        }
    }

    private func enterChat(session: AgentSessionSummary, resumed: Bool, switchToChat: Bool = true) {
        reconnectTask?.cancel()
        currentSession = session
        blocks = []
        queuedMessages = []
        isRunning = false
        statusLine = ""
        contextUsage = nil
        enteredEnvironments = []
        if resumed {
            appendBlock(.system(text: "Resumed session — earlier messages aren't replayed."))
        }
        socket.connect(sessionId: session.id, webSocketURL: api.webSocketURL)
        if switchToChat {
            withAnimation(.easeInOut(duration: 0.16)) {
                panelMode = .chat
            }
        }
    }

    func goHome() {
        withAnimation(.easeInOut(duration: 0.16)) {
            panelMode = .home
        }
    }

    func openChat() {
        guard currentSession != nil else {
            return
        }
        withAnimation(.easeInOut(duration: 0.16)) {
            panelMode = .chat
        }
    }

    // MARK: - Chat

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, currentSession != nil else {
            return
        }
        if isRunning || !socket.isConnected {
            queuedMessages.append(trimmed)
            if !socket.isConnected {
                scheduleReconnect(delaySeconds: 0)
            }
            return
        }
        deliver(trimmed)
    }

    func removeQueuedMessage(at index: Int) {
        guard queuedMessages.indices.contains(index) else {
            return
        }
        queuedMessages.remove(at: index)
    }

    private func deliver(_ text: String) {
        finalizeStreamingBlocks()
        appendBlock(.user(text: text))
        isRunning = true
        statusLine = "Agent is working…"
        spokenTurnBuffer = ""
        socket.sendPrompt(text: text)
    }

    private func deliverNextQueuedIfIdle() {
        guard !isRunning, socket.isConnected, !queuedMessages.isEmpty else {
            return
        }
        let next = queuedMessages.removeFirst()
        Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !isRunning, socket.isConnected else {
                queuedMessages.insert(next, at: 0)
                return
            }
            deliver(next)
        }
    }

    private func scheduleReconnect(delaySeconds: Double) {
        guard currentSession != nil else {
            return
        }
        reconnectTask?.cancel()
        reconnecting = true
        reconnectTask = Task {
            if delaySeconds > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            }
            guard !Task.isCancelled, let session = currentSession else {
                return
            }
            // The room may have idle-stopped; restart it before reattaching.
            if await api.health() {
                _ = try? await api.resumeSession(session)
                guard !Task.isCancelled else {
                    return
                }
                socket.connect(sessionId: session.id, webSocketURL: api.webSocketURL)
                reconnecting = false
                deliverNextQueuedIfIdle()
            } else if !Task.isCancelled {
                scheduleReconnect(delaySeconds: 3)
            }
        }
    }

    private func handleSocketConnectionChange(_ connected: Bool) {
        socketConnected = connected
        if connected {
            // Cancel any armed reconnect so a successful connection can't be
            // followed by a stale reconnect cycle.
            reconnectTask?.cancel()
            reconnectTask = nil
            reconnecting = false
            return
        }
        if isRunning {
            isRunning = false
            statusLine = ""
            finalizeStreamingBlocks()
            appendErrorBlock(source: "connection", message: "Connection lost while the agent was running.")
        }
        if currentSession != nil {
            scheduleReconnect(delaySeconds: 2)
        }
    }

    // MARK: - Event reduction

    private func handleSocketEvent(_ event: AcpClientEvent) {
        switch event {
        case .agentMessageChunk(let text):
            statusLine = "Responding…"
            appendStreamingText(text, isThinking: false)
            if voiceModeEnabled {
                spokenTurnBuffer += text
            }
        case .agentThoughtChunk(let text):
            statusLine = "Thinking…"
            appendStreamingText(text, isThinking: true)
        case .toolCallStarted(let toolCallId, let title, let kind, let status, let rawInput):
            statusLine = "Using tool: \(title)"
            let state = ToolBlockState(
                toolCallId: toolCallId,
                title: title,
                kindLabel: kind,
                status: status == "in_progress" ? .running : .pending,
                arguments: rawInput ?? "",
                output: ""
            )
            appendBlock(.tool(state), id: "tool-\(toolCallId)-\(blockCounter)")
        case .toolCallUpdate(let toolCallId, let status, let toolName, let output):
            updateTool(toolCallId) { tool in
                if let toolName, tool.title.isEmpty {
                    tool.title = toolName
                }
                switch status {
                case "pending":
                    tool.status = .pending
                case "in_progress":
                    tool.status = .running
                    if let output {
                        tool.output = output
                    }
                case "completed":
                    tool.status = .completed
                    if let output {
                        tool.output = output
                    }
                case "failed":
                    tool.status = .failed
                    if let output {
                        tool.output = output
                    }
                case "cancelled":
                    tool.status = .cancelled
                default:
                    break
                }
            }
        case .toolInputDelta(let toolCallId, _, let delta):
            updateTool(toolCallId) { tool in
                tool.status = .inputStreaming
                tool.arguments += delta
            }
        case .toolCallReady(let toolCallId, _):
            updateTool(toolCallId) { tool in
                tool.status = .ready
            }
        case .toolOutputDelta(let toolCallId, _, let delta):
            updateTool(toolCallId) { tool in
                tool.status = .running
                tool.output += delta
            }
        case .planUpdate(let entries):
            upsertPlanBlock(entries)
        case .usageUpdate(let used, let size):
            contextUsage = (used, size)
        case .runCompleted:
            finalizeStreamingBlocks()
            isRunning = false
            statusLine = ""
            // Speak the whole response once, only after the turn is done and the
            // text has rendered — not streamed sentence-by-sentence.
            if voiceModeEnabled, !spokenTurnBuffer.isEmpty {
                voice.speak(spokenTurnBuffer)
            }
            spokenTurnBuffer = ""
            deliverNextQueuedIfIdle()
        case .runFailed(let message):
            finalizeStreamingBlocks()
            isRunning = false
            statusLine = ""
            spokenTurnBuffer = ""
            appendErrorBlock(source: "run", message: message)
            deliverNextQueuedIfIdle()
        case .protocolError(let message):
            appendErrorBlock(source: "protocol", message: message)
        case .connectionError(let message):
            appendErrorBlock(source: "connection", message: message)
        case .environmentOffered(let offer):
            handleEnvironmentOffered(offer)
        case .environmentOfferResolved(let environmentId):
            handleEnvironmentOfferResolved(environmentId)
        case .environmentEntered(let environmentId):
            if enteredEnvironments.insert(environmentId).inserted {
                appendBlock(.system(text: "Entered environment \(environmentId) — skills loaded."))
            }
        case .environmentExited(let environmentId, let error):
            if enteredEnvironments.remove(environmentId) != nil {
                let suffix = error.map { " (\($0))" } ?? ""
                appendBlock(.system(text: "Exited environment \(environmentId)\(suffix)."))
            }
        }
        scrollTick += 1
    }

    private func nextBlockId() -> String {
        blockCounter += 1
        return "block-\(blockCounter)"
    }

    private func appendBlock(_ kind: ChatBlockKind, id: String? = nil) {
        blockCounter += 1
        blocks.append(ChatBlock(id: id ?? "block-\(blockCounter)", kind: kind))
    }

    /// Some synthesized error updates arrive twice on the wire (translated +
    /// passthrough copies); collapsing identical consecutive errors hides that.
    private func appendErrorBlock(source: String, message: String) {
        if case .error(let lastSource, let lastMessage)? = blocks.last?.kind,
           lastSource == source, lastMessage == message {
            return
        }
        appendBlock(.error(source: source, message: message))
    }

    private func appendStreamingText(_ text: String, isThinking: Bool) {
        if let last = blocks.indices.last {
            switch blocks[last].kind {
            case .assistantText(let existing, true) where !isThinking:
                blocks[last].kind = .assistantText(text: existing + text, streaming: true)
                return
            case .thinking(let existing, true) where isThinking:
                blocks[last].kind = .thinking(text: existing + text, streaming: true)
                return
            default:
                break
            }
        }
        if isThinking {
            appendBlock(.thinking(text: text, streaming: true))
        } else {
            appendBlock(.assistantText(text: text, streaming: true))
        }
    }

    private func finalizeStreamingBlocks() {
        for index in blocks.indices {
            switch blocks[index].kind {
            case .assistantText(let text, true):
                blocks[index].kind = .assistantText(text: text, streaming: false)
            case .thinking(let text, true):
                blocks[index].kind = .thinking(text: text, streaming: false)
            default:
                break
            }
        }
    }

    private func updateTool(_ toolCallId: String, _ mutate: (inout ToolBlockState) -> Void) {
        for index in blocks.indices.reversed() {
            if case .tool(var state) = blocks[index].kind, state.toolCallId == toolCallId {
                mutate(&state)
                blocks[index].kind = .tool(state)
                return
            }
        }
        // Update for a tool we never saw start: create it so output isn't lost.
        var state = ToolBlockState(
            toolCallId: toolCallId,
            title: "Tool",
            kindLabel: "",
            status: .running,
            arguments: "",
            output: ""
        )
        mutate(&state)
        appendBlock(.tool(state), id: "tool-\(toolCallId)-\(blockCounter)")
    }

    private func upsertPlanBlock(_ entries: [PlanEntry]) {
        for index in blocks.indices.reversed() {
            if case .plan = blocks[index].kind {
                blocks[index].kind = .plan(entries: entries)
                return
            }
        }
        appendBlock(.plan(entries: entries))
    }

    // MARK: - Foreground-app environment provider

    /// The on-disk repository is the registry: a foreground app maps to
    /// environment `app:<slug>` iff `environment-repository/app/<slug>/`
    /// exists. Matches the directory name against the slugified app name and
    /// the (full or last-component) bundle id.
    private func knownAppEnvironmentSlug(for app: ForegroundApp) -> String? {
        let appKindRoot = ServerController.repoRoot
            .appending(path: "environment-repository/app")
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: appKindRoot,
            includingPropertiesForKeys: [.isDirectoryKey]
        ) else {
            return nil
        }
        let candidates = Set([
            Self.slugify(app.name),
            app.bundleId.lowercased(),
            app.bundleId.components(separatedBy: ".").last?.lowercased() ?? "",
        ])
        for entry in entries where (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            if candidates.contains(entry.lastPathComponent.lowercased()) {
                return entry.lastPathComponent
            }
        }
        return nil
    }

    static func slugify(_ name: String) -> String {
        name.lowercased()
            .map { $0.isLetter || $0.isNumber ? String($0) : "-" }
            .joined()
            .split(separator: "-")
            .joined(separator: "-")
    }

    private func handleForegroundApp(_ app: ForegroundApp) {
        AXReader.primeAccessibility(pid: app.pid)
        let title = AXReader.focusedWindowTitle(pid: app.pid)
        foregroundAppName = app.name
        foregroundWindowTitle = title
        let environmentId = knownAppEnvironmentSlug(for: app).map { "app:\($0)" }
        providerLog("foreground: \(app.name) [\(app.bundleId)] title=\(title ?? "nil") -> \(environmentId ?? "no environment")")
        updateBridgeContext(app: app, title: title, environmentId: environmentId)
        guard environmentId != foregroundEnvironmentId else {
            return
        }
        let previous = foregroundEnvironmentId
        foregroundEnvironmentId = environmentId
        Task {
            do {
                if let previous {
                    try await api.markEnvironmentUnavailable(id: previous)
                    providerLog("unavailable ok: \(previous)")
                }
                if let environmentId {
                    var metadata: [String: JSONValue] = ["bundleId": .string(app.bundleId)]
                    if let title {
                        metadata["windowTitle"] = .string(title)
                    }
                    try await api.registerEnvironment(
                        id: environmentId,
                        sourceName: app.name,
                        metadata: metadata
                    )
                    providerLog("register ok: \(environmentId)")
                }
            } catch {
                providerLog("provider error: \(error.localizedDescription)")
            }
        }
    }

    /// In-app context change (e.g. switching Slack channels) — refresh the
    /// bridge's live /context without re-registering the environment.
    private func handleContextRefresh(app: ForegroundApp, title: String?) {
        foregroundAppName = app.name
        foregroundWindowTitle = title
        updateBridgeContext(app: app, title: title, environmentId: foregroundEnvironmentId)
    }

    // MARK: - Mac bridge (Tier 2)

    private func startBridge() {
        let port = UInt16(UserDefaults.standard.integer(forKey: "MacBridgePort"))
        let chosen = port == 0 ? 8765 : port
        let token = Self.randomToken()
        bridge.runAppleScript = { script in
            DispatchQueue.main.sync {
                var error: NSDictionary?
                let result = NSAppleScript(source: script)?.executeAndReturnError(&error)
                if let error {
                    return (ok: false, output: "\(error[NSAppleScript.errorMessage] ?? error)")
                }
                return (ok: true, output: result?.stringValue ?? "")
            }
        }
        bridge.openURL = { urlString in
            // Deny schemes that can read local files or run script in other
            // contexts; app deep links (https, slack, zoommtg, …) stay allowed.
            let denied: Set<String> = ["file", "javascript", "data", "vbscript"]
            guard let url = URL(string: urlString),
                  let scheme = url.scheme?.lowercased(),
                  !denied.contains(scheme) else {
                return false
            }
            return DispatchQueue.main.sync {
                NSWorkspace.shared.open(url)
            }
        }
        bridge.readWindowText = {
            DispatchQueue.main.sync {
                guard let front = NSWorkspace.shared.frontmostApplication else {
                    return nil
                }
                return AXReader.focusedWindowText(pid: front.processIdentifier)
            }
        }
        bridge.readAxElements = {
            DispatchQueue.main.sync {
                guard let front = NSWorkspace.shared.frontmostApplication,
                      let elements = AXReader.actionableElements(pid: front.processIdentifier) else {
                    return nil
                }
                return elements.enumerated().map { index, element in
                    [
                        "id": index,
                        "role": element.role,
                        "label": element.label,
                        "x": element.x, "y": element.y,
                        "width": element.width, "height": element.height,
                        "centerX": element.x + element.width / 2,
                        "centerY": element.y + element.height / 2,
                    ]
                }
            }
        }
        bridge.readScreenText = {
            ScreenCapturer.captureFrontmostWindowText()
        }
        bridge.captureScreenshot = {
            guard let capture = ScreenCapturer.captureFrontmostWindow() else {
                return nil
            }
            return [
                "ok": true,
                "png_base64": capture.pngBase64,
                "pixelWidth": capture.pixelWidth,
                "pixelHeight": capture.pixelHeight,
                "originX": capture.originX,
                "originY": capture.originY,
                "scale": capture.scale,
            ]
        }
        bridge.performInput = { object in
            Self.performInput(object)
        }
        bridge.start(port: chosen, token: token)
        bridge.setControlEnabled(computerControlEnabled)
        bridgePort = chosen
        writeBridgeHandshake(port: chosen, token: token)
    }

    /// Share the port + bearer token with the agent out-of-band via a 0600 file
    /// in the user's home dir. The agent's shell can read it; a webpage hitting
    /// the loopback port cannot, so CSRF/DNS-rebinding callers can't authenticate.
    private func writeBridgeHandshake(port: UInt16, token: String) {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".agent-station")
        let file = dir.appending(path: "mac-bridge.json")
        do {
            try FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let payload: [String: Any] = [
                "port": Int(port),
                "token": token,
                "baseUrl": "http://127.0.0.1:\(port)",
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
            try data.write(to: file, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            providerLog("bridge handshake write failed: \(error.localizedDescription)")
        }
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            bytes = (0..<32).map { _ in UInt8(truncatingIfNeeded: Int.random(in: 0...255)) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func updateBridgeContext(app: ForegroundApp, title: String?, environmentId: String?) {
        let payload: [String: Any] = [
            "frontmostApp": app.name,
            "bundleId": app.bundleId,
            "windowTitle": title ?? NSNull(),
            "environmentId": environmentId ?? NSNull(),
            "accessibilityTrusted": AXReader.isTrusted(),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            bridge.updateContext(data)
        }
    }

    func requestAccessibility() {
        // Prompts on first call; subsequent calls just re-check. The user
        // completes the grant in System Settings, so we poll for the flip.
        _ = AXReader.isTrusted(promptIfNeeded: true)
        Task {
            for _ in 0..<60 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if AXReader.isTrusted() {
                    accessibilityTrusted = true
                    foregroundMonitor.refreshTitleNow()
                    return
                }
            }
        }
    }

    func requestScreenRecording() {
        ScreenCapturer.requestPermission()
        Task {
            for _ in 0..<60 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if ScreenCapturer.hasPermission() {
                    screenRecordingTrusted = true
                    return
                }
            }
        }
    }

    // MARK: - Voice

    private func setupVoice() {
        voiceAuthorized = voice.authorized()
        voice.onTranscript = { [weak self] text in
            self?.handleVoiceTranscript(text)
        }
        voice.onListeningChanged = { [weak self] listening in
            self?.voiceListening = listening
            if !listening {
                self?.voicePartial = ""
            }
        }
        voice.onSpeakingChanged = { [weak self] speaking in
            self?.voiceSpeaking = speaking
        }
        voice.onPartial = { [weak self] partial in
            self?.voicePartial = partial
        }
        voice.onError = { [weak self] message in
            self?.voicePartial = ""
            self?.appendBlock(.system(text: "Voice: \(message)"))
        }
        hotKey.onTrigger = { [weak self] in
            self?.toggleVoiceListening()
        }
        hotKey.start()
    }

    private func handleVoiceTranscript(_ text: String) {
        // Show the spoken text as a user turn and route it to the agent.
        if currentSession != nil {
            send(text)
        } else {
            appendBlock(.system(text: "Heard \"\(text)\" — start a session first."))
        }
    }

    func stopSpeaking() {
        voice.stopSpeaking()
    }

    var voiceName: String {
        VoiceController.preferredVoiceName()
    }

    func toggleVoiceListening() {
        guard voiceModeEnabled else {
            return
        }
        if !voice.authorized() {
            requestVoicePermissions()
            return
        }
        voice.toggleListening()
    }

    func setVoiceMode(_ enabled: Bool) {
        voiceModeEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "EnableVoiceMode")
        if enabled {
            if !voice.authorized() {
                requestVoicePermissions()
            }
        } else {
            voice.stopSpeaking()
            if voiceListening {
                voice.stopListening(send: false)
            }
        }
    }

    func requestVoicePermissions() {
        voice.requestPermissions { [weak self] granted in
            self?.voiceAuthorized = granted
            if !granted {
                self?.appendBlock(.system(text: "Voice needs Microphone + Speech Recognition permission (System Settings → Privacy)."))
            }
        }
    }

    func setComputerControlEnabled(_ enabled: Bool) {
        computerControlEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "EnableComputerControl")
        bridge.setControlEnabled(enabled)
        providerLog("computer control \(enabled ? "ENABLED" : "disabled")")
    }

    /// Translate an /input payload into a synthesized event. Runs the actual
    /// posting on the main thread (NSScreen / event posting).
    private static func performInput(_ object: [String: Any]) -> (ok: Bool, output: String) {
        let action = (object["action"] as? String ?? "").lowercased()
        return DispatchQueue.main.sync {
            switch action {
            case "move", "click", "doubleclick":
                guard let x = (object["x"] as? NSNumber)?.doubleValue,
                      let y = (object["y"] as? NSNumber)?.doubleValue else {
                    return (false, "click/move requires numeric x,y")
                }
                let point = CGPoint(x: x, y: y)
                switch action {
                case "move": InputSynthesizer.move(to: point)
                case "click": InputSynthesizer.click(at: point)
                default: InputSynthesizer.click(at: point, double: true)
                }
                return (true, "\(action) at \(Int(x)),\(Int(y))")
            case "type":
                guard let text = object["text"] as? String else {
                    return (false, "type requires 'text'")
                }
                InputSynthesizer.type(text)
                return (true, "typed \(text.count) chars")
            case "key":
                guard let name = object["key"] as? String else {
                    return (false, "key requires 'key'")
                }
                let modifiers = object["modifiers"] as? [String] ?? []
                let ok = InputSynthesizer.key(name, modifiers: modifiers)
                return (ok, ok ? "pressed \(name)" : "unknown key '\(name)'")
            default:
                return (false, "unknown action '\(action)' (use move|click|doubleClick|type|key)")
            }
        }
    }

    /// Re-announce the current foreground environment after the server comes
    /// (back) up — registrations are in-memory server state and die with it.
    private func reannounceForegroundEnvironment() {
        guard let environmentId = foregroundEnvironmentId,
              let app = foregroundMonitor.current else {
            return
        }
        Task {
            try? await api.registerEnvironment(
                id: environmentId,
                sourceName: app.name,
                metadata: ["bundleId": .string(app.bundleId)]
            )
        }
    }

    // MARK: - Environment offers

    private func handleEnvironmentOffered(_ offer: EnvironmentOffer) {
        guard pendingOffer?.environmentId != offer.environmentId else {
            return
        }
        pendingOffer = offer
        offerSkills = []
        offerError = ""
        offerLoading = true
        Task {
            do {
                offerSkills = try await api.skillPreviews(environmentId: offer.environmentId)
            } catch {
                offerError = error.localizedDescription
            }
            offerLoading = false
        }
        withAnimation(.easeInOut(duration: 0.16)) {
            panelMode = .environmentOffer
        }
    }

    private func handleEnvironmentOfferResolved(_ environmentId: String) {
        guard pendingOffer?.environmentId == environmentId else {
            return
        }
        clearOfferAndReturn()
    }

    func reviewPendingOffer() {
        guard pendingOffer != nil else {
            return
        }
        withAnimation(.easeInOut(duration: 0.16)) {
            panelMode = .environmentOffer
        }
    }

    func decideEnvironment(_ decision: String) {
        guard let offer = pendingOffer else {
            return
        }
        Task {
            do {
                try await api.decideEnvironment(environmentId: offer.environmentId, decision: decision)
                if decision == "accept" || decision == "approve" {
                    appendBlock(.system(text: "Environment \(offer.environmentId) allowed — agent reloads its skills when idle."))
                }
            } catch {
                offerError = error.localizedDescription
                return
            }
            clearOfferAndReturn()
        }
    }

    func dismissOfferView() {
        withAnimation(.easeInOut(duration: 0.16)) {
            panelMode = currentSession != nil ? .chat : .home
        }
    }

    private func clearOfferAndReturn() {
        pendingOffer = nil
        offerSkills = []
        offerError = ""
        if panelMode == .environmentOffer {
            dismissOfferView()
        }
    }
}
