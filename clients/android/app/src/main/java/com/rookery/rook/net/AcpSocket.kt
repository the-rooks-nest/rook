// Mirrors clients/RookKit/Sources/RookKit/Net/AcpSocket.swift
//
// JSON-RPC 2.0 websocket client for /api/ws?sessionId=.... Sends ACP requests over the
// websocket and reduces ACP-shaped notifications into flat AcpClientEvents. Mirrors the
// web client's behavior closely: user_message_chunk echoes and _rookery_run_*/
// _rookery_status_changed updates are ignored; prompt completion comes from the JSON-RPC
// response for the corresponding session/prompt request id.
//
// Divergences from the Swift source (all intentional):
// - Events are a SharedFlow<AcpClientEvent> + StateFlow<Boolean> instead of closures.
// - No @MainActor: OkHttp's WebSocketListener callbacks fire on OkHttp's reader thread,
//   so each callback only `scope.launch{}`s the actual reducer call — same threading
//   contract Swift's @MainActor imposes on callers. `handleFrame`/`handleUpdate` stay
//   plain synchronous functions, which is what makes them unit-testable with no dispatcher.
// - `sendPrompt`'s counter/pendingPromptIds/echo bookkeeping is split into `trackPrompt`
//   so a test can drive the reducer without a real socket. Behavior is identical.
// - Unlike Swift's `teardown()` (which sets its stored `isConnected` flag directly,
//   bypassing `onConnectionChange`), this always updates the `isConnected` StateFlow —
//   Kotlin's single reactive source of truth has no separate "state vs. notify" channel
//   to replicate, and a stale StateFlow value would be a real bug, not just a quirk.
// - `stringifyToolPayload` folds JSON null / non-string primitives to their plain content
//   rather than replicating `String(describing: NSNull())`/`NSNumber` formatting quirks —
//   those only affect the rare non-object tool payload, not shown to differ in practice.
package com.rookery.rook.net

import com.rookery.rook.model.AcpClientEvent
import com.rookery.rook.model.AcpConfigOption
import com.rookery.rook.model.AcpConfigOptionValue
import com.rookery.rook.model.AcpModesState
import com.rookery.rook.model.AcpPermissionOption
import com.rookery.rook.model.AcpPermissionToolCall
import com.rookery.rook.model.AcpSessionMode
import com.rookery.rook.model.AcpUsageCost
import com.rookery.rook.model.EnvironmentOffer
import com.rookery.rook.model.PlanEntry
import com.rookery.rook.model.boolValue
import com.rookery.rook.model.get
import com.rookery.rook.model.numberValue
import com.rookery.rook.model.stringValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.net.URLEncoder

sealed class SocketRequestException(message: String) : Exception(message) {
    class NotConnected : SocketRequestException("Not connected to the session")
    class Encoding : SocketRequestException("Failed to encode websocket request")
    class Server(message: String) : SocketRequestException(message)
}

