import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SessionEvent } from "../../shared/realtime.js";
import type { JsonRpcFailure, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcSuccess } from "../../shared/acp.js";
import { acpServerMessageToSessionEvents } from "../../client/acpToSessionEvent.js";
import { appendSessionRecord, createSessionRecord, type AgentRestartMetadata, type AgentSessionRecord } from "./sessionLog.js";

type JsonObject = Record<string, unknown>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface BaseAgentOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  sessionCwd?: string;
  startupTimeoutMs?: number;
  agentName?: string;
}

export interface AgentConstructor<T extends BaseAgent = BaseAgent> {
  new (...args: any[]): T;
  readonly name: string;
  prototype: T;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonRpcErrorMessage(message: JsonRpcFailure): string {
  return message.error.message || `ACP request failed (${message.error.code})`;
}

function asJsonRpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export class BaseAgent {
  protected started = false;
  protected sessionRecord?: AgentSessionRecord;
  protected readonly options: BaseAgentOptions;
  protected restartMetadata?: AgentRestartMetadata;

  private activeRunReject?: (error: Error) => void;
  private sessionName = "default";
  private eventSink?: (event: SessionEvent) => void;
  private process: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private requestIndex = 0;
  private stopping = false;
  protected sessionIdValue?: string;
  private suppressUserMessageText?: string;
  private isReplayingSessionLoad = false;

  constructor(options: BaseAgentOptions, restartMetadata?: AgentRestartMetadata) {
    this.options = options;
    this.restartMetadata = restartMetadata;
  }

  setEventSink(eventSink: ((event: SessionEvent) => void) | undefined): void {
    this.eventSink = eventSink;
  }

  setSessionName(name: string): void {
    this.sessionName = name.trim() || "default";
  }

  get record(): AgentSessionRecord | undefined {
    return this.sessionRecord;
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  protected get agentName(): string {
    return this.options.agentName ?? this.constructor.name;
  }

  protected createSessionRecord(restart: AgentRestartMetadata): AgentSessionRecord {
    return createSessionRecord({ agent: this.agentName, name: this.sessionName, restart });
  }

  protected emitSessionEvent(event: SessionEvent): void {
    this.eventSink?.(event);
  }

  async run(userMessage: string): Promise<void> {
    let rejectThisRun: (error: Error) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      rejectThisRun = reject;
      this.activeRunReject = reject;
    });

    const running = (async () => {
      await this.ensureStarted();
      await this.runImpl(userMessage);
    })();

    try {
      await Promise.race([running, stopped]);
    } finally {
      if (this.activeRunReject === rejectThisRun) this.activeRunReject = undefined;
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.started) return;

    if (this.restartMetadata) {
      await this.restart(this.restartMetadata);
    } else {
      await this.start();
      this.sessionRecord = await this.registerSession();
      await appendSessionRecord(this.sessionRecord);
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    this.activeRunReject?.(new Error(`${this.agentName} stopped.`));
    this.activeRunReject = undefined;
    await this.stopImpl();
  }

  protected async start(): Promise<void> {
    await this.startProcess();
    await this.initialize();
  }

  protected async restart(metadata: AgentRestartMetadata): Promise<void> {
    await this.startProcess();
    await this.initialize();

    const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
    const cwd = typeof metadata.cwd === "string" ? metadata.cwd : this.getSessionCwd();
    if (!sessionId) throw new Error("ACP restart metadata is missing sessionId.");
    this.sessionIdValue = sessionId;
    this.isReplayingSessionLoad = true;
    try {
      await this.sendRequestWithTimeout("session/load", this.buildSessionLoadParams(sessionId, cwd), this.options.startupTimeoutMs ?? 15_000);
    } finally {
      this.isReplayingSessionLoad = false;
    }
    this.emitSessionEvent({ type: "assistant_message_completed" });
  }

  protected async registerSession(): Promise<AgentSessionRecord> {
    const cwd = this.getSessionCwd();
    const result = await this.sendRequestWithTimeout("session/new", this.buildSessionNewParams(cwd), this.options.startupTimeoutMs ?? 15_000);
    const sessionId = isObject(result) && typeof result.sessionId === "string" ? result.sessionId : undefined;
    if (!sessionId) throw new Error("ACP session/new did not return a sessionId.");
    this.sessionIdValue = sessionId;

    return this.createSessionRecord({
      sessionId,
      cwd,
    });
  }

  protected buildSessionNewParams(cwd: string): unknown {
    return { cwd, mcpServers: [] };
  }

  protected buildSessionLoadParams(sessionId: string, cwd: string): unknown {
    return { sessionId, cwd, mcpServers: [] };
  }

  protected async runImpl(userMessage: string): Promise<void> {
    if (!this.sessionIdValue) throw new Error("ACP agent session is not initialized.");

    this.suppressUserMessageText = userMessage;
    this.emitSessionEvent({ type: "user_message", text: userMessage, queued: false });

    const result = await this.sendRequest("session/prompt", {
      sessionId: this.sessionIdValue,
      prompt: [{ type: "text", text: userMessage }],
    });

    const stopReason = isObject(result) && typeof result.stopReason === "string" ? result.stopReason : "end_turn";
    if (stopReason === "cancelled") {
      this.emitSessionEvent({ type: "run_failed", error: "ACP prompt was cancelled." });
      throw new Error("ACP prompt was cancelled.");
    }

    this.emitSessionEvent({ type: "run_completed" });
  }

  protected async stopImpl(): Promise<void> {
    if (!this.process) return;
    this.stopping = true;

    if (this.sessionIdValue) {
      try {
        this.notify("session/cancel", { sessionId: this.sessionIdValue });
      } catch {
        // Ignore best-effort cancellation errors.
      }
    }

    this.process.kill("SIGTERM");
    this.process = null;
    this.startPromise = null;
    this.pendingRequests.clear();
  }

  protected getSessionCwd(): string {
    const metadataCwd = typeof this.restartMetadata?.cwd === "string" ? this.restartMetadata.cwd : undefined;
    return metadataCwd ?? this.options.sessionCwd ?? this.options.cwd ?? process.cwd();
  }

  protected async startProcess(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd ?? process.cwd(),
        env: { ...process.env, ...(this.options.env ?? {}) },
        stdio: "pipe",
      });

