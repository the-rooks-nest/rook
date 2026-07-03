// Mirrors clients/RookKit/Sources/RookKit/Models/ChatBlocks.swift
package com.rookery.rook.model

enum class ToolBlockStatus {
    PENDING, INPUT_STREAMING, READY, RUNNING, COMPLETED, FAILED, CANCELLED;

    val label: String
        get() = when (this) {
            PENDING -> "Pending"
            INPUT_STREAMING -> "Preparing"
            READY -> "Ready"
            RUNNING -> "Running"
            COMPLETED -> "Done"
            FAILED -> "Failed"
            CANCELLED -> "Cancelled"
        }

    val isTerminal: Boolean
        get() = this == COMPLETED || this == FAILED || this == CANCELLED
}

data class ToolBlockState(
    val toolCallId: String,
    val title: String,
    val kindLabel: String,
    val status: ToolBlockStatus,
    val arguments: String,
    val output: String
)

data class PlanEntry(
    val id: Int,
    val content: String,
    val priority: String,
    val status: String
)

data class AcpUsageCost(
    val amount: Double,
    val currency: String
)

data class AcpSessionMode(
    val id: String,
    val name: String,
    val description: String? = null
)

data class AcpModesState(
    val currentModeId: String,
    val availableModes: List<AcpSessionMode>
)

data class AcpConfigOptionValue(
    val value: String,
    val name: String,
    val description: String? = null
) {
    val id: String get() = value
}

data class AcpConfigOption(
    val id: String,
    val name: String,
    val description: String? = null,
    val category: String? = null,
    val type: String,
    val currentValue: String,
    val options: List<AcpConfigOptionValue>
)

data class AcpPermissionOption(
    val optionId: String,
    val name: String,
    val kind: String
) {
    val id: String get() = optionId
}

data class AcpPermissionToolCall(
    val toolCallId: String,
    val title: String,
    val kind: String,
    val status: String
)

sealed class ChatBlockKind {
    data class User(val text: String) : ChatBlockKind()
    data class AssistantText(val text: String, val streaming: Boolean) : ChatBlockKind()
    data class Thinking(val text: String, val streaming: Boolean) : ChatBlockKind()
    data class Tool(val state: ToolBlockState) : ChatBlockKind()
    data class Error(val source: String, val message: String) : ChatBlockKind()
    data class System(val text: String) : ChatBlockKind()
    data class Plan(val entries: List<PlanEntry>) : ChatBlockKind()
}

data class ChatBlock(
    val id: String,
    val kind: ChatBlockKind
)