class AcpSocket(
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
) {
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    private val prettyJson = Json { ignoreUnknownKeys = true; prettyPrint = true }

    private val _events = MutableSharedFlow<AcpClientEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<AcpClientEvent> = _events.asSharedFlow()

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    private var webSocket: WebSocket? = null
    private var sessionId: String? = null
    private var generation = 0
    private var requestCounter = 0
    private val pendingPromptIds = mutableSetOf<String>()
    private val pendingRequests = mutableMapOf<String, CompletableDeferred<JsonObject>>()
    private val pendingUserMessageEchoes = ArrayDeque<String>()
    private val lastToolInputSnapshots = mutableMapOf<String, String>()
    private val lastToolOutputSnapshots = mutableMapOf<String, String>()

    fun connect(sessionId: String, webSocketUrl: String) {
        teardown()
        generation += 1
        val currentGeneration = generation
        this.sessionId = sessionId

        val separator = if (webSocketUrl.contains("?")) "&" else "?"
        val urlWithQuery = "$webSocketUrl$separator" + "sessionId=" + URLEncoder.encode(sessionId, "UTF-8")
        val request = Request.Builder().url(urlWithQuery).build()
        webSocket = client.newWebSocket(request, Listener(currentGeneration))
        setConnected(true)
    }

    fun disconnect() {
        teardown()
    }

    /** Cancel the in-flight turn (ACP `session/cancel` notification). */
    fun sendCancel() {
        val ws = webSocket ?: return
        val sid = sessionId ?: return
        sendFrame(
            ws,
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("method", "session/cancel")
                putJsonObject("params") { put("sessionId", sid) }
            }
        )
    }

    fun sendPrompt(text: String) {
        val ws = webSocket
        val sid = sessionId
        if (ws == null || sid == null) {
            emit(AcpClientEvent.ConnectionError("Not connected to the session"))
            return
        }
        val requestId = trackPrompt(text)
        val sent = sendFrame(
            ws,
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", requestId)
                put("method", "session/prompt")
                putJsonObject("params") {
                    put("sessionId", sid)
                    putJsonArray("prompt") {
                        addJsonObject {
                            put("type", "text")
                            put("text", text)
                        }
                    }
                }
            }
        )
        if (!sent) {
            handleTransportFailure(IOException("Failed to send prompt"))
        }
    }

    internal fun trackPrompt(text: String): String {
        requestCounter += 1
        val requestId = "prompt-$requestCounter"
        pendingPromptIds.add(requestId)
        pendingUserMessageEchoes.addLast(text)
        return requestId
    }

    suspend fun sendSteeringMessage(text: String) {
        if (text.trim().isEmpty()) return
        sendSocketRequest("_rookery/steering_prompt", buildJsonObject { put("text", text) })
    }

    suspend fun setMode(modeId: String) {
        val result = sendSocketRequest("session/set_mode", buildJsonObject { put("modeId", modeId) })
        val modes = parseModesState(result["modes"])
        if (modes != null) {
            emit(AcpClientEvent.ModesState(modes.currentModeId, modes.availableModes))
        } else {
            emit(AcpClientEvent.CurrentModeUpdate(modeId))
        }
    }

    suspend fun setConfigOption(configId: String, value: String) {
        val result = sendSocketRequest(
            "session/set_config_option",
            buildJsonObject {
                put("configId", configId)
                put("value", value)
            }
        )
        val configOptions = parseConfigOptions(result["configOptions"])
        if (configOptions != null) {
            emit(AcpClientEvent.ConfigOptionUpdate(configOptions))
        }
    }

    fun respondToPermissionRequest(requestId: String, optionId: String?) {
        val ws = webSocket ?: throw SocketRequestException.NotConnected()
        val outcome = if (optionId != null) {
            buildJsonObject {
                put("outcome", "selected")
                put("optionId", optionId)
            }
        } else {
            buildJsonObject { put("outcome", "cancelled") }
        }
        sendFrame(
            ws,
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", requestId)
                putJsonObject("result") { put("outcome", outcome) }
            }
        )
    }

    // MARK: - Receive

    private inner class Listener(private val listenerGeneration: Int) : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) = dispatch { handleMessage(text) }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = dispatch { handleMessage(bytes.utf8()) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dispatch { handleTransportFailure(t) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
            dispatch { handleTransportFailure(IOException("Socket closed: $reason")) }

        private fun dispatch(block: () -> Unit) {
            scope.launch {
                if (generation == listenerGeneration) block()
            }
        }
    }

    private fun handleTransportFailure(error: Throwable) {
        if (!_isConnected.value) return
        pendingPromptIds.clear()
        val continuations = pendingRequests.toMap()
        pendingRequests.clear()
        webSocket = null
        setConnected(false)
        continuations.values.forEach { it.completeExceptionally(error) }
    }

    private fun setConnected(connected: Boolean) {
        _isConnected.value = connected
    }

    private fun handleMessage(text: String) {
        val frame = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        handleFrame(frame)
    }

    internal fun handleFrame(frame: JsonObject) {
        val method = frame["method"]?.stringValue

        if (method == "session/request_permission") {
            val idElement = frame["id"]
            val params = frame["params"] as? JsonObject
            val toolCall = params?.get("toolCall")?.let(::parsePermissionToolCall)
            val options = params?.get("options")?.let(::parsePermissionOptions)
            if (idElement != null && toolCall != null && options != null) {
                emit(AcpClientEvent.PermissionRequest(idString(idElement), toolCall, options))
                return
            }
        }

        if (method == "session/update") {
            val params = frame["params"] as? JsonObject
            val update = params?.get("update") as? JsonObject
            if (update != null) {
                handleUpdate(update)
                return
            }
        }

        val idElement = frame["id"]
        if (idElement != null) {
            val requestIdString = idString(idElement)
            val pending = pendingRequests.remove(requestIdString)
            if (pending != null) {
                val result = frame["result"] as? JsonObject
                val error = frame["error"] as? JsonObject
                when {
                    result != null -> pending.complete(result)
                    error != null -> pending.completeExceptionally(
                        SocketRequestException.Server(error["message"]?.stringValue ?: "Request failed")
                    )
                    else -> pending.complete(JsonObject(emptyMap()))
                }
                return
            }

            if (pendingPromptIds.remove(requestIdString)) {
                val result = frame["result"] as? JsonObject
                if (result != null) {
                    emit(AcpClientEvent.RunCompleted(result["stopReason"]?.stringValue ?: "end_turn"))
                } else {
                    val error = frame["error"] as? JsonObject
                    emit(AcpClientEvent.RunFailed(error?.get("message")?.stringValue ?: "Run failed"))
                }
                return
            }
        }

        val error = frame["error"] as? JsonObject
        if (error != null) {
            emit(AcpClientEvent.ConnectionError(error["message"]?.stringValue ?: "Server error"))
        }
    }

    private fun handleUpdate(update: JsonObject) {
        val kind = update["sessionUpdate"]?.stringValue ?: return
        when (kind) {
            "user_message_chunk" -> {
                val text = contentText(update["content"])
                if (text != null) {
                    if (pendingUserMessageEchoes.firstOrNull() == text) {
                        pendingUserMessageEchoes.removeFirst()
                    } else {
                        emit(AcpClientEvent.UserMessageChunk(text))
                    }
                }
            }
            "agent_message_chunk" ->
                contentText(update["content"])?.let { emit(AcpClientEvent.AgentMessageChunk(it)) }
            "agent_thought_chunk" ->
                contentText(update["content"])?.let { emit(AcpClientEvent.AgentThoughtChunk(it)) }
            "tool_call" -> {
                val toolCallId = update["toolCallId"]?.stringValue ?: return
                val meta = rookeryMeta(update)
                val rawInput = stringifyToolPayload(update["rawInput"]) ?: stringifyToolPayload(meta?.get("rawInput"))
                if (rawInput != null) lastToolInputSnapshots[toolCallId] = rawInput
                emit(
                    AcpClientEvent.ToolCallStarted(
                        toolCallId = toolCallId,
                        title = update["title"]?.stringValue ?: "Tool",
                        kind = update["kind"]?.stringValue ?: "",
                        status = update["status"]?.stringValue ?: "pending",
                        rawInput = rawInput
                    )
                )
            }
            "tool_call_update" -> {
                val toolCallId = update["toolCallId"]?.stringValue ?: return
                val meta = rookeryMeta(update)
                val inputText = stringifyToolPayload(update["rawInput"])
                if (inputText != null) {
                    lastToolInputSnapshots[toolCallId] = inputText
                    emit(AcpClientEvent.ToolInputSnapshot(toolCallId, meta?.get("toolName")?.stringValue, inputText))
                }
                val validStatuses = setOf("pending", "in_progress", "completed", "failed", "cancelled")
                val statusRaw = update["status"]?.stringValue
                val status = if (statusRaw != null && validStatuses.contains(statusRaw)) statusRaw else "in_progress"
                val outputSnapshot = contentItemsText(update["content"]) ?: stringifyToolPayload(update["rawOutput"])
                if (outputSnapshot != null) {
                    lastToolOutputSnapshots[toolCallId] = outputSnapshot
                    emit(AcpClientEvent.ToolOutputSnapshot(toolCallId, meta?.get("toolName")?.stringValue, outputSnapshot))
                }
                emit(
                    AcpClientEvent.ToolCallUpdate(
                        toolCallId = toolCallId,
                        status = status,
                        toolName = meta?.get("toolName")?.stringValue,
                        output = null
                    )
                )
            }
            "_rookery_tool_input_delta" -> {
                val toolCallId = update["toolCallId"]?.stringValue ?: return
                val delta = update["delta"]?.stringValue ?: return
                emit(AcpClientEvent.ToolInputDelta(toolCallId, update["toolName"]?.stringValue, delta))
            }
            "_rookery_tool_call_ready" -> {
                val toolCallId = update["toolCallId"]?.stringValue ?: return
                emit(AcpClientEvent.ToolCallReady(toolCallId, update["toolName"]?.stringValue))
            }
            "_rookery_tool_output_delta" -> {
                val toolCallId = update["toolCallId"]?.stringValue ?: return
                val delta = update["delta"]?.stringValue ?: return
                emit(AcpClientEvent.ToolOutputDelta(toolCallId, update["toolName"]?.stringValue, delta))
            }
            "plan" -> {
                val rawEntries = update["entries"] as? JsonArray ?: return
                val entries = rawEntries.mapIndexed { index, entryElement ->
                    val entry = entryElement as? JsonObject
                    PlanEntry(
                        id = index,
                        content = entry?.get("content")?.stringValue ?: "",
                        priority = entry?.get("priority")?.stringValue ?: "medium",
                        status = entry?.get("status")?.stringValue ?: "pending"
                    )
                }
                emit(AcpClientEvent.PlanUpdate(entries))
            }
            "usage_update" -> {
                val used = intValue(update["used"]) ?: return
                val size = intValue(update["size"]) ?: return
                emit(AcpClientEvent.UsageUpdate(used, size, parseUsageCost(update["cost"])))
            }
            "_rookery_modes_state" ->
                parseModesState(update["modes"])?.let { emit(AcpClientEvent.ModesState(it.currentModeId, it.availableModes)) }
            "current_mode_update" ->
                update["modeId"]?.stringValue?.let { emit(AcpClientEvent.CurrentModeUpdate(it)) }
            "config_option_update" ->
                parseConfigOptions(update["configOptions"])?.let { emit(AcpClientEvent.ConfigOptionUpdate(it)) }
            "_rookery_environment_event" -> handleEnvironmentEvent(update)
            "_rookery_protocol_error" -> emit(AcpClientEvent.ProtocolError(update["error"]?.stringValue ?: "Protocol error"))
            "_rookery_connection_error" -> emit(AcpClientEvent.ConnectionError(update["error"]?.stringValue ?: "Connection error"))
            else -> {
                // user_message_chunk echoes are handled above; _rookery_run_*,
                // _rookery_status_changed, _rookery_assistant_* are intentionally
                // ignored, matching the web client.
            }
        }
    }

    private fun handleEnvironmentEvent(update: JsonObject) {
        val kind = update["kind"]?.stringValue ?: return
        val payload = update["payload"] as? JsonObject ?: JsonObject(emptyMap())
        val environmentId = payload["environmentId"]?.stringValue ?: return
        when (kind) {
            "environment_offer_available" -> emit(
                AcpClientEvent.EnvironmentOffered(
                    EnvironmentOffer(
                        environmentId = environmentId,
                        sourceName = payload["sourceName"]?.stringValue,
                        canonicalSourceUrl = payload["canonicalSourceUrl"]?.stringValue
                    )
                )
            )
            "environment_offer_resolved" -> emit(AcpClientEvent.EnvironmentOfferResolved(environmentId))
            "environment_entered" -> emit(AcpClientEvent.EnvironmentEntered(environmentId))
            "environment_exited" -> emit(AcpClientEvent.EnvironmentExited(environmentId, payload["error"]?.stringValue))
            else -> {}
        }
    }

    // MARK: - Helpers

    private fun teardown() {
        generation += 1
        pendingPromptIds.clear()
        val continuations = pendingRequests.toMap()
        pendingRequests.clear()
        pendingUserMessageEchoes.clear()
        lastToolInputSnapshots.clear()
        lastToolOutputSnapshots.clear()
        webSocket?.close(1000, null)
        webSocket = null
        sessionId = null
        _isConnected.value = false
        continuations.values.forEach { it.completeExceptionally(SocketRequestException.NotConnected()) }
    }

    private suspend fun sendSocketRequest(method: String, params: JsonObject): JsonObject {
        val ws = webSocket ?: throw SocketRequestException.NotConnected()
        val sid = sessionId ?: throw SocketRequestException.NotConnected()
        requestCounter += 1
        val requestId = "rpc-$requestCounter"
        val mergedParams = JsonObject(params + ("sessionId" to JsonPrimitive(sid)))
        val deferred = CompletableDeferred<JsonObject>()
        pendingRequests[requestId] = deferred
        val sent = sendFrame(
            ws,
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", requestId)
                put("method", method)
                put("params", mergedParams)
            }
        )
        if (!sent) {
            pendingRequests.remove(requestId)
            throw SocketRequestException.Encoding()
        }
        return deferred.await()
    }

    private fun sendFrame(ws: WebSocket, frame: JsonObject): Boolean {
        val text = json.encodeToString(JsonElement.serializer(), frame)
        return ws.send(text)
    }

    private fun emit(event: AcpClientEvent) {
        _events.tryEmit(event)
    }

    private fun idString(element: JsonElement): String =
        (element as? JsonPrimitive)?.content ?: element.toString()

    private fun rookeryMeta(update: JsonObject): JsonObject? =
        (update["_meta"] as? JsonObject)?.get("rookery") as? JsonObject

    private fun contentText(value: JsonElement?): String? {
        val content = value as? JsonObject ?: return null
        return content["text"]?.stringValue
    }

    private fun contentItemsText(value: JsonElement?): String? {
        val items = value as? JsonArray ?: return null
        val texts = items.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val nested = obj["content"] as? JsonObject
            nested?.get("text")?.stringValue ?: obj["text"]?.stringValue
        }.filter { it.isNotEmpty() }
        if (texts.isEmpty()) return null
        return texts.joinToString("\n")
    }

    private fun stringifyToolPayload(value: JsonElement?): String? {
        if (value == null || value is JsonNull) return null
        if (value is JsonPrimitive) return value.content
        if (value is JsonObject && value.isEmpty()) return null
        val text = prettyJson.encodeToString(JsonElement.serializer(), value)
        val trimmed = text.trim()
        return if (trimmed == "{}") null else trimmed
    }

    private fun parseUsageCost(value: JsonElement?): AcpUsageCost? {
        val dict = value as? JsonObject ?: return null
        val amount = dict["amount"]?.numberValue ?: return null
        val currency = dict["currency"]?.stringValue ?: return null
        return AcpUsageCost(amount, currency)
    }

    private fun parseModesState(value: JsonElement?): AcpModesState? {
        val dict = value as? JsonObject ?: return null
        val currentModeId = dict["currentModeId"]?.stringValue ?: return null
        val availableModesValue = dict["availableModes"] as? JsonArray ?: return null
        val availableModes = availableModesValue.mapNotNull { (it as? JsonObject)?.let(::parseSessionMode) }
        return AcpModesState(currentModeId, availableModes)
    }

    private fun parseSessionMode(value: JsonObject): AcpSessionMode? {
        val id = value["id"]?.stringValue ?: return null
        val name = value["name"]?.stringValue ?: return null
        return AcpSessionMode(id, name, value["description"]?.stringValue)
    }

    private fun parseConfigOptions(value: JsonElement?): List<AcpConfigOption>? {
        val items = value as? JsonArray ?: return null
        return items.mapNotNull { (it as? JsonObject)?.let(::parseConfigOption) }
    }

    private fun parseConfigOption(value: JsonObject): AcpConfigOption? {
        val id = value["id"]?.stringValue ?: return null
        val name = value["name"]?.stringValue ?: return null
        val type = value["type"]?.stringValue ?: return null
        val currentValue = value["currentValue"]?.stringValue ?: return null
        val optionsValue = value["options"] as? JsonArray ?: return null
        val options = optionsValue.mapNotNull { (it as? JsonObject)?.let(::parseConfigOptionValue) }
        return AcpConfigOption(
            id = id,
            name = name,
            description = value["description"]?.stringValue,
            category = value["category"]?.stringValue,
            type = type,
            currentValue = currentValue,
            options = options
        )
    }

    private fun parseConfigOptionValue(value: JsonObject): AcpConfigOptionValue? {
        val rawValue = value["value"]?.stringValue ?: return null
        val name = value["name"]?.stringValue ?: return null
        return AcpConfigOptionValue(rawValue, name, value["description"]?.stringValue)
    }

    private fun parsePermissionToolCall(value: JsonElement?): AcpPermissionToolCall? {
        val dict = value as? JsonObject ?: return null
        val toolCallId = dict["toolCallId"]?.stringValue ?: return null
        val title = dict["title"]?.stringValue ?: return null
        val kind = dict["kind"]?.stringValue ?: return null
        val status = dict["status"]?.stringValue ?: return null
        return AcpPermissionToolCall(toolCallId, title, kind, status)
    }

    private fun parsePermissionOptions(value: JsonElement?): List<AcpPermissionOption>? {
        val items = value as? JsonArray ?: return null
        return items.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val optionId = obj["optionId"]?.stringValue ?: return@mapNotNull null
            val name = obj["name"]?.stringValue ?: return@mapNotNull null
            val kind = obj["kind"]?.stringValue ?: return@mapNotNull null
            AcpPermissionOption(optionId, name, kind)
        }
    }

    private fun intValue(value: JsonElement?): Int? = value?.numberValue?.toInt()
}