      this.process = child;
      this.attachJsonlReader(child.stdout, (line) => this.handleStdoutLine(line));
      this.attachJsonlReader(child.stderr, (line) => this.handleStderrLine(line));

      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.emitSessionEvent({ type: "connection_error", error: error.message });
        reject(error);
      });

      child.on("exit", (code, signal) => {
        if (this.stopping) return;
        const message = `ACP agent process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
        for (const pending of this.pendingRequests.values()) pending.reject(new Error(message));
        this.pendingRequests.clear();
        this.emitSessionEvent({ type: "connection_error", error: message });
      });
    });

    return this.startPromise;
  }

  protected async initialize(): Promise<void> {
    await this.sendRequestWithTimeout("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { "terminal-auth": true },
      },
      clientInfo: {
        name: "rookery",
        title: "Rookery",
        version: "0.1.0",
      },
    }, this.options.startupTimeoutMs ?? 15_000);
  }

  protected sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.process?.stdin.writable) {
      return Promise.reject(new Error("ACP agent process is not writable."));
    }

    const id = `acp-${++this.requestIndex}`;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    this.process.stdin.write(`${JSON.stringify(request)}\n`);
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
  }

  protected async sendRequestWithTimeout(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const pending = this.sendRequest(method, params);
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ACP ${method}.`)), timeoutMs)),
    ]);
  }

  protected notify(method: string, params?: unknown): void {
    if (!this.process?.stdin.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  protected shouldIgnoreServerMessage(message: JsonRpcMessage): boolean {
    return this.isPiAcpStartupInfo(message);
  }

  protected handleStdoutLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emitSessionEvent({ type: "protocol_error", error: `ACP agent emitted non-JSON line: ${line}` });
      return;
    }

    const id = asJsonRpcId((message as { id?: unknown }).id);
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      if ("error" in message) pending.reject(new Error(jsonRpcErrorMessage(message)));
      else pending.resolve((message as JsonRpcSuccess).result);
      return;
    }

    if ("method" in message && message.method === "session/update") {
      if (this.shouldIgnoreServerMessage(message)) return;
      const events = acpServerMessageToSessionEvents(message as never);
      for (const event of events) {
        if (event.type === "user_message" && event.text === this.suppressUserMessageText) continue;
        this.emitSessionEvent(event);
      }
      return;
    }

    if ("method" in message && id !== undefined) {
      this.emitSessionEvent({ type: "protocol_error", error: `Unsupported ACP server request: ${message.method}` });
      if (this.process?.stdin.writable) {
        const response: JsonRpcFailure = {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unsupported ACP server request: ${message.method}` },
        };
        this.process.stdin.write(`${JSON.stringify(response)}\n`);
      }
    }
  }

  protected handleStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.emitSessionEvent({ type: "status_changed", status: "busy", message: trimmed });
  }

  protected attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) onLine(line);
      }
    });
    stream.on("end", () => {
      const trailing = (buffer + decoder.end()).trim();
      if (trailing) onLine(trailing);
    });
    stream.on("error", (error) => {
      this.emitSessionEvent({ type: "connection_error", error: errorMessage(error) });
    });
  }

  private isPiAcpStartupInfo(message: JsonRpcMessage): boolean {
    if (!this.isReplayingSessionLoad && !this.started) {
      // fall through to text sniffing below
    }
    if (!("method" in message) || message.method !== "session/update") return false;
    const params = message.params as { update?: { sessionUpdate?: unknown; content?: { text?: unknown } } } | undefined;
    if (params?.update?.sessionUpdate !== "agent_message_chunk") return false;
    const text = params.update.content?.text;
    return typeof text === "string" && text.startsWith("pi v") && text.includes("Skills");
  }
}
