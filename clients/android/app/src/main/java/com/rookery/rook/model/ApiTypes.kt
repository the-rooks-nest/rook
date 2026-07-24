// Mirrors clients/RookKit/Sources/RookKit/Models/ApiTypes.swift
package com.rookery.rook.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.FormatStyle

@Serializable
data class AgentDefinition(
    val id: String,
    val parentId: String?
)

data class AgentSessionSummary(val raw: JsonObject) {
    val id: String get() = raw["id"]?.stringValue ?: raw["sessionId"]?.stringValue ?: ""
    val agent: String get() = raw["agent"]?.stringValue ?: raw["_meta"]?.jsonObject?.get("runtimeId")?.stringValue ?: ""
    val name: String get() = raw["name"]?.stringValue ?: raw["title"]?.stringValue ?: "default"
    val running: Boolean get() = raw["running"]?.boolValue ?: false
    val connectedClients: Int get() = (raw["connectedClients"]?.numberValue ?: 0.0).toInt()

    val createdAt: Instant?
        get() = parseInstant(raw["createdAt"]?.stringValue ?: raw["_meta"]?.jsonObject?.get("startedAt")?.stringValue)

    val updatedAt: Instant?
        get() = parseInstant(raw["updatedAt"]?.stringValue)

    val createdAtLabel: String get() = formatInstant(createdAt)
    val updatedAtLabel: String get() = formatInstant(updatedAt)

    private fun parseInstant(iso: String?): Instant? {
        iso ?: return null
        return try { Instant.parse(iso) } catch (_: DateTimeParseException) { null }
    }

    private fun formatInstant(instant: Instant?): String {
        val date = instant ?: return ""
        val formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault())
        return formatter.format(date)
    }
}

@Serializable
data class EnvironmentArtifactPreview(
    val id: String,
    val files: Map<String, String>
) {
    val sortedFilePaths: List<String> get() = files.keys.sorted()
}

// Phone -> server payload asking which location: environments are likely available at the
// current location (issue #42, phase 1).
@Serializable
data class IdentifyAvailableRequest(
    val latitude: Double,
    val longitude: Double,
    val horizontalAccuracy: Double? = null,
    val source: String? = null,
    val dwellSeconds: Double? = null,
    val isStationary: Boolean? = null,
    val speedMetersPerSecond: Double? = null,
    val observedAt: String? = null
)

// A ranked candidate environment returned by identify-available.
@Serializable
data class EnvironmentCandidate(
    val environmentId: String,
    val displayName: String,
    @SerialName("operator") val operator_: String?,
    val storeNumber: String?,
    val address: String?,
    val latitude: Double?,
    val longitude: Double?,
    val website: String?,
    val distanceMeters: Double?,
    val confidence: Double,
    val matchReasons: List<String>,
    val hasKnownEnvironment: Boolean,
    val possibleSkills: List<String>?
) {
    val id: String get() = environmentId
}

@Serializable
data class RepositoryReadError(
    val code: String,
    val message: String,
    val repository: String,
    val environmentId: String,
    val bundleId: String?,
    val path: String?
) {
    val id: String get() = listOf(code, repository, environmentId, bundleId ?: "", path ?: "").joinToString("|")
}

@Serializable
data class EnvironmentBundlePreview(
    val id: String,
    val bundleId: String,
    val environmentId: String,
    val repository: String,
    val valid: Boolean,
    val bundleHash: String = "",
    val skills: List<EnvironmentArtifactPreview>,
    val mcpServers: List<EnvironmentArtifactPreview>,
    val apps: List<EnvironmentArtifactPreview>,
    val errors: List<RepositoryReadError>
) {
    val allArtifacts: List<EnvironmentArtifactPreview> get() = skills + mcpServers + apps
    val allFilePaths: List<String> get() = allArtifacts.flatMap { it.sortedFilePaths }.sorted()

    fun content(path: String): String? {
        for (artifact in allArtifacts) {
            artifact.files[path]?.let { return it }
        }
        return null
    }
}

@Serializable
data class EnvironmentPreview(
    val environmentId: String,
    val bundles: List<EnvironmentBundlePreview>
)

@Serializable
data class CandidateEnvironmentRecord(
    val id: String,
    val metadata: JsonObject
)

data class EnvironmentOffer(
    val environmentId: String,
    val displayName: String?,
    val bundleId: String,
    val bundleHash: String,
    val sourceName: String?,
    val canonicalSourceUrl: String?,
    val skills: List<String>,
    val mcpServers: List<String>,
    val apps: List<String>
)

// One environment row from GET /api/environments/list.
@Serializable
data class EnvironmentListItem(
    val environmentId: String,
    val displayName: String,
    val sourceName: String? = null,
    val status: String,
    val lastTouchedAt: String,
    val entered: Boolean,
    val bundleCount: Int,
    val approvedBundleCount: Int
) {
    val id: String get() = environmentId
}
