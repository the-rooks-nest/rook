// Mirrors clients/RookKit/Sources/RookKit/Net/RookAPI.swift
package com.rookery.rook.net

import com.rookery.rook.model.AgentDefinition
import com.rookery.rook.model.AgentSessionSummary
import com.rookery.rook.model.EnvironmentCandidate
import com.rookery.rook.model.EnvironmentPreview
import com.rookery.rook.model.IdentifyAvailableRequest
import com.rookery.rook.model.get
import com.rookery.rook.model.stringValue
import com.rookery.rook.model.boolValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class RookApiException(message: String) : Exception(message)

/** REST control plane for the Rook server. */
class RookApi(val baseUrl: String = "http://127.0.0.1:3000") {
    private val base: HttpUrl = baseUrl.toHttpUrl()
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }

    val webSocketUrl: String
        get() {
            val httpForm = base.newBuilder().encodedPath("/api/ws").build().toString()
            return if (base.scheme == "https") httpForm.replaceFirst("https://", "wss://")
            else httpForm.replaceFirst("http://", "ws://")
        }

    val webAppUrl: String get() = baseUrl

    suspend fun health(timeoutMs: Long = 1500): Boolean = withContext(Dispatchers.IO) {
        try {
            val timedClient = client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
            val request = Request.Builder().url(requestUrl("api/health")).build()
            timedClient.newCall(request).execute().use { response ->
                if (response.code != 200) return@use false
                val body = json.parseToJsonElement(response.body?.string().orEmpty())
                body["ok"]?.boolValue == true
            }
        } catch (e: Exception) {
            false
        }
    }

    suspend fun agents(): List<AgentDefinition> {
        @Serializable data class AgentsResponse(val agents: List<AgentDefinition>)
        val body = getJson("api/agents")
        return json.decodeFromJsonElement(AgentsResponse.serializer(), body).agents
    }

    suspend fun sessions(agent: String): List<AgentSessionSummary> {
        val body = getJson("api/agent/sessions", mapOf("agent" to agent))
        val items = body["sessions"] as? JsonArray ?: return emptyList()
        return items.map { AgentSessionSummary(it.jsonObject) }
    }

    suspend fun recentSession(): AgentSessionSummary? {
        val body = getJson("api/agent/session/recent")
        val session = body["session"] ?: return null
        if (session is JsonNull) return null
        return AgentSessionSummary(session.jsonObject)
    }

    suspend fun startSession(agent: String, sessionName: String?): AgentSessionSummary {
        val payload = buildJsonObject {
            put("agent", agent)
            if (!sessionName.isNullOrEmpty()) put("sessionName", sessionName)
        }
        return start(payload)
    }

    suspend fun resumeSession(session: AgentSessionSummary): AgentSessionSummary {
        val payload = buildJsonObject {
            put("agent", session.agent)
            put("session", session.raw)
        }
        return start(payload)
    }

    private suspend fun start(payload: JsonObject): AgentSessionSummary {
        val body = postJson("api/agent/start", payload)
        val session = body["session"]
        if (session == null || session is JsonNull) {
            throw RookApiException("Server returned no session")
        }
        return AgentSessionSummary(session.jsonObject)
    }

    suspend fun environmentPreview(environmentId: String): EnvironmentPreview {
        val body = getJson("api/environments/preview", mapOf("environmentId" to environmentId))
        return json.decodeFromJsonElement(EnvironmentPreview.serializer(), body)
    }

    suspend fun registerEnvironment(id: String, sourceName: String, metadata: JsonObject) {
        postJson(
            "api/environments/register",
            buildJsonObject {
                put("id", id)
                put("sourceName", sourceName)
                put("metadata", metadata)
            }
        )
    }

    suspend fun unregisterEnvironment(id: String) {
        postJson("api/environments/unregister", buildJsonObject { put("id", id) })
    }

    /**
     * Ask the server which `loc:` environments are likely available at the given
     * location. Identification only — does not register/enter anything.
     */
    suspend fun identifyAvailableEnvironments(request: IdentifyAvailableRequest): List<EnvironmentCandidate> {
        @Serializable data class IdentifyResponse(val candidates: List<EnvironmentCandidate>)
        val payload = json.encodeToJsonElement(IdentifyAvailableRequest.serializer(), request).jsonObject
        val body = postJson("api/environments/identify-available", payload)
        return json.decodeFromJsonElement(IdentifyResponse.serializer(), body).candidates
    }

    suspend fun decideEnvironment(environmentId: String, decision: String) {
        postJson(
            "api/environments/decision",
            buildJsonObject {
                put("environmentId", environmentId)
                put("decision", decision)
            }
        )
    }

    // MARK: - Transport helpers

    private fun requestUrl(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        val builder = base.newBuilder().addPathSegments(path)
        query.forEach { (key, value) -> builder.addQueryParameter(key, value) }
        return builder.build()
    }

    private suspend fun getJson(path: String, query: Map<String, String> = emptyMap()): JsonElement {
        val request = Request.Builder().url(requestUrl(path, query)).build()
        return execute(request)
    }

    private suspend fun postJson(path: String, payload: JsonElement): JsonElement {
        val body = json.encodeToString(JsonElement.serializer(), payload).toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url(requestUrl(path)).post(body).build()
        return execute(request)
    }

    private suspend fun execute(request: Request): JsonElement = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (response.code >= 400) {
                val errorBody = runCatching { json.parseToJsonElement(text) }.getOrNull()
                val message = errorBody?.get("error")?.stringValue ?: "Server error (${response.code})"
                throw RookApiException(message)
            }
            if (text.isEmpty()) JsonNull else json.parseToJsonElement(text)
        }
    }
}
