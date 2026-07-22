import process from "node:process";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { WebSocket } from "ws";
import { COLORS, fatal } from "./index.mjs";

export class RookCliClient {
  constructor({ serverUrl, authToken, runtimeId, sessionId, title, execPrompt, transcript, lastMessageOnly, join, leave }) {
    this.serverUrl = serverUrl || process.env.ROOK_SERVER_BASE_URL || "http://127.0.0.1:7665";
    this.authToken = authToken || process.env.ROOK_AUTH_TOKEN || "";
    this.runtimeId = runtimeId;
    this.sessionId = sessionId || null;
    this.title = title || (execPrompt ? "cli-exec" : "cli-chat");
    this.execPrompt = execPrompt;
    this.transcript = transcript;
    this.lastMessageOnly = lastMessageOnly;
    if (this.lastMessageOnly && !this.execPrompt) {
      this.lastMessageOnly = false;
    }
    this.joinEnv = join || [];
    this.leaveEnv = leave || [];
    this.ws = null;
    this.createdSessionId = null;
    this.requestId = 0;
    this.promptId = 0;
    this.pending = new Map();
    this.pendingPromptIds = new Set();
    this.userEchoes = [];
    this.toolInputs = new Map();
    this.toolOutputs = new Map();
    this.currentSection = null;
    this.finalAssistantText = "";
    this.latestAssistantText = "";
    this.rl = null;
    this.closed = false;
    this.execResolve = null;
    this.execReject = null;
    this.turnIdleTimer = null;
    this.turnActive = false;
    this.turnSawActivity = false;
    this.progressTimer = null;
    this.toolHeader = null;
    this.toolLineWidth = 0;
    this.toolCallId = null;
    this.pendingOffers = [];
  }

  baseRestUrl() {
    return this.serverUrl.replace(/\/$/, "");
  }

  async run() {
    this.installSignalHandlers();
    if (this.runtimeId) await this.ensureRuntimeExists();
    await this.connect();
    await this.initialize();
    if (this.sessionId) await this.loadExistingSession();
    else await this.createSession();

    if (this.joinEnv.length > 0 || this.leaveEnv.length > 0) {
      await this.applyEnvironmentChanges();
    }

    if (this.execPrompt) {
      await this.runExecTurn(this.execPrompt);
      this.printSessionId();
      await this.close();
      return;
    }

    if (this.transcript) {
      await this.runTranscriptMode();
      return;
    }

    this.startInteractiveLoop();
  }

  async ensureRuntimeExists() {
    const response = await fetchJson(`${this.baseRestUrl()}/api/agent_runtimes`, this.authToken);
    const runtimes = Array.isArray(response?.runtimes) ? response.runtimes : [];
    if (!runtimes.some((runtime) => runtime?.id === this.runtimeId)) {
      const available = runtimes.map((runtime) => runtime?.id).filter(Boolean).join(", ");
      fatal(`Unknown configured runtime: ${this.runtimeId}${available ? `\nAvailable runtimes: ${available}` : ""}`);
    }
  }

