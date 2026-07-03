// Runnable check for RookViewModel's reducer (handleSocketEvent) and send()'s
// queue-vs-deliver decision, ported from clients/iphone/Sources/RookModel.swift. Drives
// handleSocketEvent directly with synthetic AcpClientEvents — no real socket/network, no
// dispatcher needed since the reducer is a plain synchronous function.
//
// ponytail: the full "queue while disconnected, drain on reconnect" round-trip needs a
// fake AcpSocket to flip isConnected to true, which AcpSocket doesn't support (it's not
// `open`). Only the "queues instead of delivering while disconnected" half is covered
// here; the drain half is covered by the plan's manual verification step (toggle airplane
// mode against a real server).
package com.rookery.rook

import com.rookery.rook.model.AcpClientEvent
import com.rookery.rook.model.AgentSessionSummary
import com.rookery.rook.model.ChatBlockKind
import com.rookery.rook.model.ToolBlockStatus
import com.rookery.rook.net.RookApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RookViewModelReduceTest {

    @Test
    fun agentMessageChunksMergeThenFinalizeStopsStreaming() {
        val viewModel = RookViewModel()

        viewModel.handleSocketEvent(AcpClientEvent.AgentMessageChunk("a"))
        viewModel.handleSocketEvent(AcpClientEvent.AgentMessageChunk("b"))

        val merged = viewModel.blocks.value.single().kind as ChatBlockKind.AssistantText
        assertEquals("ab", merged.text)
        assertTrue(merged.streaming)

        viewModel.handleSocketEvent(AcpClientEvent.RunCompleted("end_turn"))

        val finalized = viewModel.blocks.value.single().kind as ChatBlockKind.AssistantText
        assertEquals("ab", finalized.text)
        assertTrue(!finalized.streaming)
    }

    @Test
    fun toolCallUpdateForUnknownIdSynthesizesFallbackBlock() {
        val viewModel = RookViewModel()

        viewModel.handleSocketEvent(AcpClientEvent.ToolCallUpdate("t1", "completed", null, "result"))

        val tool = viewModel.blocks.value.single().kind as ChatBlockKind.Tool
        assertEquals("Tool", tool.state.title)
        assertEquals(ToolBlockStatus.COMPLETED, tool.state.status)
        assertEquals("result", tool.state.output)
    }

    @Test
    fun toolCallUpdateForKnownIdMutatesInPlace() {
        val viewModel = RookViewModel()

        viewModel.handleSocketEvent(
            AcpClientEvent.ToolCallStarted("t1", "Read file", "read", "pending", null)
        )
        viewModel.handleSocketEvent(AcpClientEvent.ToolCallUpdate("t1", "completed", null, "done"))

        assertEquals(1, viewModel.blocks.value.size)
        val tool = viewModel.blocks.value.single().kind as ChatBlockKind.Tool
        assertEquals(ToolBlockStatus.COMPLETED, tool.state.status)
        assertEquals("done", tool.state.output)
    }

    @Test
    fun repeatedIdenticalErrorsAreDeduped() {
        val viewModel = RookViewModel()

        viewModel.handleSocketEvent(AcpClientEvent.ProtocolError("boom"))
        viewModel.handleSocketEvent(AcpClientEvent.ProtocolError("boom"))

        assertEquals(1, viewModel.blocks.value.size)

        viewModel.handleSocketEvent(AcpClientEvent.ConnectionError("different"))

        assertEquals(2, viewModel.blocks.value.size)
    }

    @Test
    fun sendWhileDisconnectedQueuesInsteadOfDelivering() {
        // Unreachable port so send()'s scheduleReconnect(0) health-check fails fast and
        // deterministically, regardless of any real dev server running on 3000. A private
        // TestScope (own virtual scheduler, never advanced) keeps the resulting reconnect
        // retry loop from spinning on real wall-clock delays in the background.
        val viewModel = RookViewModel(
            api = RookApi(baseUrl = "http://127.0.0.1:1"),
            scope = TestScope(UnconfinedTestDispatcher())
        )
        val session = AgentSessionSummary(
            buildJsonObject {
                put("id", "s1")
                put("agent", "default")
            }
        )
        viewModel.setCurrentSessionForTest(session)

        viewModel.send("hi")

        assertEquals(listOf("hi"), viewModel.queuedMessages.value)
        assertTrue(viewModel.blocks.value.isEmpty())
    }
}
