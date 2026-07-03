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
import com.rookery.rook.model.AcpClientEvent
import com.rookery.rook.model.AgentDefinition
import com.rookery.rook.model.AgentSessionSummary
import com.rookery.rook.model.ChatBlock
import com.rookery.rook.model.ChatBlockKind
import com.rookery.rook.model.PlanEntry
import com.rookery.rook.model.ToolBlockState
import com.rookery.rook.model.ToolBlockStatus
import com.rookery.rook.net.AcpSocket
import com.rookery.rook.net.RookApi
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

enum class ServerState { UNKNOWN, OFFLINE, ONLINE }

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
    private val api: RookApi = RookApi(),
    private val socket: AcpSocket = AcpSocket(),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
) : ViewModel() {

    val baseUrlString: String get() = api.baseUrl

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

    private var blockCounter = 0
    private var autoResumeAttempted = false
    private var reconnectJob: Job? = null
    private var userCancelledRun = false
    private var started = false

    fun start() {
        if (started) return
        started = true
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
            val healthy = api.health()
            _serverState.value = if (healthy) ServerState.ONLINE else ServerState.OFFLINE
            if (healthy && !wasOnline) {
                loadAgents()
                autoResumeRecentSessionIfNeeded()
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
                api.resumeSession(session)
                socket.connect(session.id, api.webSocketUrl)
                _reconnecting.value = false
                deliverNextQueuedIfIdle()
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
                _statusLine.value = "Responding…"
                appendStreamingText(event.text, isThinking = false)
            }

            is AcpClientEvent.AgentThoughtChunk -> {
                _statusLine.value = "Thinking…"
                appendStreamingText(event.text, isThinking = true)
            }

            is AcpClientEvent.ToolCallStarted -> {
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

            is AcpClientEvent.PlanUpdate -> upsertPlanBlock(event.entries)

            is AcpClientEvent.UsageUpdate -> _contextUsage.value = event.used to event.size

            is AcpClientEvent.RunCompleted -> {
                finalizeStreamingBlocks()
                _isRunning.value = false
                _statusLine.value = ""
                userCancelledRun = false
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
            is AcpClientEvent.ConnectionError -> appendErrorBlock("connection", event.message)

            // no-op in Phase 2 — revisit in location/skills phase
            is AcpClientEvent.EnvironmentOffered -> {}
            is AcpClientEvent.EnvironmentOfferResolved -> {}
            is AcpClientEvent.EnvironmentEntered -> {}
            is AcpClientEvent.EnvironmentExited -> {}
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
}
