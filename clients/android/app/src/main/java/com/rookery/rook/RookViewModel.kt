// Mirrors clients/iphone/Sources/RookModel.swift
//
// Divergences from the Swift source (all intentional):
// - State is exposed as StateFlow instead of @Published; lists are always replaced
//   wholesale (never mutated in place) so StateFlow's equality check and Compose
//   recomposition behave correctly.
// - Takes an injectable CoroutineScope instead of relying on ViewModel's built-in
//   viewModelScope, and does nothing side-effecting in init{} — same pattern AcpSocket
//   uses so reducer logic (handleSocketEvent, deliver, etc.) is unit-testable with zero
//   dispatcher/coroutine setup. `start()` is a separate idempotent method the root
//   composable calls once to wire the socket-event collector and the health poll loop.
// - Phase 2 scope only: voice, Live Activity, location/place, and environment-offer
//   handling from RookModel.swift are intentionally not ported yet (see goal.md's build
//   order). Their corresponding AcpClientEvent cases get explicit no-op branches below so
//   the reducer's `when` stays exhaustive as those events get implemented later.
package com.rookery.rook

import androidx.lifecycle.ViewModel
import com.rookery.rook.location.ArrivalContext
import com.rookery.rook.location.LocationController
import com.rookery.rook.model.AcpClientEvent
import com.rookery.rook.model.AgentDefinition
import com.rookery.rook.model.AgentSessionSummary
import com.rookery.rook.model.ChatBlock
import com.rookery.rook.model.ChatBlockKind
import com.rookery.rook.model.EnvironmentCandidate
import com.rookery.rook.model.EnvironmentListItem
import com.rookery.rook.model.EnvironmentOffer
import com.rookery.rook.model.IdentifyAvailableRequest
import com.rookery.rook.model.Place
import com.rookery.rook.model.PlaceSuggestion
import com.rookery.rook.model.PlanEntry
import com.rookery.rook.model.ToolBlockState
import com.rookery.rook.model.ToolBlockStatus
import com.rookery.rook.net.AcpSocket
import com.rookery.rook.net.RookApi
import com.rookery.rook.net.RookHealthResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

enum class ServerState { UNKNOWN, OFFLINE, ONLINE, UNAUTHORIZED }

/** DFS matching RookModel.swift's agentTree: roots first, children under each root, orphans appended last at depth 0. */
fun buildAgentTree(agents: List<AgentDefinition>): List<Pair<AgentDefinition, Int>> {
    val byParent = agents.groupBy { it.parentId }
    val ids = agents.map { it.id }.toSet()
    val result = mutableListOf<Pair<AgentDefinition, Int>>()
    val visited = mutableSetOf<String>()

    fun visit(agent: AgentDefinition, depth: Int) {
        if (!visited.add(agent.id)) return
        result.add(agent to depth)
        byParent[agent.id].orEmpty().forEach { visit(it, depth + 1) }
    }

    agents.filter { it.parentId == null }.forEach { visit(it, 0) }
    agents.filter { it.parentId != null && it.parentId !in ids }.forEach { visit(it, 0) }
    return result
}

