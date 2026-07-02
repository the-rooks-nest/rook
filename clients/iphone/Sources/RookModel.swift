import ActivityKit
import Foundation
import RookKit
import SwiftUI

enum ServerState: Equatable {
    case unknown
    case offline
    case unauthorized
    case online
}

/// iOS view-model: the portable chat/session/offer core of the macOS
/// `RookMacModel`, with macOS-only services dropped. Location (Phase B),
/// voice (Phase C), and Live Activity (Phase D) attach here later.
@MainActor
final class RookModel: ObservableObject {
    // Server / control plane
    @Published var serverState: ServerState = .unknown
    @Published var serverDiagnostic = ""
    @Published var agents: [AgentDefinition] = []
    @Published var agentsError = ""

    // Session selection
    @Published var selectedAgentId: String?
    @Published var sessions: [AgentSessionSummary] = []
    @Published var sessionsLoading = false
    @Published var sessionsError = ""
    @Published var startingSession = false

    // Chat
    @Published var currentSession: AgentSessionSummary?
    // Whether the chat screen is actually presented. A session can be live
    // (auto-resumed/warmed) without the chat being on screen — that lands the
    // user on the agent list with a "Resume chat" affordance, like the Mac.
    @Published var chatVisible = false
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
    @Published var offerBundles: [EnvironmentBundlePreview] = []
    @Published var offerLoading = false
    @Published var offerError = ""

    // Location → place environment provider
    let placeStore = PlaceStore()
    let locationProvider = LocationProvider()
    @Published var placeEnvironmentId: String?
    @Published var currentPlaceName: String?
    // slug → whether the server has a matching skill bundle (nil = not yet checked).
    // Surfaces slug↔bundle mismatches in the Places screen.
    @Published var placeSkillStatus: [String: Bool] = [:]
    // Candidate loc: environments returned by the server for the current arrival
    // (issue #42, phase 1). Return-only: surfaced, not auto-registered.
    @Published var nearbyCandidates: [EnvironmentCandidate] = []

    // Voice
    private let voice = VoiceController()
    @Published var voiceAuthorized = false
    @Published var voiceListening = false
    @Published var voiceSpeaking = false
    @Published var voicePartial = ""
    private var voiceModeEnabled = false   // speak the reply when the prompt came by voice
    private var spokenTurnBuffer = ""

    // Live Activity (Dynamic Island)
    private var liveActivity: Activity<RookActivityAttributes>?

    // Server address + optional bearer token. The simulator usually reaches the
    // local Mac directly; a physical device often uses a remote-reachable URL.
    @Published var baseURLString: String
    @Published var authTokenString: String

    private(set) var api: RookAPI
    private let socket = AcpSocket()
    private var healthTimer: Timer?
    private var blockCounter = 0
    private var enteredEnvironments: Set<String> = []
    private var autoResumeAttempted = false
    private var reconnectTask: Task<Void, Never>?
    private var userCancelledRun = false

    init() {
        let env = ProcessInfo.processInfo.environment["ROOK_SERVER_BASE_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let stored = UserDefaults.standard.string(forKey: "RookServerBaseURL")
        let urlString: String
        if let env, !env.isEmpty {
            urlString = env
            if stored != env {
                UserDefaults.standard.set(env, forKey: "RookServerBaseURL")
            }
        } else if let stored, !stored.isEmpty {
            urlString = stored
        } else {
            urlString = "http://127.0.0.1:3000"
        }
        let envToken = ProcessInfo.processInfo.environment["ROOK_AUTH_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let storedToken = UserDefaults.standard.string(forKey: "RookAuthToken")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let authToken = (envToken?.isEmpty == false ? envToken : storedToken) ?? ""
        if let envToken, !envToken.isEmpty, storedToken != envToken {
            UserDefaults.standard.set(envToken, forKey: "RookAuthToken")
        }
        let finalURL = URL(string: urlString) ?? URL(string: "http://127.0.0.1:3000")!
        baseURLString = urlString
        authTokenString = authToken
        api = RookAPI(
            baseURL: finalURL,
            authToken: authToken
        )

        socket.onEvent = { [weak self] event in
            self?.handleSocketEvent(event)
        }
        socket.onConnectionChange = { [weak self] connected in
            self?.handleSocketConnectionChange(connected)
        }
        healthTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refreshHealth()
            }
        }
        locationProvider.onRegionChange = { [weak self] place in
            self?.handlePlace(place)
        }
        locationProvider.onVisitArrival = { [weak self] coord in
            self?.placeStore.recordVisit(latitude: coord.latitude, longitude: coord.longitude)
        }
        locationProvider.onArrival = { [weak self] context in
            self?.identifyEnvironments(at: context)
        }
        locationProvider.updateMonitoredPlaces(placeStore.places)
        if locationProvider.isAuthorized {
            locationProvider.startMonitoringVisits()
        }
        setupVoice()
        Task {
            await refreshHealth()
        }
        #if DEBUG
        // E2E hook: ROOK_SIMULATE_ARRIVAL="lat,lon" fires identify once the server is online
        // (CLVisit can't fire in the Simulator). Pass via SIMCTL_CHILD_ROOK_SIMULATE_ARRIVAL.
        if let raw = ProcessInfo.processInfo.environment["ROOK_SIMULATE_ARRIVAL"] {
            let parts = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if parts.count == 2 {
                Task { [weak self] in
                    for _ in 0..<30 where self?.serverState != .online {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        await self?.refreshHealth()
                    }
                    self?.locationProvider.simulateArrival(latitude: parts[0], longitude: parts[1])
                }
            }
        }
        #endif
    }

