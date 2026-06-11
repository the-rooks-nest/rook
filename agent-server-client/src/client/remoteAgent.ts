import { AgentBackend, AgentDefinition, AgentSessionSummary } from "./agent";
import type { AcpClientEvent } from "./acpClientTypes";
import type { AcpPromptResponse, AcpSessionUpdate, JsonRpcMessage } from "../shared/acp";
import { isJsonRpcFailure, isJsonRpcNotification, isJsonRpcSuccess } from "./acpToSessionEvent";

export type RemoteSessionEvent = AcpClientEvent;

export async function fetchAgentDefinitions(): Promise<AgentDefinition[]> {
  const response = await fetch("/api/agents");
  if (!response.ok) throw new Error(`Failed to load agents with HTTP ${response.status}`);
  const payload = await response.json() as { agents: AgentDefinition[] };
  return payload.agents;
}

export async function fetchAgentSessions(agent: AgentBackend): Promise<AgentSessionSummary[]> {
  const response = await fetch(`/api/agent/sessions?agent=${encodeURIComponent(agent)}`);
  if (!response.ok) throw new Error(`Failed to load sessions with HTTP ${response.status}`);
  const payload = await response.json() as { sessions: AgentSessionSummary[] };
  return payload.sessions;
}

export async function fetchMostRecentSession(): Promise<AgentSessionSummary | null> {
  const response = await fetch("/api/agent/session/recent");
  if (!response.ok) throw new Error(`Failed to load recent session with HTTP ${response.status}`);
  const payload = await response.json() as { session: AgentSessionSummary | null };
  return payload.session;
}

import type { EnvironmentDecision, EnvironmentPreview } from "../shared/environment";

export async function fetchEnvironmentPreview(environmentId: string): Promise<EnvironmentPreview> {
  const response = await fetch(`/api/environments/preview?environmentId=${encodeURIComponent(environmentId)}`);
  if (!response.ok) throw new Error(`Failed to load environment preview with HTTP ${response.status}`);
  return await response.json() as EnvironmentPreview;
}

/** Record a 2×2 decision for an environment (global; the server applies it to every open session). */
export async function decideEnvironment(environmentId: string, decision: EnvironmentDecision): Promise<void> {
  const response = await fetch("/api/environments/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentId, decision }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to record environment decision with HTTP ${response.status}`);
  }
}

export interface RemoteAgentOptions {
  startEndpoint?: string;
  wsEndpoint?: string;
  backend?: AgentBackend;
  session?: AgentSessionSummary;
  sessionName?: string;
  includeReplayEvents?: boolean;
  restartExisting?: boolean;
  onAcpEvent?: (event: AcpClientEvent) => void;
}

export interface RemoteAgentStartResult {
  ok: boolean;
  agent: AgentBackend;
  session: AgentSessionSummary;
}

interface RemoteAgentStartPayload {
  ok: boolean;
  agent: AgentBackend;
  session: AgentSessionSummary;
}

type PendingRun = { requestId: string; promptText: string; resolve: () => void; reject: (error: Error) => void };

function websocketUrl(endpoint: string, sessionId: string): string {
  const base = endpoint.includes("://")
    ? new URL(endpoint)
    : new URL(endpoint, window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.searchParams.set("sessionId", sessionId);
  return base.toString();
}

function getRookeryMeta(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = (value as Record<string, unknown>).rookery;
  return meta && typeof meta === "object" ? meta as Record<string, unknown> : undefined;
}

function textFromContentItems(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const value = (item as { content?: { text?: unknown } }).content?.text;
      return typeof value === "string" ? value : "";
    })
    .join("\n");
}

export class RemoteAgent {
  private startEndpoint: string;
  private wsEndpoint: string;
  private backend: AgentBackend;
  private session?: AgentSessionSummary;
  private sessionName?: string;
  private includeReplayEvents?: boolean;
  private restartExisting?: boolean;
  private onAcpEvent?: (event: AcpClientEvent) => void;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pendingRuns: PendingRun[] = [];
  private requestCounter = 0;
  private closed = false;

  constructor(options: RemoteAgentOptions = {}) {
    this.startEndpoint = options.startEndpoint ?? "/api/agent/start";
    this.wsEndpoint = options.wsEndpoint ?? "/api/ws";
    this.backend = options.backend ?? "PiAgent";
    this.session = options.session;
    this.sessionName = options.sessionName;
    this.includeReplayEvents = options.includeReplayEvents;
    this.restartExisting = options.restartExisting;
    this.onAcpEvent = options.onAcpEvent;
  }

