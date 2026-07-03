// Runnable check for AcpSocket's frame reducer (handleFrame/handleUpdate), ported from
// clients/RookKit/Sources/RookKit/Net/AcpSocket.swift. Drives the reducer directly with
// synthetic JSON-RPC frames — no real socket, no dispatcher needed since handleFrame is a
// plain synchronous function (see AcpSocket.kt's threading-divergence note).
package com.rookery.rook.net

import com.rookery.rook.model.AcpClientEvent
import com.rookery.rook.model.PlanEntry
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AcpReduceTest {

    private fun updateFrame(update: JsonObject): JsonObject = buildJsonObject {
        put("jsonrpc", "2.0")
        put("method", "session/update")
        putJsonObject("params") { put("update", update) }
    }

    @Test
    fun agentMessageChunkEmitsAgentMessageChunk() = runTest {
        val socket = AcpSocket()
        val events = mutableListOf<AcpClientEvent>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            socket.events.take(1).toList(events)
        }

        socket.handleFrame(
            updateFrame(
                buildJsonObject {
                    put("sessionUpdate", "agent_message_chunk")
                    putJsonObject("content") { put("text", "hello") }
                }
            )
        )

        job.join()
        assertEquals(listOf(AcpClientEvent.AgentMessageChunk("hello")), events)
    }

    @Test
    fun toolCallThenUpdateEmitsStartedThenUpdate() = runTest {
        val socket = AcpSocket()
        val events = mutableListOf<AcpClientEvent>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            socket.events.take(2).toList(events)
        }

        socket.handleFrame(
            updateFrame(
                buildJsonObject {
                    put("sessionUpdate", "tool_call")
                    put("toolCallId", "t1")
                    put("title", "Read file")
                    put("kind", "read")
                    put("status", "pending")
                }
            )
        )
        socket.handleFrame(
            updateFrame(
                buildJsonObject {
                    put("sessionUpdate", "tool_call_update")
                    put("toolCallId", "t1")
                    put("status", "completed")
                }
            )
        )

        job.join()
        assertEquals(2, events.size)
        assertTrue(events[0] is AcpClientEvent.ToolCallStarted)
        assertEquals("t1", (events[0] as AcpClientEvent.ToolCallStarted).toolCallId)
        assertTrue(events[1] is AcpClientEvent.ToolCallUpdate)
        assertEquals("completed", (events[1] as AcpClientEvent.ToolCallUpdate).status)
    }

    @Test
    fun planEntriesDefaultPriorityAndStatus() = runTest {
        val socket = AcpSocket()
        val events = mutableListOf<AcpClientEvent>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            socket.events.take(1).toList(events)
        }

        socket.handleFrame(
            updateFrame(
                buildJsonObject {
                    put("sessionUpdate", "plan")
                    putJsonArray("entries") {
                        addJsonObject { put("content", "Step one") }
                        addJsonObject {
                            put("content", "Step two")
                            put("priority", "high")
                            put("status", "completed")
                        }
                    }
                }
            )
        )

        job.join()
        val entries = (events.single() as AcpClientEvent.PlanUpdate).entries
        assertEquals(PlanEntry(0, "Step one", "medium", "pending"), entries[0])
        assertEquals(PlanEntry(1, "Step two", "high", "completed"), entries[1])
    }

    @Test
    fun requestPermissionFrameEmitsPermissionRequest() = runTest {
        val socket = AcpSocket()
        val events = mutableListOf<AcpClientEvent>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            socket.events.take(1).toList(events)
        }

        socket.handleFrame(
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", "perm-1")
                put("method", "session/request_permission")
                putJsonObject("params") {
                    putJsonObject("toolCall") {
                        put("toolCallId", "t1")
                        put("title", "Delete file")
                        put("kind", "delete")
                        put("status", "pending")
                    }
                    putJsonArray("options") {
                        addJsonObject {
                            put("optionId", "allow")
                            put("name", "Allow")
                            put("kind", "allow_once")
                        }
                        addJsonObject {
                            put("optionId", "deny")
                            put("name", "Deny")
                            put("kind", "reject_once")
                        }
                    }
                }
            }
        )

        job.join()
        val event = events.single() as AcpClientEvent.PermissionRequest
        assertEquals("perm-1", event.requestId)
        assertEquals("t1", event.toolCall.toolCallId)
        assertEquals(2, event.options.size)
    }

    @Test
    fun trackPromptThenMatchingResponseEmitsRunCompleted() = runTest {
        val socket = AcpSocket()
        val events = mutableListOf<AcpClientEvent>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            socket.events.take(1).toList(events)
        }

        val requestId = socket.trackPrompt("hi")
        socket.handleFrame(
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", requestId)
                putJsonObject("result") { put("stopReason", "end_turn") }
            }
        )

        job.join()
        assertEquals(AcpClientEvent.RunCompleted("end_turn"), events.single())
    }

    @Test
    fun userMessageEchoIsDeduped() = runTest {
        val socket = AcpSocket()
        val events = mutableListOf<AcpClientEvent>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            socket.events.take(1).toList(events)
        }

        socket.trackPrompt("hello")
        socket.handleFrame(
            updateFrame(
                buildJsonObject {
                    put("sessionUpdate", "user_message_chunk")
                    putJsonObject("content") { put("text", "hello") }
                }
            )
        )
        socket.handleFrame(
            updateFrame(
                buildJsonObject {
                    put("sessionUpdate", "user_message_chunk")
                    putJsonObject("content") { put("text", "different") }
                }
            )
        )

        job.join()
        assertEquals(AcpClientEvent.UserMessageChunk("different"), events.single())
    }
}
