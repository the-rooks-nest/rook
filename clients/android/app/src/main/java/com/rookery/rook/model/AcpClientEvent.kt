// Mirrors AcpClientEvent (bottom of clients/RookKit/Sources/RookKit/Models/ChatBlocks.swift)
//
// Flat client-side event union parsed off the ACP websocket.
package com.rookery.rook.model

sealed class AcpClientEvent {
    data class UserMessageChunk(val text: String) : AcpClientEvent()
    data class AgentMessageChunk(val text: String) : AcpClientEvent()
    data class AgentThoughtChunk(val text: String) : AcpClientEvent()
    data class ToolCallStarted(
        val toolCallId: String,
        val title: String,
        val kind: String,
        val status: String,
        val rawInput: String?
    ) : AcpClientEvent()
    data class ToolCallUpdate(
        val toolCallId: String,
        val status: String,
        val toolName: String?,
        val output: String?
    ) : AcpClientEvent()
    data class ToolInputSnapshot(val toolCallId: String, val toolName: String?, val text: String) : AcpClientEvent()
    data class ToolInputDelta(val toolCallId: String, val toolName: String?, val delta: String) : AcpClientEvent()
    data class ToolCallReady(val toolCallId: String, val toolName: String?) : AcpClientEvent()
    data class ToolOutputSnapshot(val toolCallId: String, val toolName: String?, val text: String) : AcpClientEvent()
    data class ToolOutputDelta(val toolCallId: String, val toolName: String?, val delta: String) : AcpClientEvent()
    data class PermissionRequest(
        val requestId: String,
        val toolCall: AcpPermissionToolCall,
        val options: List<AcpPermissionOption>
    ) : AcpClientEvent()
    data class PlanUpdate(val entries: List<PlanEntry>) : AcpClientEvent()
    data class UsageUpdate(val used: Int, val size: Int, val cost: AcpUsageCost?) : AcpClientEvent()
    data class ModesState(val currentModeId: String, val availableModes: List<AcpSessionMode>) : AcpClientEvent()
    data class CurrentModeUpdate(val modeId: String) : AcpClientEvent()
    data class ConfigOptionUpdate(val configOptions: List<AcpConfigOption>) : AcpClientEvent()
    data class RunCompleted(val stopReason: String) : AcpClientEvent()
    data class RunFailed(val message: String) : AcpClientEvent()
    data class ProtocolError(val message: String) : AcpClientEvent()
    data class ConnectionError(val message: String) : AcpClientEvent()
    data class EnvironmentOffered(val offer: EnvironmentOffer) : AcpClientEvent()
    data class EnvironmentOfferResolved(val environmentId: String) : AcpClientEvent()
    data class EnvironmentEntered(val environmentId: String) : AcpClientEvent()
    data class EnvironmentExited(val environmentId: String, val error: String?) : AcpClientEvent()
}
