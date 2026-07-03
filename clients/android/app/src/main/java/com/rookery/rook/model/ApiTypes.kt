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

// Wraps the raw session record JSON so resume can send it back to POST /api/agent/start
// verbatim, including fields this app doesn't model.
data class AgentSessionSummary(val raw: JsonObject) {
    val id: String get() = raw["id"]?.stringValue ?: ""
    val agent: String get() = raw["agent"]?.stringValue ?: ""
    val name: String get() = raw["name"]?.stringValue ?: "default"
    val running: Boolean get() = raw["running"]?.boolValue ?: false
    val connectedClients: Int get() = (raw["connectedClients"]?.numberValue ?: 0.0).toInt()

    val createdAt: Instant?
        get() {
            val iso = raw["createdAt"]?.stringValue ?: return null
            return try {
                Instant.parse(iso)
            } catch (e: DateTimeParseException) {
                null
            }
        }

    val createdAtLabel: String
        get() {
            val date = createdAt ?: return ""
            val formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
                .withZone(ZoneId.systemDefault())
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

// Phone -> server payload asking which loc: environments are likely available at the
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
    val bestGuessStoreNumber: String?,
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

data class EnvironmentOffer(
    val environmentId: String,
    val sourceName: String?,
    val canonicalSourceUrl: String?
)