  async start(): Promise<RemoteAgentStartResult> {
    const response = await fetch(this.startEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: this.backend,
        ...(this.session ? { session: this.session } : {}),
        ...(this.sessionName ? { sessionName: this.sessionName } : {}),
        ...(this.restartExisting ? { restartExisting: true } : {}),
      }),
    });

    if (!response.ok) {
      const error = `Remote agent start failed with HTTP ${response.status}`;
      this.onAcpEvent?.({ type: "acp_connection_error", error });
      throw new Error(error);
    }

    const result = await response.json() as RemoteAgentStartPayload;
    this.session = result.session;
    return { ok: result.ok, agent: result.agent, session: result.session };
  }

  async connect(): Promise<void> {
    if (this.closed) this.closed = false;
    if (!this.session) await this.start();
    if (!this.session) throw new Error("Remote agent has no session.");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    const url = websocketUrl(this.wsEndpoint, this.session.id);

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.connectPromise = null;
        resolve();
      }, { once: true });

      socket.addEventListener("message", (event) => {
        try {
          this.handleMessage(JSON.parse(String(event.data)) as JsonRpcMessage);
        } catch {
          this.onAcpEvent?.({ type: "acp_connection_error", error: "Failed to parse websocket payload" });
        }
      });

      socket.addEventListener("error", () => {
        const error = new Error("Remote agent websocket error.");
        if (this.connectPromise) {
          this.connectPromise = null;
          reject(error);
        }
        this.onAcpEvent?.({ type: "acp_connection_error", error: error.message });
      });

      socket.addEventListener("close", () => {
        this.socket = null;
        if (this.connectPromise) {
          this.connectPromise = null;
          reject(new Error("Remote agent websocket closed before connecting."));
          return;
        }
        if (!this.closed) {
          const error = new Error("Remote agent websocket closed.");
          while (this.pendingRuns.length > 0) this.pendingRuns.shift()?.reject(error);
          this.onAcpEvent?.({ type: "acp_connection_error", error: error.message });
        }
      }, { once: true });
    });

    return this.connectPromise;
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  async run(userMessage: string): Promise<void> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const error = new Error("Remote agent websocket is not open.");
      this.onAcpEvent?.({ type: "acp_run_failed", error: error.message });
      throw error;
    }

    const requestId = `prompt-${++this.requestCounter}`;
    const run = new Promise<void>((resolve, reject) => {
      this.pendingRuns.push({ requestId, promptText: userMessage, resolve, reject });
    });

    this.onAcpEvent?.({ type: "acp_user_message", text: userMessage });
    this.onAcpEvent?.({ type: "acp_status_changed", status: "busy", message: "Agent is working" });

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/prompt",
      params: {
        sessionId: this.session!.id,
        prompt: [{ type: "text", text: userMessage }],
      },
    }));

    return run;
  }

  private resolvePendingRun(requestId: string): void {
    const index = this.pendingRuns.findIndex((pending) => pending.requestId === requestId);
    if (index === -1) return;
    this.pendingRuns.splice(index, 1)[0]?.resolve();
  }

  private rejectPendingRun(error: string, requestId?: string): void {
    const index = requestId
      ? this.pendingRuns.findIndex((pending) => pending.requestId === requestId)
      : 0;
    if (index === -1) return;
    const pending = this.pendingRuns.splice(index, 1)[0];
    if (!pending) return;
    pending.reject(new Error(error));
  }

  private handlePromptResponse(message: AcpPromptResponse): void {
    const stopReason = message.result?.stopReason ?? "end_turn";
    if (stopReason === "cancelled") {
      this.onAcpEvent?.({ type: "acp_run_failed", error: "Run cancelled" });
      this.rejectPendingRun("Run cancelled", String(message.id));
      return;
    }
    this.onAcpEvent?.({ type: "acp_run_completed", stopReason });
    this.resolvePendingRun(String(message.id));
  }

  private handleSessionUpdate(update: AcpSessionUpdate): void {
    const sessionUpdate = update.sessionUpdate;
    switch (sessionUpdate) {
      case "user_message_chunk": {
        const chunk = update as { messageId?: string; content?: { type?: unknown; text?: unknown } };
        if (chunk.content?.type === "text" && typeof chunk.content.text === "string") {
          this.onAcpEvent?.({
            type: "acp_user_message_chunk",
            text: chunk.content.text,
            ...(typeof chunk.messageId === "string" ? { messageId: chunk.messageId } : {}),
          });
        }
        break;
      }
      case "agent_message_chunk": {
        const chunk = update as { content?: { type?: unknown; text?: unknown } };
        if (chunk.content?.type === "text" && typeof chunk.content.text === "string") {
          this.onAcpEvent?.({ type: "acp_agent_message_chunk", text: chunk.content.text });
        }
        break;
      }
      case "agent_thought_chunk": {
        const chunk = update as { content?: { type?: unknown; text?: unknown } };
        if (chunk.content?.type === "text" && typeof chunk.content.text === "string") {
          this.onAcpEvent?.({ type: "acp_agent_thought_chunk", text: chunk.content.text });
        }
        break;
      }
      case "tool_call": {
        const tc = update as { toolCallId: string; title: string; kind?: string; status?: string; _meta?: unknown };
        const rookery = getRookeryMeta(tc._meta);
        this.onAcpEvent?.({
          type: "acp_tool_call_started",
          toolCallId: tc.toolCallId,
          title: tc.title,
          kind: tc.kind ?? "other",
          status: tc.status ?? "pending",
          ...(typeof rookery?.rawInput === "string" ? { rawInput: rookery.rawInput } : {}),
        });
        break;
      }
      case "tool_call_update": {
        const tcu = update as { toolCallId: string; status: string; content?: unknown; _meta?: unknown };
        const rookery = getRookeryMeta(tcu._meta);
        const toolName = typeof rookery?.toolName === "string" ? rookery.toolName : undefined;
        const output = textFromContentItems(tcu.content) || undefined;
        const validStatuses = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;
        const mappedStatus = (validStatuses as readonly string[]).includes(tcu.status)
          ? tcu.status as "pending" | "in_progress" | "completed" | "failed" | "cancelled"
          : "in_progress";
        this.onAcpEvent?.({
          type: "acp_tool_call_update",
          toolCallId: tcu.toolCallId,
          status: mappedStatus,
          ...(toolName ? { toolName } : {}),
          ...(output ? { output } : {}),
        });
        break;
      }
      case "_rookery_tool_input_delta":
      case "_rookery_tool_call_ready":
      case "_rookery_tool_output_delta": {
        // Legacy custom updates — translate to tool_call_update style events
        const legacy = update as { toolCallId?: unknown; toolName?: unknown; delta?: unknown; status?: unknown };
        const toolCallId = String(legacy.toolCallId ?? "");
        const toolName = typeof legacy.toolName === "string" ? legacy.toolName : undefined;
        if (sessionUpdate === "_rookery_tool_input_delta") {
          this.onAcpEvent?.({
            type: "acp_tool_call_update",
            toolCallId,
            status: "in_progress",
            ...(toolName ? { toolName } : {}),
            output: String(legacy.delta ?? ""),
          });
        } else if (sessionUpdate === "_rookery_tool_output_delta") {
          this.onAcpEvent?.({
            type: "acp_tool_call_update",
            toolCallId,
            status: "in_progress",
            ...(toolName ? { toolName } : {}),
            output: String(legacy.delta ?? ""),
          });
        }
        // _rookery_tool_call_ready is handled as a silent status transition on the server side
        break;
      }
      case "_rookery_environment_event": {
        const env = update as { kind?: unknown; payload?: unknown };
        if (typeof env.kind === "string") {
          this.onAcpEvent?.({
            type: "acp_environment_event",
            kind: env.kind,
            payload: env.payload,
          });
        }
        break;
      }
      case "_rookery_run_completed":
      case "_rookery_run_failed":
      case "_rookery_status_changed":
      case "_rookery_assistant_message_started":
      case "_rookery_assistant_message_completed":
      case "_rookery_assistant_message_error":
      case "_rookery_protocol_error":
      case "_rookery_connection_error":
        // Handled by the server-side translation layer; not emitted to client in new path
        break;
      default:
        break;
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isJsonRpcNotification(message)) {
      const params = message.params as { update?: AcpSessionUpdate } | undefined;
      if (message.method === "session/update" && params?.update) {
        this.handleSessionUpdate(params.update);
      }
      return;
    }

    if (isJsonRpcFailure(message)) {
      this.onAcpEvent?.({ type: "acp_connection_error", error: message.error.message });
      this.rejectPendingRun(message.error.message, message.id === null ? undefined : String(message.id));
      return;
    }

    if (isJsonRpcSuccess(message)) {
      this.handlePromptResponse(message as AcpPromptResponse);
    }
  }
}