class RookViewModel(
    api: RookApi = RookApi(),
    private val socket: AcpSocket = AcpSocket(),
    private val locationController: LocationController? = null,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
) : ViewModel() {

    // Rebuilt by setServerConnection when the base URL / auth token changes.
    private var api: RookApi = api

    val baseUrlString: String get() = api.baseUrl
    val currentAuthToken: String get() = locationController?.authToken ?: ""

    private val _serverState = MutableStateFlow(ServerState.UNKNOWN)
    val serverState: StateFlow<ServerState> = _serverState.asStateFlow()

    private val _agents = MutableStateFlow<List<AgentDefinition>>(emptyList())
    val agents: StateFlow<List<AgentDefinition>> = _agents.asStateFlow()

    private val _agentsError = MutableStateFlow("")
    val agentsError: StateFlow<String> = _agentsError.asStateFlow()

    private val _selectedAgentId = MutableStateFlow<String?>(null)
    val selectedAgentId: StateFlow<String?> = _selectedAgentId.asStateFlow()

    private val _sessions = MutableStateFlow<List<AgentSessionSummary>>(emptyList())
    val sessions: StateFlow<List<AgentSessionSummary>> = _sessions.asStateFlow()

    private val _sessionsLoading = MutableStateFlow(false)
    val sessionsLoading: StateFlow<Boolean> = _sessionsLoading.asStateFlow()

    private val _sessionsError = MutableStateFlow("")
    val sessionsError: StateFlow<String> = _sessionsError.asStateFlow()

    private val _startingSession = MutableStateFlow(false)
    val startingSession: StateFlow<Boolean> = _startingSession.asStateFlow()

    private val _currentSession = MutableStateFlow<AgentSessionSummary?>(null)
    val currentSession: StateFlow<AgentSessionSummary?> = _currentSession.asStateFlow()

    private val _chatVisible = MutableStateFlow(false)
    val chatVisible: StateFlow<Boolean> = _chatVisible.asStateFlow()

    private val _blocks = MutableStateFlow<List<ChatBlock>>(emptyList())
    val blocks: StateFlow<List<ChatBlock>> = _blocks.asStateFlow()

    private val _queuedMessages = MutableStateFlow<List<String>>(emptyList())
    val queuedMessages: StateFlow<List<String>> = _queuedMessages.asStateFlow()

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

    private val _statusLine = MutableStateFlow("")
    val statusLine: StateFlow<String> = _statusLine.asStateFlow()

    private val _socketConnected = MutableStateFlow(false)
    val socketConnected: StateFlow<Boolean> = _socketConnected.asStateFlow()

    private val _reconnecting = MutableStateFlow(false)
    val reconnecting: StateFlow<Boolean> = _reconnecting.asStateFlow()

    private val _contextUsage = MutableStateFlow<Pair<Int, Int>?>(null)
    val contextUsage: StateFlow<Pair<Int, Int>?> = _contextUsage.asStateFlow()

    // MARK: - Location / environment state (mirrors RookModel.swift)

    // Places/suggestions are forwarded from the shared PlaceStore, not duplicated.
    val places: StateFlow<List<Place>> =
        locationController?.placeStore?.places ?: MutableStateFlow(emptyList())
    val suggestions: StateFlow<List<PlaceSuggestion>> =
        locationController?.placeStore?.suggestions ?: MutableStateFlow(emptyList())

    private val _placeSkillStatus = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val placeSkillStatus: StateFlow<Map<String, Boolean>> = _placeSkillStatus.asStateFlow()

    private val _currentPlaceName = MutableStateFlow<String?>(null)
    val currentPlaceName: StateFlow<String?> = _currentPlaceName.asStateFlow()

    private val _placeEnvironmentId = MutableStateFlow<String?>(null)
    val placeEnvironmentId: StateFlow<String?> = _placeEnvironmentId.asStateFlow()

    private val _nearbyCandidates = MutableStateFlow<List<EnvironmentCandidate>>(emptyList())
    val nearbyCandidates: StateFlow<List<EnvironmentCandidate>> = _nearbyCandidates.asStateFlow()

    private val _pendingOffer = MutableStateFlow<EnvironmentOffer?>(null)
    val pendingOffer: StateFlow<EnvironmentOffer?> = _pendingOffer.asStateFlow()

    private val _offerError = MutableStateFlow<String?>(null)
    val offerError: StateFlow<String?> = _offerError.asStateFlow()

    private val _environmentListItems = MutableStateFlow<List<EnvironmentListItem>>(emptyList())
    val environmentListItems: StateFlow<List<EnvironmentListItem>> = _environmentListItems.asStateFlow()

    private val _environmentsLoading = MutableStateFlow(false)
    val environmentsLoading: StateFlow<Boolean> = _environmentsLoading.asStateFlow()

    private val _environmentsError = MutableStateFlow("")
    val environmentsError: StateFlow<String> = _environmentsError.asStateFlow()

    private val _serverError = MutableStateFlow("")
    val serverError: StateFlow<String> = _serverError.asStateFlow()

    val locationAuthStatus get() = locationController?.authorizationStatus
    val currentLocation get() = locationController?.currentLocation

    fun requestCurrentLocation() { locationController?.requestCurrentLocation() }

    private val _showSettings = MutableStateFlow(false)
    val showSettings: StateFlow<Boolean> = _showSettings.asStateFlow()

    private val _showPlaces = MutableStateFlow(false)
    val showPlaces: StateFlow<Boolean> = _showPlaces.asStateFlow()

    private val _showEnvironments = MutableStateFlow(false)
    val showEnvironments: StateFlow<Boolean> = _showEnvironments.asStateFlow()

    // Server-confirmed entered environment ids — dedup bookkeeping for enter/exit events.
    private val enteredEnvironments = mutableSetOf<String>()

    private var blockCounter = 0
    private var autoResumeAttempted = false
    private var reconnectJob: Job? = null
    private var userCancelledRun = false
    // Set on any content-bearing event during the in-flight turn; checked on RunCompleted.
    // Upstream provider failures (e.g. billing/auth rejections) can come back from the
    // server as a normal RunCompleted with zero content instead of a RunFailed — this
    // catches that case client-side so the failure is still visible in the chat.
    private var turnHasContent = false
    private var started = false

    fun start() {
        if (started) return
        started = true
        // The MovementService emits arrivals/region-changes through the shared controller;
        // wire them to the environment flow (recordVisit is done inside emitArrival).
        locationController?.let { lc ->
            lc.onArrival = { context -> identifyEnvironments(context) }
            lc.onRegionChange = { place -> handlePlace(place) }
            lc.onVisitArrival = { _, _ -> } // suggestion recording handled in emitArrival
        }
        scope.launch { socket.events.collect { handleSocketEvent(it) } }
        scope.launch { socket.isConnected.collect { handleSocketConnectionChange(it) } }
        scope.launch { while (true) { refreshHealth(); delay(4000) } }
    }

    override fun onCleared() {
        scope.cancel()
    }

    // MARK: - Agents / health

    fun loadAgents() {
        scope.launch {
            try {
                _agents.value = api.agents()
                _agentsError.value = ""
            } catch (e: Exception) {
                _agentsError.value = e.message ?: "Failed to load agents"
            }
        }
    }

    fun refreshHealth() {
        scope.launch {
            val wasOnline = _serverState.value == ServerState.ONLINE
            _serverState.value = when (api.healthResult()) {
                is RookHealthResult.Ok -> ServerState.ONLINE
                is RookHealthResult.Unauthorized -> ServerState.UNAUTHORIZED
                else -> ServerState.OFFLINE
            }
            if (_serverState.value == ServerState.ONLINE && !wasOnline) {
                loadAgents()
                autoResumeRecentSessionIfNeeded()
                reannouncePlaceEnvironment()
            }
        }
    }

    /** Test-only seam: sets currentSession directly, mirroring AcpSocket's `internal trackPrompt`. */
    internal fun setCurrentSessionForTest(session: AgentSessionSummary) {
        _currentSession.value = session
    }

    private fun autoResumeRecentSessionIfNeeded() {
        if (autoResumeAttempted || _currentSession.value != null) return
        autoResumeAttempted = true
        scope.launch {
            try {
                val recent = api.recentSession() ?: return@launch
                val started = api.resumeSession(recent)
                enterChat(started, resumed = true, switchToChat = false)
            } catch (e: Exception) {
                // no-op: auto-resume is best-effort
            }
        }
    }

    // MARK: - Session lifecycle

    fun openAgentSessions(agentId: String) {
        _selectedAgentId.value = agentId
        _sessions.value = emptyList()
        _sessionsError.value = ""
        loadSessions(agentId)
    }

    fun closeAgentSessions() {
        _selectedAgentId.value = null
    }

    fun loadSessions(agentId: String) {
        scope.launch {
            _sessionsLoading.value = true
            try {
                _sessions.value = api.sessions(agentId)
                _sessionsError.value = ""
            } catch (e: Exception) {
                _sessionsError.value = e.message ?: "Failed to load sessions"
            } finally {
                _sessionsLoading.value = false
            }
        }
    }

    fun startNewSession(agentId: String, name: String) {
        val trimmedName = name.trim()
        scope.launch {
            _startingSession.value = true
            try {
                val session = api.startSession(agentId, trimmedName.ifEmpty { null })
                enterChat(session, resumed = false)
            } catch (e: Exception) {
                _sessionsError.value = e.message ?: "Failed to start session"
            } finally {
                _startingSession.value = false
            }
        }
    }

    fun resumeSession(session: AgentSessionSummary) {
        scope.launch {
            _startingSession.value = true
            try {
                val started = api.resumeSession(session)
                enterChat(started, resumed = true)
            } catch (e: Exception) {
                _sessionsError.value = e.message ?: "Failed to resume session"
            } finally {
                _startingSession.value = false
            }
        }
    }

    fun openChat() {
        if (_currentSession.value == null) return
        _selectedAgentId.value = null
        _chatVisible.value = true
    }

    private fun enterChat(session: AgentSessionSummary, resumed: Boolean, switchToChat: Boolean = true) {
        reconnectJob?.cancel()
        reconnectJob = null
        _selectedAgentId.value = null
        _chatVisible.value = switchToChat
        _currentSession.value = session
        _blocks.value = emptyList()
        _queuedMessages.value = emptyList()
        _isRunning.value = false
        _statusLine.value = ""
        _contextUsage.value = null
        if (resumed) {
            appendBlock(ChatBlockKind.System("Resumed session — earlier messages aren't replayed."))
        }
        socket.connect(session.id, api.webSocketUrl)
    }

    fun leaveChat() {
        socket.disconnect()
        reconnectJob?.cancel()
        reconnectJob = null
        _currentSession.value = null
        _chatVisible.value = false
    }

    // MARK: - Sending

    fun send(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || _currentSession.value == null) return
        if (_isRunning.value || !socket.isConnected.value) {
            _queuedMessages.value = _queuedMessages.value + trimmed
            if (!socket.isConnected.value) scheduleReconnect(delaySeconds = 0)
        } else {
            deliver(trimmed)
        }
    }

    private fun deliver(text: String) {
        finalizeStreamingBlocks()
        appendBlock(ChatBlockKind.User(text))
        _isRunning.value = true
        _statusLine.value = "Agent is working…"
        turnHasContent = false
        socket.sendPrompt(text)
    }

    fun stopAgent() {
        if (!_isRunning.value) return
        userCancelledRun = true
        _statusLine.value = "Stopping…"
        socket.sendCancel()
    }

    fun removeQueuedMessage(index: Int) {
        _queuedMessages.value = _queuedMessages.value.filterIndexed { i, _ -> i != index }
    }

    private fun deliverNextQueuedIfIdle() {
        if (_isRunning.value || !socket.isConnected.value || _queuedMessages.value.isEmpty()) return
        val next = _queuedMessages.value.first()
        _queuedMessages.value = _queuedMessages.value.drop(1)
        scope.launch {
            delay(120)
            if (_isRunning.value || !socket.isConnected.value) {
                _queuedMessages.value = listOf(next) + _queuedMessages.value
            } else {
                deliver(next)
            }
        }
    }

    // MARK: - Reconnect

    private fun scheduleReconnect(delaySeconds: Int) {
        val session = _currentSession.value ?: return
        reconnectJob?.cancel()
        _reconnecting.value = true
        reconnectJob = scope.launch {
            if (delaySeconds > 0) delay(delaySeconds * 1000L)
            if (_currentSession.value == null) return@launch
            if (api.health()) {
                try {
                    api.resumeSession(session)
                    socket.connect(session.id, api.webSocketUrl)
                    _reconnecting.value = false
                    deliverNextQueuedIfIdle()
                } catch (_: Exception) {
                    scheduleReconnect(delaySeconds = 3)
                }
            } else {
                scheduleReconnect(delaySeconds = 3)
            }
        }
    }

    private fun handleSocketConnectionChange(connected: Boolean) {
        _socketConnected.value = connected
        if (connected) {
            reconnectJob?.cancel()
            reconnectJob = null
            _reconnecting.value = false
            return
        }
        if (_isRunning.value) {
            _isRunning.value = false
            _statusLine.value = ""
            finalizeStreamingBlocks()
            appendErrorBlock("connection", "Connection lost while the agent was running.")
        }
        if (_currentSession.value != null) {
            scheduleReconnect(delaySeconds = 2)
        }
    }

    // MARK: - Reducer

    internal fun handleSocketEvent(event: AcpClientEvent) {
        when (event) {
            is AcpClientEvent.UserMessageChunk -> appendBlock(ChatBlockKind.User(event.text))

            is AcpClientEvent.AgentMessageChunk -> {
                turnHasContent = true
                _statusLine.value = "Responding…"
                appendStreamingText(event.text, isThinking = false)
            }

            is AcpClientEvent.AgentThoughtChunk -> {
                turnHasContent = true
                _statusLine.value = "Thinking…"
                appendStreamingText(event.text, isThinking = true)
            }

            is AcpClientEvent.ToolCallStarted -> {
                turnHasContent = true
                _statusLine.value = "Using tool: ${event.title}"
                val status = if (event.status == "in_progress") ToolBlockStatus.RUNNING else ToolBlockStatus.PENDING
                appendBlock(
                    ChatBlockKind.Tool(
                        ToolBlockState(
                            toolCallId = event.toolCallId,
                            title = event.title,
                            kindLabel = event.kind,
                            status = status,
                            arguments = event.rawInput ?: "",
                            output = ""
                        )
                    ),
                    id = "tool-${event.toolCallId}-$blockCounter"
                )
            }

            is AcpClientEvent.ToolCallUpdate -> updateTool(event.toolCallId) { tool ->
                var updated = tool
                if (event.toolName != null && updated.title.isEmpty()) updated = updated.copy(title = event.toolName)
                updated = when (event.status) {
                    "pending" -> updated.copy(status = ToolBlockStatus.PENDING)
                    "in_progress" -> updated.copy(status = ToolBlockStatus.RUNNING, output = event.output ?: updated.output)
                    "completed" -> updated.copy(status = ToolBlockStatus.COMPLETED, output = event.output ?: updated.output)
                    "failed" -> updated.copy(status = ToolBlockStatus.FAILED, output = event.output ?: updated.output)
                    "cancelled" -> updated.copy(status = ToolBlockStatus.CANCELLED)
                    else -> updated
                }
                updated
            }

            is AcpClientEvent.ToolInputSnapshot -> updateTool(event.toolCallId) { tool ->
                tool.copy(status = ToolBlockStatus.INPUT_STREAMING, arguments = event.text)
            }

            is AcpClientEvent.ToolInputDelta -> updateTool(event.toolCallId) { tool ->
                tool.copy(status = ToolBlockStatus.INPUT_STREAMING, arguments = tool.arguments + event.delta)
            }

            is AcpClientEvent.ToolCallReady -> updateTool(event.toolCallId) { tool ->
                tool.copy(status = ToolBlockStatus.READY)
            }

            is AcpClientEvent.ToolOutputSnapshot -> updateTool(event.toolCallId) { tool ->
                tool.copy(status = ToolBlockStatus.RUNNING, output = event.text)
            }

            is AcpClientEvent.ToolOutputDelta -> updateTool(event.toolCallId) { tool ->
                tool.copy(status = ToolBlockStatus.RUNNING, output = tool.output + event.delta)
            }

            is AcpClientEvent.PermissionRequest -> {}
            is AcpClientEvent.ModesState -> {}
            is AcpClientEvent.CurrentModeUpdate -> {}
            is AcpClientEvent.ConfigOptionUpdate -> {}

            is AcpClientEvent.PlanUpdate -> {
                turnHasContent = true
                upsertPlanBlock(event.entries)
            }

            is AcpClientEvent.UsageUpdate -> _contextUsage.value = event.used to event.size

            is AcpClientEvent.RunCompleted -> {
                finalizeStreamingBlocks()
                _isRunning.value = false
                _statusLine.value = ""
                val wasCancelled = userCancelledRun
                userCancelledRun = false
                if (!turnHasContent && event.stopReason != "cancelled" && !wasCancelled) {
                    appendErrorBlock("run", "Agent produced no response — the model call likely failed upstream (check provider billing/auth).")
                }
                deliverNextQueuedIfIdle()
            }

            is AcpClientEvent.RunFailed -> {
                finalizeStreamingBlocks()
                _isRunning.value = false
                _statusLine.value = ""
                if (userCancelledRun) {
                    userCancelledRun = false
                    appendBlock(ChatBlockKind.System("Stopped."))
                } else {
                    appendErrorBlock("run", event.message)
                }
                deliverNextQueuedIfIdle()
            }

            is AcpClientEvent.ProtocolError -> appendErrorBlock("protocol", event.message)
            is AcpClientEvent.ConnectionError -> {
                appendErrorBlock("connection", event.message)
                // Agent process died server-side — force a session restart by
                // disconnecting the socket, which triggers the reconnect flow.
                socket.disconnect()
            }

            is AcpClientEvent.EnvironmentOffered -> {
                // Ignore a duplicate re-offer of the environment already pending.
                if (_pendingOffer.value?.environmentId != event.offer.environmentId) {
                    _offerError.value = null
                    _pendingOffer.value = event.offer
                }
            }

            is AcpClientEvent.EnvironmentOfferResolved -> {
                val pending = _pendingOffer.value
                if (pending != null &&
                    pending.environmentId == event.environmentId &&
                    pending.bundleHash == event.bundleHash
                ) {
                    _pendingOffer.value = null
                }
            }

            is AcpClientEvent.EnvironmentEntered -> {
                if (enteredEnvironments.add(event.environmentId)) {
                    val (label, websites) = environmentBanner(event.environmentId)
                    appendBlock(ChatBlockKind.Environment(label, websites))
                }
                refreshEnvironmentList()
            }

            is AcpClientEvent.EnvironmentExited -> {
                enteredEnvironments.remove(event.environmentId)
                val suffix = event.error?.let { " ($it)" } ?: ""
                appendBlock(ChatBlockKind.System("Left nearby environment$suffix."))
                refreshEnvironmentList()
            }
        }
    }

    // MARK: - Block helpers

    private fun appendBlock(kind: ChatBlockKind, id: String? = null) {
        blockCounter += 1
        _blocks.value = _blocks.value + ChatBlock(id ?: "block-$blockCounter", kind)
    }

    private fun appendErrorBlock(source: String, message: String) {
        val last = _blocks.value.lastOrNull()?.kind
        if (last is ChatBlockKind.Error && last.source == source && last.message == message) return
        appendBlock(ChatBlockKind.Error(source, message))
    }

    private fun appendStreamingText(text: String, isThinking: Boolean) {
        val last = _blocks.value.lastOrNull()
        val merged = when (val kind = last?.kind) {
            is ChatBlockKind.AssistantText ->
                if (!isThinking && kind.streaming) kind.copy(text = kind.text + text) else null
            is ChatBlockKind.Thinking ->
                if (isThinking && kind.streaming) kind.copy(text = kind.text + text) else null
            else -> null
        }
        if (merged != null && last != null) {
            _blocks.value = _blocks.value.dropLast(1) + last.copy(kind = merged)
        } else if (isThinking) {
            appendBlock(ChatBlockKind.Thinking(text, streaming = true))
        } else {
            appendBlock(ChatBlockKind.AssistantText(text, streaming = true))
        }
    }

    private fun finalizeStreamingBlocks() {
        _blocks.value = _blocks.value.map { block ->
            when (val kind = block.kind) {
                is ChatBlockKind.AssistantText -> if (kind.streaming) block.copy(kind = kind.copy(streaming = false)) else block
                is ChatBlockKind.Thinking -> if (kind.streaming) block.copy(kind = kind.copy(streaming = false)) else block
                else -> block
            }
        }
    }

    private fun updateTool(toolCallId: String, transform: (ToolBlockState) -> ToolBlockState) {
        val current = _blocks.value
        val index = current.indexOfLast { (it.kind as? ChatBlockKind.Tool)?.state?.toolCallId == toolCallId }
        if (index >= 0) {
            val tool = (current[index].kind as ChatBlockKind.Tool).state
            _blocks.value = current.toMutableList().also {
                it[index] = it[index].copy(kind = ChatBlockKind.Tool(transform(tool)))
            }
        } else {
            val synthesized = transform(
                ToolBlockState(
                    toolCallId = toolCallId,
                    title = "Tool",
                    kindLabel = "",
                    status = ToolBlockStatus.RUNNING,
                    arguments = "",
                    output = ""
                )
            )
            appendBlock(ChatBlockKind.Tool(synthesized), id = "tool-$toolCallId-$blockCounter")
        }
    }

    private fun upsertPlanBlock(entries: List<PlanEntry>) {
        val current = _blocks.value
        val index = current.indexOfLast { it.kind is ChatBlockKind.Plan }
        if (index >= 0) {
            _blocks.value = current.toMutableList().also {
                it[index] = it[index].copy(kind = ChatBlockKind.Plan(entries))
            }
        } else {
            appendBlock(ChatBlockKind.Plan(entries))
        }
    }

    // MARK: - Sheet visibility

    fun setShowSettings(visible: Boolean) { _showSettings.value = visible }
    fun setShowPlaces(visible: Boolean) { _showPlaces.value = visible }
    fun setShowEnvironments(visible: Boolean) {
        _showEnvironments.value = visible
        if (visible) refreshEnvironmentList()
    }

    // MARK: - Server connection

    /** Validate + persist a new server URL/token, rebuild the API, and reconnect. */
    fun setServerConnection(baseUrl: String, authToken: String) {
        val trimmedUrl = baseUrl.trim()
        if (!(trimmedUrl.startsWith("http://") || trimmedUrl.startsWith("https://"))) {
            _serverError.value = "URL must start with http:// or https://"
            return
        }
        val trimmedToken = authToken.trim()
        _serverError.value = ""
        locationController?.baseUrl = trimmedUrl
        locationController?.authToken = trimmedToken
        api = RookApi(trimmedUrl, trimmedToken)
        socket.disconnect()
        reconnectJob?.cancel()
        reconnectJob = null
        _currentSession.value = null
        _chatVisible.value = false
        autoResumeAttempted = false
        refreshHealth()
    }

    // MARK: - Location

    /** Start the movement/arrival service and refresh place-derived state. */
    fun enableLocation() {
        locationController?.startService()
        locationController?.refreshAuthorizationStatus()
        refreshMonitoredPlaces()
        refreshPlaceSkillStatus()
    }

    fun disableLocation() {
        locationController?.stopService()
    }

    // MARK: - Recording

    val recording get() = locationController?.recording

    fun startRecording() { locationController?.startRecording() }
    fun stopRecording() { locationController?.stopRecording() }

    /**
     * DEBUG/E2E seam (mirrors iOS's ROOK_SIMULATE_ARRIVAL): wait for the server to come
     * online, then fire a synthetic arrival through the same onArrival path a real dwell
     * would. Triggered by MainActivity from the `simulate_arrival` intent extra.
     */
    fun simulateArrival(latitude: Double, longitude: Double) {
        scope.launch {
            for (i in 0 until 30) {
                if (_serverState.value == ServerState.ONLINE) break
                refreshHealth()
                delay(500)
            }
            locationController?.simulateArrival(latitude, longitude)
        }
    }

    fun refreshAuthorizationStatus() {
        locationController?.refreshAuthorizationStatus()
    }

    // ponytail: the MovementService reads PlaceStore.places live (StateFlow), so there's
    // nothing to push here — re-evaluating "already inside" happens on the next fix. Kept
    // for parity with RookModel.refreshMonitoredPlaces and to refresh server skill status.
    fun refreshMonitoredPlaces() {
        refreshPlaceSkillStatus()
    }

    /** For each place, mark whether the server has a matching bundle (mirrors RookModel). */
    fun refreshPlaceSkillStatus() {
        val store = locationController?.placeStore ?: return
        scope.launch {
            val status = mutableMapOf<String, Boolean>()
            for (place in store.places.value) {
                val preview = runCatching { api.environmentPreview("loc:${place.id}") }.getOrNull()
                status[place.id] = preview?.bundles?.isNotEmpty() == true
            }
            _placeSkillStatus.value = status
        }
    }

    // MARK: - Places passthrough (PlacesScreen)

    fun addPlace(name: String, latitude: Double, longitude: Double, radius: Double) {
        locationController?.placeStore?.add(name, latitude, longitude, radius)
        refreshMonitoredPlaces()
    }

    fun removePlace(place: Place) {
        locationController?.placeStore?.remove(place)
        refreshMonitoredPlaces()
    }

    fun promoteSuggestion(suggestion: PlaceSuggestion, name: String, radius: Double) {
        locationController?.placeStore?.promoteSuggestion(suggestion, name, radius)
        refreshMonitoredPlaces()
    }

    fun dismissSuggestion(suggestion: PlaceSuggestion) {
        locationController?.placeStore?.dismissSuggestion(suggestion)
    }

    // MARK: - Arrival / region (wired to LocationController callbacks)

    // On a settled arrival: POST register-location (server auto-enters). The visible banner
    // is raised later by the environment_entered socket event, which reads nearbyCandidates.
    private fun identifyEnvironments(context: ArrivalContext) {
        if (_serverState.value != ServerState.ONLINE) return
        scope.launch {
            val request = IdentifyAvailableRequest(
                latitude = context.latitude,
                longitude = context.longitude,
                horizontalAccuracy = context.horizontalAccuracy,
                source = "visit",
                dwellSeconds = context.dwellSeconds,
                isStationary = context.isStationary,
                speedMetersPerSecond = context.speedMetersPerSecond,
                observedAt = Instant.now().toString()
            )
            val candidates = runCatching { api.registerLocation(request) }.getOrNull() ?: return@launch
            _nearbyCandidates.value = candidates
            candidates.firstOrNull()?.let { top ->
                val more = if (candidates.size > 1) " (+${candidates.size - 1} more)" else ""
                appendBlock(
                    ChatBlockKind.System(
                        "You appear to be near ${top.displayName}$more. Found ${candidates.size} nearby environment(s)."
                    )
                )
            }
        }
    }

    // On region enter/exit: only register loc:<slug> when the server preview has bundles.
    private fun handlePlace(place: Place?) {
        _currentPlaceName.value = place?.name
        val envId = place?.let { "loc:${it.id}" }
        if (envId == _placeEnvironmentId.value) return
        _placeEnvironmentId.value = envId
        if (place == null || envId == null) return // leaving: state cleared, no REST
        scope.launch {
            val preview = runCatching { api.environmentPreview(envId) }.getOrNull()
            if (preview == null || preview.bundles.isEmpty()) {
                // No skills for this place — roll back (guarded against a newer transition).
                if (_placeEnvironmentId.value == envId) _placeEnvironmentId.value = null
                return@launch
            }
            val metadata = buildJsonObject {
                put("slug", place.id)
                put("latitude", place.latitude)
                put("longitude", place.longitude)
            }
            runCatching { api.registerEnvironment(envId, place.name, metadata) }
        }
    }

    // On offline->online, re-register the current geofenced place env (mirrors RookModel).
    private fun reannouncePlaceEnvironment() {
        val envId = _placeEnvironmentId.value ?: return
        val place = locationController?.placeStore?.places?.value?.firstOrNull { "loc:${it.id}" == envId } ?: return
        scope.launch {
            val metadata = buildJsonObject {
                put("slug", place.id)
                put("latitude", place.latitude)
                put("longitude", place.longitude)
            }
            runCatching { api.registerEnvironment(envId, place.name, metadata) }
        }
    }

    // MARK: - Environment offers / list

    fun decideEnvironment(decision: String) {
        val offer = _pendingOffer.value ?: return
        _pendingOffer.value = null // optimistic; server also emits offer_resolved
        scope.launch {
            runCatching { api.decideEnvironment(offer.environmentId, offer.bundleHash, decision) }
                .onFailure { _offerError.value = it.message ?: "Failed to record decision" }
        }
    }

    fun clearOffer() {
        _pendingOffer.value = null
    }

    fun refreshEnvironmentList() {
        val session = _currentSession.value ?: return
        scope.launch {
            _environmentsLoading.value = true
            try {
                _environmentListItems.value = api.environmentList(session.id)
                _environmentsError.value = ""
            } catch (e: Exception) {
                _environmentsError.value = e.message ?: "Failed to load environments"
            } finally {
                _environmentsLoading.value = false
            }
        }
    }

    fun joinEnvironment(environmentId: String) {
        val session = _currentSession.value ?: return
        scope.launch {
            runCatching { api.enterEnvironment(session.id, environmentId) }
            refreshEnvironmentList()
        }
    }

    fun leaveEnvironment(environmentId: String) {
        val session = _currentSession.value ?: return
        scope.launch {
            runCatching { api.exitEnvironment(session.id, environmentId) }
            refreshEnvironmentList()
        }
    }

    // Mirrors RookModel's locationBannerLabel + orderedUniqueWebsites.
    private fun environmentBanner(environmentId: String): Pair<String?, List<String>> {
        val candidates = _nearbyCandidates.value
        val entered = candidates.firstOrNull { it.environmentId == environmentId }
        val top = candidates.firstOrNull()
        val ambiguous = top != null && (
            top.confidence < 0.7 ||
                (candidates.size >= 2 && top.confidence - candidates[1].confidence < 0.15)
            )
        val label = when {
            ambiguous -> "Surrounding businesses"
            entered != null -> entered.displayName
            else -> top?.displayName
        }
        val ordered = (listOfNotNull(entered) + candidates.filter { it.environmentId != environmentId })
            .mapNotNull { it.website }
        return label to orderedUniqueByHost(ordered)
    }

    private fun orderedUniqueByHost(urls: List<String>): List<String> {
        val seen = mutableSetOf<String>()
        val result = mutableListOf<String>()
        for (url in urls) {
            val host = url.substringAfter("://", url).substringBefore("/").lowercase()
            if (host.isNotEmpty() && seen.add(host)) result.add(url)
        }
        return result
    }
}