    // MARK: - Voice

    private func setupVoice() {
        voiceAuthorized = voice.authorized()
        voice.onTranscript = { [weak self] text in
            guard let self else { return }
            self.voicePartial = ""
            self.voiceModeEnabled = true   // spoke the prompt → speak the reply
            self.send(text)
        }
        voice.onListeningChanged = { [weak self] listening in
            self?.voiceListening = listening
            if !listening { self?.voicePartial = "" }
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
    }

    func toggleVoiceListening() {
        if !voice.authorized() {
            voice.requestPermissions { [weak self] granted in
                self?.voiceAuthorized = granted
                if granted {
                    self?.voice.startListening()
                } else {
                    self?.appendBlock(.system(text: "Voice needs Microphone + Speech Recognition permission (Settings → Rook)."))
                }
            }
            return
        }
        voice.toggleListening()
    }

    func stopSpeaking() {
        voice.stopSpeaking()
    }

    /// Best installed voice name (for the Settings screen).
    var voiceName: String { VoiceController.preferredVoiceName() }

    /// Request mic + speech permission without starting a listen (used by Settings).
    func requestVoicePermission() {
        voice.requestPermissions { [weak self] granted in
            self?.voiceAuthorized = granted
        }
    }

    // MARK: - Live Activity (Dynamic Island)

    /// Start the activity when a session is active; update it on meaningful
    /// transitions (place, agent status). `Activity.request` is foreground-only,
    /// so this is called from the running app; APNs-driven updates while away
    /// are a post-MVP addition.
    func updateLiveActivity() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            return
        }
        // Show the activity for an active chat OR an ambient place-with-skills —
        // arriving at a place loads skills even with no chat open, and the card is
        // exactly that "where am I / what's loaded" surface. End it when neither.
        guard currentSession != nil || placeEnvironmentId != nil else {
            endLiveActivity()
            return
        }
        let state = RookActivityAttributes.ContentState(
            placeName: currentPlaceName,
            skillsActive: placeEnvironmentId != nil,
            agentStatus: isRunning ? (statusLine.isEmpty ? "Working…" : statusLine) : "Idle",
            running: isRunning
        )
        if let activity = liveActivity {
            Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
        } else {
            // Activity.request only succeeds in the foreground; a background
            // arrival no-ops here and starts on next foreground (handleBecameActive).
            let attributes = RookActivityAttributes(agentName: currentSession?.agent ?? "Rook")
            liveActivity = try? Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil))
        }
    }

    func endLiveActivity() {
        let activity = liveActivity
        liveActivity = nil
        Task { await activity?.end(nil, dismissalPolicy: .immediate) }
    }

    /// Typed messages should not be spoken back.
    func sendTyped(_ text: String) {
        voiceModeEnabled = false
        send(text)
    }

    // MARK: - Location → place environment

    func enableLocation() {
        locationProvider.requestAuthorization()
        refreshMonitoredPlaces()
        locationProvider.startMonitoringVisits()
    }

    func refreshMonitoredPlaces() {
        locationProvider.updateMonitoredPlaces(placeStore.places)
    }

    /// Pre-check each place against the server so the Places screen can show
    /// whether a matching `environment-repository/loc/<slug>/` bundle exists —
    /// otherwise a slug mismatch is invisible until you physically arrive.
    func refreshPlaceSkillStatus() {
        guard serverState == .online else {
            return
        }
        Task {
            var status: [String: Bool] = [:]
            for place in placeStore.places {
                let preview = try? await api.environmentPreview(environmentId: "loc:\(place.id)")
                status[place.id] = !(preview?.bundles.isEmpty ?? true)
            }
            placeSkillStatus = status
        }
    }

    /// Ask the server which `loc:` environments are likely available at an
    /// arrival that passed the dwell/motion gate. Identification only — the
    /// candidates are surfaced, not auto-registered (issue #42, phase 1).
    private func identifyEnvironments(at context: ArrivalContext) {
        guard serverState == .online else {
            return
        }
        let observedAt = ISO8601DateFormatter().string(from: Date())
        let request = IdentifyAvailableRequest(
            latitude: context.coordinate.latitude,
            longitude: context.coordinate.longitude,
            horizontalAccuracy: context.horizontalAccuracy,
            source: "visit",
            dwellSeconds: context.dwellSeconds,
            isStationary: context.isStationary,
            speedMetersPerSecond: context.speedMetersPerSecond,
            observedAt: observedAt
        )
        Task {
            // Dwell/arrival is an auto-commit: register the identified set with the agent.
            guard let candidates = try? await api.registerLocation(request) else {
                return
            }
            nearbyCandidates = candidates
            guard let top = candidates.first else {
                return
            }
            let others = candidates.count > 1 ? " (+\(candidates.count - 1) more)" : ""
            appendBlock(.system(text: "You appear to be near \(top.displayName)\(others). Found \(candidates.count) nearby environment\(candidates.count == 1 ? "" : "s")."))
        }
    }

    /// Mirrors `RookMacModel.handleForegroundApp`: diff the current place
    /// against the registered environment, unregister the old, register the new
    /// (only if the server has skills for it — the iOS analog of the Mac's
    /// on-disk skill-bundle guard, done via the preview endpoint).
    private func handlePlace(_ place: Place?) {
        currentPlaceName = place?.name
        let envId = place.map { "loc:\($0.id)" }
        guard envId != placeEnvironmentId else {
            return
        }
        let previous = placeEnvironmentId
        placeEnvironmentId = envId
        updateLiveActivity()
        Task {
            if let previous {
                try? await api.unregisterEnvironment(id: previous)
            }
            guard let place, let envId else {
                return
            }
            let preview = try? await api.environmentPreview(environmentId: envId)
            guard let preview, !preview.bundles.isEmpty else {
                // No skills defined for this place — don't raise an empty offer.
                if placeEnvironmentId == envId {
                    placeEnvironmentId = nil
                    updateLiveActivity()
                }
                return
            }
            let metadata: [String: JSONValue] = [
                "slug": .string(place.id),
                "latitude": .number(place.latitude),
                "longitude": .number(place.longitude),
            ]
            try? await api.registerEnvironment(id: envId, sourceName: place.name, metadata: metadata)
        }
    }

    private func reannouncePlaceEnvironment() {
        guard let envId = placeEnvironmentId, let place = locationProvider.current else {
            return
        }
        Task {
            let metadata: [String: JSONValue] = [
                "slug": .string(place.id),
                "latitude": .number(place.latitude),
                "longitude": .number(place.longitude),
            ]
            try? await api.registerEnvironment(id: envId, sourceName: place.name, metadata: metadata)
        }
    }

    func setServerConnection(baseURL string: String, authToken token: String) {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil else {
            return
        }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        baseURLString = trimmed
        authTokenString = trimmedToken
        UserDefaults.standard.set(trimmed, forKey: "RookServerBaseURL")
        UserDefaults.standard.set(trimmedToken, forKey: "RookAuthToken")
        api = RookAPI(baseURL: url, authToken: trimmedToken)
        socket.disconnect()
        currentSession = nil
        Task { await refreshHealth() }
    }

    // MARK: - Server lifecycle

    func refreshHealth() async {
        switch await api.healthResult() {
        case .ok:
            let wasOnline = serverState == .online
            serverState = .online
            serverDiagnostic = ""
            if !wasOnline {
                await loadAgents()
                reannouncePlaceEnvironment()
                await autoResumeRecentSessionIfNeeded()
            }
        case .unauthorized:
            serverState = .unauthorized
            serverDiagnostic = "Authorization header was rejected."
        case .httpStatus(let code):
            serverState = .offline
            serverDiagnostic = "HTTP \(code)"
        case .transportError(let message):
            serverState = .offline
            serverDiagnostic = message
        }
    }

    var serverStatusLabel: String {
        switch serverState {
        case .online: return isRunning ? "working" : "online"
        case .offline: return "offline"
        case .unauthorized: return "unauthorized"
        case .unknown: return "checking…"
        }
    }

    var serverStatusTint: Color {
        switch serverState {
        case .online: return PanelPalette.success
        case .offline, .unauthorized: return PanelPalette.danger
        case .unknown: return PanelPalette.secondaryText
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

    /// Roots first, profile children directly after their parent, with indent depth.
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
        for agent in agents where !result.contains(where: { $0.0.id == agent.id }) {
            result.append((agent, 0))
        }
        return result
    }

    private func autoResumeRecentSessionIfNeeded() async {
        guard !autoResumeAttempted, currentSession == nil else {
            return
        }
        autoResumeAttempted = true
        guard let recent = try? await api.recentSession() else {
            return
        }
        // Warm the most recent session in the background, but stay on the agent
        // list — don't force the user into a chat on launch.
        await resumeSession(recent, switchToChat: false)
    }

    /// Open the per-agent session list (mirrors the Mac app's `.sessions` panel):
    /// tapping an agent shows its previous sessions to resume, plus a new-chat
    /// entry — instead of silently spawning a fresh session.
    func openAgentSessions(_ agentId: String) {
        selectedAgentId = agentId
        sessions = []
        sessionsError = ""
        Task { await loadSessions(agentId: agentId) }
    }

    func closeAgentSessions() {
        selectedAgentId = nil
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
            defer { startingSession = false }
            do {
                let session = try await api.startSession(agent: agentId, sessionName: trimmed.isEmpty ? nil : trimmed)
                enterChat(session: session, resumed: false)
            } catch {
                sessionsError = error.localizedDescription
            }
        }
    }

    func resumeSession(_ session: AgentSessionSummary) {
        startingSession = true
        Task {
            defer { startingSession = false }
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

    /// Bring the (already live) current session's chat on screen — used by the
    /// "Resume chat" affordance and the Live Activity deep link.
    func openChat() {
        guard currentSession != nil else {
            return
        }
        selectedAgentId = nil
        chatVisible = true
    }

    private func enterChat(session: AgentSessionSummary, resumed: Bool, switchToChat: Bool = true) {
        reconnectTask?.cancel()
        selectedAgentId = nil
        chatVisible = switchToChat
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
        socket.connect(sessionId: session.id, request: api.webSocketRequest(sessionId: session.id))
        updateLiveActivity()
    }

    func leaveChat() {
        socket.disconnect()
        reconnectTask?.cancel()
        currentSession = nil
        chatVisible = false
        // Don't hard-end — if you're at a place with skills, the activity stays
        // up as the ambient place card; updateLiveActivity ends it otherwise.
        updateLiveActivity()
    }

    // MARK: - App lifecycle (scenePhase)

    private var pendingSocketResume = false

    /// iOS suspends the websocket when the app backgrounds. Tear it down
    /// intentionally (silent — no phantom "connection lost") and stop any
    /// in-flight run spinner cleanly; reconnect on return. The place
    /// environment is deliberately NOT released here: region monitoring keeps
    /// running in the background, so you're still "at" the place — physically
    /// leaving the geofence (`didExitRegion`) is what unregisters it.
    func handleEnteredBackground() {
        guard currentSession != nil else {
            return
        }
        if socket.isConnected {
            socket.disconnect()
            pendingSocketResume = true
        }
        if isRunning {
            finalizeStreamingBlocks()
            isRunning = false
            statusLine = ""
        }
    }

    func handleBecameActive() {
        reannouncePlaceEnvironment()
        // Start/refresh the Live Activity now that we're foreground (Activity.request
        // is foreground-only, so a background place arrival couldn't start it).
        updateLiveActivity()
        if pendingSocketResume, currentSession != nil, !socket.isConnected {
            pendingSocketResume = false
            scheduleReconnect(delaySeconds: 0)
        }
        Task { await refreshHealth() }
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

    func stopAgent() {
        guard isRunning else {
            return
        }
        userCancelledRun = true
        statusLine = "Stopping…"
        voice.stopSpeaking()
        spokenTurnBuffer = ""
        socket.sendCancel()
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
        updateLiveActivity()
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
            if await api.health() {
                _ = try? await api.resumeSession(session)
                guard !Task.isCancelled else {
                    return
                }
                socket.connect(sessionId: session.id, request: api.webSocketRequest(sessionId: session.id))
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
        case .userMessageChunk(let text):
            appendBlock(.user(text: text))
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
                case "pending": tool.status = .pending
                case "in_progress":
                    tool.status = .running
                    if let output { tool.output = output }
                case "completed":
                    tool.status = .completed
                    if let output { tool.output = output }
                case "failed":
                    tool.status = .failed
                    if let output { tool.output = output }
                case "cancelled": tool.status = .cancelled
                default: break
                }
            }
        case .toolInputSnapshot(let toolCallId, _, let text):
            updateTool(toolCallId) { tool in
                tool.status = .inputStreaming
                tool.arguments = text
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
        case .toolOutputSnapshot(let toolCallId, _, let text):
            updateTool(toolCallId) { tool in
                tool.status = .running
                tool.output = text
            }
        case .toolOutputDelta(let toolCallId, _, let delta):
            updateTool(toolCallId) { tool in
                tool.status = .running
                tool.output += delta
            }
        case .permissionRequest:
            break
        case .planUpdate(let entries):
            upsertPlanBlock(entries)
        case .usageUpdate(let used, let size, _):
            contextUsage = (used, size)
        case .modesState:
            break
        case .currentModeUpdate:
            break
        case .configOptionUpdate:
            break
        case .runCompleted:
            finalizeStreamingBlocks()
            isRunning = false
            statusLine = ""
            userCancelledRun = false
            if voiceModeEnabled, !spokenTurnBuffer.isEmpty {
                voice.speak(spokenTurnBuffer)
            }
            spokenTurnBuffer = ""
            updateLiveActivity()
            deliverNextQueuedIfIdle()
        case .runFailed(let message):
            finalizeStreamingBlocks()
            isRunning = false
            statusLine = ""
            spokenTurnBuffer = ""
            if userCancelledRun {
                userCancelledRun = false
                appendBlock(.system(text: "Stopped."))
            } else {
                appendErrorBlock(source: "run", message: message)
            }
            updateLiveActivity()
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
                let entered = nearbyCandidates.first { $0.environmentId == environmentId }
                let websites = orderedUniqueWebsites(entered: entered, all: nearbyCandidates)
                let label = locationBannerLabel(entered: entered, candidates: nearbyCandidates)
                appendBlock(.environment(EnvironmentBanner(displayName: label, websites: websites)))
            }
        case .environmentExited(let environmentId, let error):
            if enteredEnvironments.remove(environmentId) != nil {
                let suffix = error.map { " (\($0))" } ?? ""
                appendBlock(.system(text: "Exited environment \(environmentId)\(suffix)."))
            }
        }
        scrollTick += 1
    }

    /// Banner label for an entered location: the business name when one match is clearly
    /// best, "Surrounding businesses" when ambiguous, or nil (generic) when unknown.
    /// Mirrors the server's confidence heuristic (`isConfidentMatch`).
    private func locationBannerLabel(entered: EnvironmentCandidate?, candidates: [EnvironmentCandidate]) -> String? {
        guard let top = candidates.first else { return entered?.displayName }
        let ambiguous = top.confidence < 0.7 || (candidates.count >= 2 && top.confidence - candidates[1].confidence < 0.15)
        if ambiguous { return "Surrounding businesses" }
        return entered?.displayName ?? top.displayName
    }

    /// Website URLs for the entered-business favicon row: the entered business first,
    /// then nearby candidates that have a website, deduped by host.
    private func orderedUniqueWebsites(entered: EnvironmentCandidate?, all: [EnvironmentCandidate]) -> [String] {
        let ordered = ([entered].compactMap { $0 } + all.filter { $0.environmentId != entered?.environmentId })
        var seenHosts = Set<String>()
        var result: [String] = []
        for candidate in ordered {
            guard let website = candidate.website, !website.isEmpty else { continue }
            let key = URLComponents(string: website.contains("://") ? website : "https://\(website)")?.host ?? website
            if seenHosts.insert(key.lowercased()).inserted {
                result.append(website)
            }
        }
        return result
    }

    private func appendBlock(_ kind: ChatBlockKind, id: String? = nil) {
        blockCounter += 1
        blocks.append(ChatBlock(id: id ?? "block-\(blockCounter)", kind: kind))
    }

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
        var state = ToolBlockState(toolCallId: toolCallId, title: "Tool", kindLabel: "", status: .running, arguments: "", output: "")
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

    // MARK: - Environment offers

    private func handleEnvironmentOffered(_ offer: EnvironmentOffer) {
        guard pendingOffer?.environmentId != offer.environmentId else {
            return
        }
        pendingOffer = offer
        offerBundles = []
        offerError = ""
        offerLoading = true
        Task {
            do {
                offerBundles = try await api.environmentPreview(environmentId: offer.environmentId).bundles
            } catch {
                offerError = error.localizedDescription
            }
            offerLoading = false
        }
    }

    private func handleEnvironmentOfferResolved(_ environmentId: String) {
        guard pendingOffer?.environmentId == environmentId else {
            return
        }
        clearOffer()
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
            clearOffer()
        }
    }

    func clearOffer() {
        pendingOffer = nil
        offerBundles = []
        offerError = ""
    }
}
