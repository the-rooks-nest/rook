/**
 * ACP-shaped client events that the ChatPanel reducer consumes directly.
 * Replaces the old SessionEvent translation layer.
 */
import type { AgentRunStatus } from "../shared/agent.js";

export type AcpClientEvent =
  | AcpClientStatusChanged
  | AcpClientUserMessage
  | AcpClientUserMessageChunk
  | AcpClientAgentMessageChunk
  | AcpClientAgentThoughtChunk
  | AcpClientToolCallStarted
  | AcpClientToolCallUpdate
  | AcpClientRunCompleted
  | AcpClientRunFailed
  | AcpClientConnectionError
  | AcpClientEnvironmentEvent;

export interface AcpClientStatusChanged {
  type: "acp_status_changed";
  status: AgentRunStatus;
  message?: string;
}

export interface AcpClientUserMessage {
  type: "acp_user_message";
  text: string;
  messageId?: string;
}

export interface AcpClientUserMessageChunk {
  type: "acp_user_message_chunk";
  text: string;
  messageId?: string;
}

export interface AcpClientAgentMessageChunk {
  type: "acp_agent_message_chunk";
  text: string;
  messageId?: string;
}

export interface AcpClientAgentThoughtChunk {
  type: "acp_agent_thought_chunk";
  text: string;
  messageId?: string;
}

export interface AcpClientToolCallStarted {
  type: "acp_tool_call_started";
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  rawInput?: string;
}

export interface AcpClientToolCallUpdate {
  type: "acp_tool_call_update";
  toolCallId: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  toolName?: string;
  /** Tool output text (for completed) or error message (for failed). */
  output?: string;
}

export interface AcpClientRunCompleted {
  type: "acp_run_completed";
  stopReason: string;
}

export interface AcpClientRunFailed {
  type: "acp_run_failed";
  error: string;
}

export interface AcpClientConnectionError {
  type: "acp_connection_error";
  error: string;
}

export interface AcpClientEnvironmentEvent {
  type: "acp_environment_event";
  kind: string;
  payload?: unknown;
}