  async connect() {
    const wsUrl = this.serverUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "") + "/api/ws";
    const headers = this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
    this.ws = new WebSocket(wsUrl, { headers });
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("WebSocket closed during connect")); };
      const cleanup = () => {
        this.ws.off("open", onOpen);
        this.ws.off("error", onError);
        this.ws.off("close", onClose);
      };
      this.ws.on("open", onOpen);
      this.ws.on("error", onError);
      this.ws.on("close", onClose);
    });

    this.ws.on("message", (data) => this.handleFrame(String(data)));
    this.ws.on("close", () => { if (!this.closed) fatal("Connection closed."); });
    this.ws.on("error", (error) => { if (!this.closed) fatal(`WebSocket error: ${error.message}`); });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        _meta: { "com.rookkeeper": { environmentOffers: true } },
      },
      clientInfo: { name: "rook-cli", title: "Rook CLI", version: "0.1.0" },
    });
  }

  async createSession() {
    const result = await this.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { runtimeId: this.runtimeId, title: this.title },
    });
    this.createdSessionId = result?.sessionId;
    if (!this.createdSessionId) throw new Error("Server returned no sessionId");
    this.sessionId = this.createdSessionId;
    await this.request("session/load", { sessionId: this.sessionId });
    if (!this.lastMessageOnly) printLine(COLORS.gray, `session: ${this.sessionId} (${this.runtimeId})`);
  }

  async loadExistingSession() {
    await this.request("session/load", { sessionId: this.sessionId });
    if (!this.lastMessageOnly && !this.transcript) printLine(COLORS.gray, `session: ${this.sessionId}`);
  }

  async applyEnvironmentChanges() {
    await fetchJson(`${this.baseRestUrl()}/api/session/environments`, this.authToken, {
      method: "POST",
      body: JSON.stringify({
        sessionId: this.sessionId,
        enterEnvironmentIds: this.joinEnv,
        leaveEnvironmentIds: this.leaveEnv,
      }),
    });
    if (this.joinEnv.length > 0) printLine(COLORS.gray, `joined: ${this.joinEnv.join(", ")}`);
    if (this.leaveEnv.length > 0) printLine(COLORS.gray, `left: ${this.leaveEnv.join(", ")}`);

    // Auto-accept any env offers that arrive after joining.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const offer of this.pendingOffers) {
      printLine(COLORS.gray, `accepting offer: ${offer.environmentId} bundle=${offer.bundleId}`);
      await this.request("_com.rookkeeper/environment_offer_resolve", {
        sessionId: this.sessionId,
        environmentId: offer.environmentId,
        bundleHash: offer.bundleHash,
        decision: "accept",
      });
    }
    this.pendingOffers = [];
  }

  async runTranscriptMode() {
    if (!this.sessionId) fatal("--transcript requires --sessionId.");
    await this.loadExistingSession();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    this.printSessionId();
    await this.close();
  }

  async runExecTurn(prompt) {
    const completion = new Promise((resolve, reject) => {
      this.execResolve = resolve;
      this.execReject = reject;
    });
    this.sendPrompt(prompt).catch((error) => {
      const reject = this.execReject;
      this.execResolve = null;
      this.execReject = null;
      reject?.(error);
    });
    const timeout = setTimeout(() => {
      const resolve = this.execResolve;
      this.execResolve = null;
      this.execReject = null;
      resolve?.();
    }, 300_000);
    await completion;
    clearTimeout(timeout);
    if (this.lastMessageOnly) {
      const text = this.latestAssistantText.trim() || this.finalAssistantText.trim();
      if (text) process.stdout.write(`${text}\n`);
    }
  }

  startInteractiveLoop() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    this.rl.setPrompt(`${COLORS.green}user: ${COLORS.reset}`);
    this.rl.prompt();
    this.rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) { this.rl.prompt(); return; }
      this.sendPrompt(text).catch((error) => {
        printLine(COLORS.yellow, `error: ${error.message}`);
        this.rl.prompt();
      });
    });
    this.rl.on("SIGINT", () => this.stopInteractive());
    this.rl.on("close", () => this.stopInteractive());
  }

  async stopInteractive() {
    this.printSessionId();
    await this.close();
  }

  installSignalHandlers() {
    const stop = async () => { this.printSessionId(); await this.close(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.rl?.close(); } catch { /* piped stdin may already be closed */ }
    this.ws?.close();
    process.exit(0);
  }

  printSessionId() {
    if (this.sessionId) printLine(COLORS.gray, `sessionId: ${this.sessionId}`);
  }

  async sendPrompt(text) {
    if (!this.execPrompt && !this.transcript) {
      // Interactive mode: the readline prompt already shows "user: ".
    } else if (!this.lastMessageOnly) {
      printLine(COLORS.green, `user: ${text}`);
    }
    this.currentSection = null;
    this.finalAssistantText = "";
    this.latestAssistantText = "";
    this.turnActive = true;
    this.turnSawActivity = false;
    const id = `prompt-${++this.promptId}`;
    this.pendingPromptIds.add(id);
    this.userEchoes.push(text);
    return this.sendRequest(id, "session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  request(method, params) {
    const id = `rpc-${++this.requestId}`;
    return this.sendRequest(id, method, params);
  }

  sendRequest(id, method, params) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(String(id), { resolve, reject }));
  }

  handleFrame(text) {
    let frame;
    try { frame = JSON.parse(text); } catch { return; }

    if (frame.method === "session/update" && frame.params?.update) {
      this.handleUpdate(frame.params.update);
      return;
    }

    if (frame.method === "_com.rookkeeper/environment_offer") {
      const params = frame.params || {};
      const envId = params.environmentId || "?";
      const bundleId = params.bundleId || "?";
      if (!this.lastMessageOnly) {
        printLine(COLORS.yellow, `env-offer: ${envId} bundle=${bundleId}`);
        this.pendingOffers.push({ environmentId: envId, bundleId, bundleHash: params.bundleHash || "" });
      }
      return;
    }

    if (frame.method === "session/request_permission") {
      const requestId = String(frame.id ?? "permission");
      const title = frame.params?.toolCall?.title ?? "Permission requested";
      if (!this.lastMessageOnly) printLine(COLORS.yellow, `permission: ${title} (auto-cancelled)`);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "cancelled" } } }));
      return;
    }

    if (frame.id != null) {
      const key = String(frame.id);
      const pending = this.pending.get(key);
      const isPrompt = this.pendingPromptIds.has(key);
      if (pending) {
        this.pending.delete(key);
        if (frame.error) {
          pending.reject(new Error(frame.error.message ?? "Request failed"));
          if (isPrompt) {
            this.pendingPromptIds.delete(key);
            this.handlePromptCompletion(false, frame.error.message ?? "Run failed");
          }
        } else {
          pending.resolve(frame.result ?? {});
          if (isPrompt) {
            this.pendingPromptIds.delete(key);
            this.handlePromptCompletion(true, frame.result?.stopReason ?? "end_turn");
          }
        }
        return;
      }
    }

    if (frame.error && !this.lastMessageOnly) {
      printLine(COLORS.yellow, `error: ${frame.error.message ?? "Server error"}`);
    }
  }

  handleUpdate(update) {
    this.turnSawActivity = true;
    this.bumpTurnIdleTimer();
    const kind = update?.sessionUpdate;
    if (!kind) return;

    switch (kind) {
      case "user_message_chunk": {
        const text = update?.content?.text;
        if (text && this.userEchoes[0] === text) { this.userEchoes.shift(); break; }
        if (text) {
          if (this.currentSection) { process.stdout.write("\n"); this.currentSection = null; }
          printLine(COLORS.green, `user: ${text}`);
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = update?.content?.text;
        if (text && !this.lastMessageOnly) this.streamSection("thought", COLORS.purple, "thought: ", text);
        break;
      }
      case "agent_message_chunk": {
        const text = update?.content?.text;
        if (!text) return;
        this.finalAssistantText += text;
        if (!this.lastMessageOnly) this.streamSection("assistant", COLORS.red, "assistant: ", text);
        break;
      }
      case "tool_call": {
        if (this.lastMessageOnly) return;
        // Finish previous tool line if one is in progress.
        if (this.toolHeader) { process.stdout.write("\n"); this.toolHeader = null; }
        const title = update?.title ?? "Tool";
        const kindLabel = update?.kind ? ` (${update.kind})` : "";
        const rawId = update?.toolCallId || "?";
        const toolCallId = shortId(rawId);
        this.toolCallId = toolCallId;
        this.toolHeader = `${COLORS.blue}tool[${toolCallId}]: ${title}${kindLabel}${COLORS.reset}`;
        this.toolLineWidth = 0;
        process.stdout.write(this.toolHeader);
        const rawInput = stringify(update?.rawInput);
        if (rawId) this.toolInputs.set(rawId, rawInput || "");
        this.currentSection = null;
        break;
      }
      case "tool_call_update": {
        if (this.lastMessageOnly) return;
        const toolCallId = update?.toolCallId;
        if (toolCallId) {
          const input = stringify(update?.rawInput) || "";
          const prev = this.toolInputs.get(toolCallId) || "";
          if (input && input !== prev && !isEmptyValue(update?.rawInput)) {
            this.toolInputs.set(toolCallId, input);
            const line = `${this.toolHeader || ""} ${COLORS.blue}${input}${COLORS.reset}`;
            const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
            const pad = " ".repeat(Math.max(0, (this.toolLineWidth || 0) - visibleLen));
            this.toolLineWidth = visibleLen;
            process.stdout.write(`\r${line}${pad}`);
          }
          const output = contentItemsText(update?.content) ?? stringify(update?.rawOutput);
          const prevOut = this.toolOutputs.get(toolCallId) || "";
          if (output && output !== prevOut && !isEmptyValue(update?.rawOutput)) {
            this.toolOutputs.set(toolCallId, output);
            process.stdout.write(`\n${COLORS.lightBlue}tool-output[${shortId(toolCallId)}]: ${output}${COLORS.reset}\n`);
          }
        }
        this.currentSection = null;
        break;
      }
      case "plan":
      case "usage_update":
      case "current_mode_update":
      case "config_option_update":
        break;
      default:
        break;
    }
  }

  handlePromptCompletion(success, message) {
    if (!this.execPrompt) { this.finishTurn(success, message); return; }
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = setTimeout(() => this.finishTurn(true, message), this.turnSawActivity ? 500 : 50);
  }

  finishTurn(success, message) {
    if (!this.turnActive && this.pendingPromptIds.size === 0) return;
    this.turnActive = false;
    this.turnSawActivity = false;
    if (this.toolHeader) { process.stdout.write("\n"); this.toolHeader = null; }
    if (this.turnIdleTimer) clearTimeout(this.turnIdleTimer);
    this.turnIdleTimer = null;
    if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
    if (this.currentSection && !this.lastMessageOnly) process.stdout.write("\n");
    this.currentSection = null;
    this.latestAssistantText = this.finalAssistantText;
    if (!success && !this.lastMessageOnly) printLine(COLORS.yellow, `run-failed: ${message}`);
    if (this.execResolve || this.execReject) {
      const resolve = this.execResolve;
      const reject = this.execReject;
      this.execResolve = null;
      this.execReject = null;
      if (success) resolve?.();
      else reject?.(new Error(message));
    }
    this.pendingPromptIds.clear();
    if (!this.execPrompt && !this.transcript && !this.closed) {
      try { this.rl?.prompt(); } catch { /* piped stdin already closed */ }
    }
  }

  bumpTurnIdleTimer() {
    if (!this.execPrompt) return;
    if (this.progressTimer && this.turnSawActivity) { clearInterval(this.progressTimer); this.progressTimer = null; }
    if (!this.turnSawActivity && !this.progressTimer) {
      this.progressTimer = setInterval(() => process.stderr.write("."), 3000);
    }
  }

  streamSection(key, color, prefix, text) {
    if (this.currentSection !== key) {
      if (this.currentSection) process.stdout.write("\n");
      process.stdout.write(`${color}${prefix}${text}${COLORS.reset}`);
      this.currentSection = key;
    } else {
      process.stdout.write(`${color}${text}${COLORS.reset}`);
    }
  }
}

export async function fetchJson(url, authToken, options = {}) {
  const headers = { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}), ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    headers,
    method: options.method || "GET",
    body: options.body,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

export function contentItemsText(value) {
  if (!Array.isArray(value)) return null;
  const texts = value.map((item) => item?.content?.text ?? item?.text).filter((item) => typeof item === "string" && item.length > 0);
  return texts.length ? texts.join("\n") : null;
}

export function stringify(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.values(value).every((v) =>
      v === "" || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0));
  }
  return false;
}

function shortId(rawId) {
  return createHash("md5").update(String(rawId)).digest("hex").slice(0, 4);
}

export function printLine(color, text) {
  process.stdout.write(`${color}${text}${COLORS.reset}\n`);
}
