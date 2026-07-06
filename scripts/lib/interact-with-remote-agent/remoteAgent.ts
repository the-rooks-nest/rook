import type { AgentBackend, AgentDefinition, AgentSessionSummary } from "./agent.js";
import type { AcpClientEvent } from "./acpClientTypes.js";
import type {
  AcpConfigOption,
  AcpPermissionRequest,
  AcpPromptResponse,
  AcpSessionModeState,
  AcpSessionUpdate,
  JsonRpcFailure,
  JsonRpcMessage,
  JsonRpcRequest,
} from "./acp.js";
import { isJsonRpcFailure, isJsonRpcNotification, isJsonRpcSuccess } from "./acp.js";
import type { EnvironmentDecision, EnvironmentPreview } from "./environment.js";

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

export async function fetchEnvironmentPreview(environmentId: string): Promise<EnvironmentPreview> {
  const response = await fetch(`/api/environments/preview?environmentId=${encodeURIComponent(environmentId)}`);
  if (!response.ok) throw new Error(`Failed to load environment preview with HTTP ${response.status}`);
  return await response.json() as EnvironmentPreview;
}

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
type PendingRequest = { resolve: (result: unknown) => void; reject: (error: Error) => void };

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

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value as object).length === 0;
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  if (isEmptyObject(value)) return undefined;
  if (typeof value === "object" && value !== null && "content" in value && typeof (value as Record<string, unknown>).content === "string") {
    return (value as Record<string, unknown>).content as string;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Rookery uses ACP extension points for a few session updates/methods.
// See ACP extensibility guidance: https://agentclientprotocol.com/protocol/v1/extensibility
function parseModesState(update: AcpSessionUpdate): AcpSessionModeState | null {
  if (update.sessionUpdate !== "_rookery_modes_state") return null;
  const modes = (update as { modes?: unknown }).modes;
  if (!modes || typeof modes !== "object") return null;
  const currentModeId = (modes as { currentModeId?: unknown }).currentModeId;
  const availableModes = (modes as { availableModes?: unknown }).availableModes;
  if (typeof currentModeId !== "string" || !Array.isArray(availableModes)) return null;
  return {
    currentModeId,
    availableModes: availableModes.filter((mode): mode is AcpSessionModeState["availableModes"][number] => (
      typeof mode === "object"
      && mode !== null
      && typeof (mode as { id?: unknown }).id === "string"
      && typeof (mode as { name?: unknown }).name === "string"
    )).map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(typeof mode.description === "string" ? { description: mode.description } : {}),
    })),
  };
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
  private pendingRequests = new Map<string, PendingRequest>();
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
          for (const pending of this.pendingRequests.values()) pending.reject(error);
          this.pendingRequests.clear();
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

  async cancel(): Promise<void> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Remote agent websocket is not open.");
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.session?.id },
    }));
  }

  async sendSteeringMessage(text: string): Promise<void> {
    // Custom ACP extension method; documented by ACP's extensibility model:
    // https://agentclientprotocol.com/protocol/v1/extensibility
    await this.sendSocketRequest("_rookery/steering_prompt", { sessionId: this.session?.id, text });
  }

  async setMode(modeId: string): Promise<void> {
    const result = await this.sendSocketRequest("session/set_mode", { sessionId: this.session?.id, modeId });
    const modes = result && typeof result === "object" ? (result as { modes?: unknown }).modes : undefined;
    if (modes && typeof modes === "object") {
      const parsed = parseModesState({ sessionUpdate: "_rookery_modes_state", modes } as AcpSessionUpdate);
      if (parsed) {
        this.onAcpEvent?.({ type: "acp_modes_state", currentModeId: parsed.currentModeId, availableModes: parsed.availableModes });
        return;
      }
    }
    this.onAcpEvent?.({ type: "acp_current_mode_update", modeId });
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const result = await this.sendSocketRequest("session/set_config_option", { sessionId: this.session?.id, configId, value }) as { configOptions?: unknown };
    if (Array.isArray(result?.configOptions)) {
      this.onAcpEvent?.({ type: "acp_config_option_update", configOptions: result.configOptions as AcpConfigOption[] });
    }
  }

  async respondToPermissionRequest(requestId: string, outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" }): Promise<void> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Remote agent websocket is not open.");
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: { outcome },
    }));
  }

  private async sendSocketRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Remote agent websocket is not open.");
    const requestId = `rpc-${++this.requestCounter}`;
    const pending = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
    });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params } satisfies JsonRpcRequest));
    return await pending;
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
        const tc = update as { toolCallId: string; title: string; kind?: string; status?: string; rawInput?: unknown; _meta?: unknown };
        const rookery = getRookeryMeta(tc._meta);
        const rawInput = stringifyToolPayload(tc.rawInput) ?? stringifyToolPayload(rookery?.rawInput);
        this.onAcpEvent?.({
          type: "acp_tool_call_started",
          toolCallId: tc.toolCallId,
          title: tc.title,
          kind: tc.kind ?? "other",
          status: tc.status ?? "pending",
          ...(rawInput ? { rawInput } : {}),
        });
        break;
      }
      case "tool_call_update": {
        const tcu = update as { toolCallId: string; status: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown; _meta?: unknown };
        const rookery = getRookeryMeta(tcu._meta);
        const toolName = typeof rookery?.toolName === "string" ? rookery.toolName : undefined;
        const inputText = stringifyToolPayload(tcu.rawInput);
        if (inputText !== undefined && inputText !== "{}" && inputText.length > 0) {
          this.onAcpEvent?.({
            type: "acp_tool_input_delta",
            toolCallId: tcu.toolCallId,
            delta: inputText,
          });
        }

        const output = textFromContentItems(tcu.content) || stringifyToolPayload(tcu.rawOutput) || undefined;
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
      case "plan": {
        const plan = update as { entries: import("./acp").AcpPlanEntry[] };
        this.onAcpEvent?.({ type: "acp_plan_update", entries: plan.entries });
        break;
      }
      case "usage_update": {
        const usage = update as { used: number; size: number; cost?: { amount: number; currency: string } | null };
        this.onAcpEvent?.({ type: "acp_usage_update", used: usage.used, size: usage.size, ...(usage.cost !== undefined ? { cost: usage.cost } : {}) });
        break;
      }
      case "current_mode_update": {
        const currentMode = update as { modeId: string };
        this.onAcpEvent?.({ type: "acp_current_mode_update", modeId: currentMode.modeId });
        break;
      }
      case "config_option_update": {
        const config = update as { configOptions: AcpConfigOption[] };
        this.onAcpEvent?.({ type: "acp_config_option_update", configOptions: config.configOptions });
        break;
      }
      case "_rookery_modes_state": {
        const parsed = parseModesState(update);
        if (parsed) {
          this.onAcpEvent?.({ type: "acp_modes_state", currentModeId: parsed.currentModeId, availableModes: parsed.availableModes });
        }
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
      case "_rookery_status_changed": {
        const status = typeof update.status === "string" ? update.status : "busy";
        this.onAcpEvent?.({ type: "acp_status_changed", status: status as never, ...(typeof update.message === "string" ? { message: update.message } : {}) });
        break;
      }
      case "_rookery_run_failed":
        this.onAcpEvent?.({ type: "acp_run_failed", error: String(update.error ?? "Run failed") });
        break;
      case "_rookery_connection_error":
        this.onAcpEvent?.({ type: "acp_connection_error", error: String(update.error ?? "Connection error") });
        break;
      case "_rookery_assistant_message_completed":
        this.onAcpEvent?.({ type: "acp_finalize_blocks" });
        break;
      default:
        break;
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("method" in message && "id" in message && message.method === "session/request_permission") {
      const permissionRequest = message as AcpPermissionRequest;
      const params = permissionRequest.params;
      if (!params) return;
      this.onAcpEvent?.({
        type: "acp_permission_request",
        requestId: String(permissionRequest.id),
        toolCall: params.toolCall,
        options: params.options,
      });
      return;
    }

    if (isJsonRpcNotification(message)) {
      const params = message.params as { update?: AcpSessionUpdate } | undefined;
      if (message.method === "session/update" && params?.update) {
        this.handleSessionUpdate(params.update);
      }
      return;
    }

    if (isJsonRpcFailure(message)) {
      const requestId = message.id === null ? undefined : String(message.id);
      const pending = requestId ? this.pendingRequests.get(requestId) : undefined;
      if (pending && requestId) {
        this.pendingRequests.delete(requestId);
        pending.reject(new Error(message.error.message));
        return;
      }
      this.onAcpEvent?.({ type: "acp_connection_error", error: message.error.message });
      this.rejectPendingRun(message.error.message, requestId);
      return;
    }

    if (isJsonRpcSuccess(message)) {
      const requestId = String(message.id);
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.resolve(message.result);
        return;
      }
      this.handlePromptResponse(message as AcpPromptResponse);
    }
  }
}
