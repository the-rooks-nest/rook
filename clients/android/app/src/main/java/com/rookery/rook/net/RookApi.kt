// Mirrors clients/RookKit/Sources/RookKit/Net/RookAPI.swift
package com.rookery.rook.net

import com.rookery.rook.model.AgentDefinition
import com.rookery.rook.model.AgentSessionSummary
import com.rookery.rook.model.CandidateEnvironmentRecord
import com.rookery.rook.model.EnvironmentCandidate
import com.rookery.rook.model.EnvironmentListItem
import com.rookery.rook.model.EnvironmentPreview
import com.rookery.rook.model.IdentifyAvailableRequest
import com.rookery.rook.model.get
import com.rookery.rook.model.stringValue
import com.rookery.rook.model.boolValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
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

/** Distinguishes 401 from other failures so the UI can show an UNAUTHORIZED state. */
sealed class RookHealthResult {
    data object Ok : RookHealthResult()
    data object Unauthorized : RookHealthResult()
    data class HttpStatus(val code: Int) : RookHealthResult()
    data class TransportError(val message: String) : RookHealthResult()
}

/** REST control plane for the Rook server. */
class RookApi(
    val baseUrl: String = "http://127.0.0.1:3000",
    authToken: String = ""
) {
    private val base: HttpUrl = baseUrl.toHttpUrl()
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }

    // Trimmed, empty-as-absent — matches RookAPI.swift's authToken normalization.
    private val token: String = authToken.trim()

    val webSocketUrl: String
        get() {
            val httpForm = base.newBuilder().encodedPath("/api/ws").build().toString()
            return if (base.scheme == "https") httpForm.replaceFirst("https://", "wss://")
            else httpForm.replaceFirst("http://", "ws://")
        }

    val webAppUrl: String get() = baseUrl

    suspend fun healthResult(timeoutMs: Long = 1500): RookHealthResult = withContext(Dispatchers.IO) {
        try {
            val timedClient = client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
            val request = authorized(Request.Builder().url(requestUrl("api/health"))).build()
            timedClient.newCall(request).execute().use { response ->
                when (response.code) {
                    200 -> {
                        val body = runCatching { json.parseToJsonElement(response.body?.string().orEmpty()) }.getOrNull()
                        if (body?.get("ok")?.boolValue == true) RookHealthResult.Ok
                        else RookHealthResult.TransportError("Malformed health response")
                    }
                    401 -> RookHealthResult.Unauthorized
                    else -> RookHealthResult.HttpStatus(response.code)
                }
            }
        } catch (e: Exception) {
            RookHealthResult.TransportError(e.message ?: "Transport error")
        }
    }

    suspend fun health(timeoutMs: Long = 1500): Boolean = healthResult(timeoutMs) is RookHealthResult.Ok

    suspend fun agents(): List<AgentDefinition> {
        @Serializable data class RuntimeResponse(val runtimes: List<AgentDefinition>)
        val body = getJson("api/agent_runtimes")
        return json.decodeFromJsonElement(RuntimeResponse.serializer(), body).runtimes
    }

    suspend fun environmentPreview(environmentId: String): EnvironmentPreview {
        val body = getJson("api/environments/preview", mapOf("environmentId" to environmentId))
        return json.decodeFromJsonElement(EnvironmentPreview.serializer(), body)
    }

    suspend fun registerEnvironment(candidate: CandidateEnvironmentRecord) {
        val payload = json.encodeToJsonElement(CandidateEnvironmentRecord.serializer(), candidate).jsonObject
        postJson("api/environments/register", payload)
    }

    /**
     * Ask the server which `location:` environments are likely available at the given
     * location. Identification only — does not register/enter anything.
     */
    suspend fun identifyAvailableEnvironments(request: IdentifyAvailableRequest): List<EnvironmentCandidate> {
        @Serializable data class IdentifyResponse(val candidates: List<EnvironmentCandidate>)
        val payload = json.encodeToJsonElement(IdentifyAvailableRequest.serializer(), request).jsonObject
        val body = postJson("api/environments/identify", payload)
        return json.decodeFromJsonElement(IdentifyResponse.serializer(), body).candidates
    }

    /**
     * Committing variant: identify, then register/auto-enter the dwell set into the
     * current session/runtime flow. This is what the arrival path (classifier Stationary) calls.
     */
    suspend fun registerLocation(request: IdentifyAvailableRequest): List<EnvironmentCandidate> {
        @Serializable data class IdentifyResponse(val candidates: List<EnvironmentCandidate>)
        val payload = json.encodeToJsonElement(IdentifyAvailableRequest.serializer(), request).jsonObject
        val body = postJson("api/environments/register-location", payload)
        return json.decodeFromJsonElement(IdentifyResponse.serializer(), body).candidates
    }

    suspend fun decideEnvironment(environmentId: String, bundleHash: String, decision: String) {
        postJson(
            "api/environments/decision",
            buildJsonObject {
                put("environmentId", environmentId)
                put("bundleHash", bundleHash)
                put("decision", decision)
            }
        )
    }

    suspend fun enterEnvironment(sessionId: String, environmentId: String): List<String> =
        updateSessionEnvironments(sessionId, listOf(environmentId), emptyList())

    suspend fun exitEnvironment(sessionId: String, environmentId: String): List<String> =
        updateSessionEnvironments(sessionId, emptyList(), listOf(environmentId))

    suspend fun updateSessionEnvironments(sessionId: String, enterEnvironmentIds: List<String>, leaveEnvironmentIds: List<String>): List<String> {
        @Serializable data class EnterResponse(val ok: Boolean = false, val entered: List<String> = emptyList())
        val body = postJson(
            "api/session/environments",
            buildJsonObject {
                put("sessionId", sessionId)
                put("enterEnvironmentIds", json.encodeToJsonElement(ListSerializer(String.serializer()), enterEnvironmentIds))
                put("leaveEnvironmentIds", json.encodeToJsonElement(ListSerializer(String.serializer()), leaveEnvironmentIds))
            }
        )
        return json.decodeFromJsonElement(EnterResponse.serializer(), body).entered
    }

    // GET returns a bare array (mirrors RookAPI.swift environmentList).
    suspend fun environmentList(sessionId: String): List<EnvironmentListItem> {
        val body = getJson("api/environments/list", mapOf("sessionId" to sessionId))
        return json.decodeFromJsonElement(ListSerializer(EnvironmentListItem.serializer()), body)
    }

    // MARK: - Transport helpers

    private fun requestUrl(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        val builder = base.newBuilder().addPathSegments(path)
        query.forEach { (key, value) -> builder.addQueryParameter(key, value) }
        return builder.build()
    }

    // Single chokepoint for the auth header — mirrors RookAPI.swift authorizedRequest.
    private fun authorized(builder: Request.Builder): Request.Builder {
        if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
        return builder
    }

    private suspend fun getJson(path: String, query: Map<String, String> = emptyMap()): JsonElement {
        val request = authorized(Request.Builder().url(requestUrl(path, query))).build()
        return execute(request)
    }

    private suspend fun postJson(path: String, payload: JsonElement): JsonElement {
        val body = json.encodeToString(JsonElement.serializer(), payload).toRequestBody("application/json".toMediaType())
        val request = authorized(Request.Builder().url(requestUrl(path)).post(body)).build()
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
