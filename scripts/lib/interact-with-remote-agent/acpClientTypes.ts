import type { AgentRunStatus } from "./agent.js";
import type { AcpConfigOption, AcpPermissionOption, AcpPermissionToolCall, AcpPlanEntry, AcpSessionMode } from "./acp.js";

export type AcpClientEvent =
  | { type: "acp_status_changed"; status: AgentRunStatus; message?: string }
  | { type: "acp_user_message"; text: string; messageId?: string }
  | { type: "acp_user_message_chunk"; text: string; messageId?: string }
  | { type: "acp_agent_message_chunk"; text: string; messageId?: string }
  | { type: "acp_agent_thought_chunk"; text: string; messageId?: string }
  | { type: "acp_tool_call_started"; toolCallId: string; title: string; kind: string; status: string; rawInput?: string }
  | { type: "acp_tool_call_update"; toolCallId: string; status: "pending" | "in_progress" | "completed" | "failed" | "cancelled"; toolName?: string; output?: string }
  | { type: "acp_tool_input_delta"; toolCallId: string; delta: string }
  | { type: "acp_permission_request"; requestId: string; toolCall: AcpPermissionToolCall; options: AcpPermissionOption[] }
  | { type: "acp_plan_update"; entries: AcpPlanEntry[] }
  | { type: "acp_usage_update"; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { type: "acp_modes_state"; currentModeId: string; availableModes: AcpSessionMode[] }
  | { type: "acp_current_mode_update"; modeId: string }
  | { type: "acp_config_option_update"; configOptions: AcpConfigOption[] }
  | { type: "acp_finalize_blocks" }
  | { type: "acp_run_completed"; stopReason: string }
  | { type: "acp_run_failed"; error: string }
  | { type: "acp_connection_error"; error: string }
  | { type: "acp_environment_event"; kind: string; payload?: unknown };
