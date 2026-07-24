package com.rookery.rook.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ApiTypesSerializationTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun environmentCandidateDecodesServerShapeWithoutBestGuessStoreNumber() {
        val candidate = json.decodeFromString<EnvironmentCandidate>(
            """
            {
              "environmentId": "location:target.com/tn-37000-1-main-st",
              "displayName": "Target",
              "operator": "Target",
              "storeNumber": "1234",
              "address": "1 Main St",
              "latitude": 36.0,
              "longitude": -86.0,
              "website": "https://target.com/store/1234",
              "distanceMeters": 42.0,
              "confidence": 0.98,
              "matchReasons": ["same building"],
              "hasKnownEnvironment": true,
              "possibleSkills": ["inventory"]
            }
            """.trimIndent()
        )

        assertEquals("location:target.com/tn-37000-1-main-st", candidate.environmentId)
        assertEquals("1234", candidate.storeNumber)
        assertEquals("Target", candidate.operator_)
    }

    @Test
    fun environmentListItemDecodesMissingSourceNameAsNull() {
        val item = json.decodeFromString<EnvironmentListItem>(
            """
            {
              "environmentId": "web:github.com/the-rooks-nest/rook",
              "displayName": "the-rooks-nest / rook",
              "status": "active",
              "lastTouchedAt": "2026-07-23T00:00:00Z",
              "entered": false,
              "bundleCount": 1,
              "approvedBundleCount": 1
            }
            """.trimIndent()
        )

        assertNull(item.sourceName)
        assertEquals("web:github.com/the-rooks-nest/rook", item.environmentId)
    }
}
