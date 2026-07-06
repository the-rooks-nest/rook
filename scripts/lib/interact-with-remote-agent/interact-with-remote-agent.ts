/**
 * Exercise the remote-agent bridge without the web UI.
 *
 * Run from the repo root (no need to cd into any package):
 *
 *   ./scripts/interact-with-remote-agent.sh [options] <prompt>
 *   npm run agent:cli -- [options] <prompt>
 *
 * One-time setup if tsx is missing:
 *
 *   cd server && npm install
 *
 * The .sh wrapper locates the server package's tsx and tsconfig; this file
 * starts a local Fastify server on a random port and streams session events.
 *
 * Options:
 *   --agent <id>           Agent backend (default: MyPiOpenAiAgent). Use --list-agents to inspect concrete subclasses.
 *   --list-agents          Print all known agent ids and exit.
 *   --session '<json>'     Continue an existing session record (AgentSessionSummary JSON).
 *   --restart              Restart the existing session in place.
 *   --replay               Include HTTP replay events on start (also needs --no-replay off).
 *   --omit-deltas          Hide message/tool delta ACP client events.
 *   --omit <types>         Comma-separated ACP client event types to hide (flag may repeat).
 *   --only <types>         Whitelist: only print these ACP client event types.
 *   --mode <id>            Set ACP session mode before prompting.
 *   --steer <text>         Send `_rookery/steering_prompt` during the run.
 *   --steer-after-ms <n>   Delay before sending steering prompt (default: 1500).
 *   --permission <mode>    Auto-respond to permission requests: allow-once | allow-always | reject-once | cancel.
 *   --cancel-after-ms <n>  Send ACP session/cancel after n ms.
 *   --no-session           Do not print the session record line.
 *   --no-replay            Do not print replay lines even when --replay is set.
 *   --raw-acp              Print raw ACP JSON-RPC traffic instead of translated ACP client events.
 *   -h, --help             Print usage (same event types as below).
 *
 * ACP client event types (for --omit / --only; --omit-deltas hides the three *delta-ish content types):
 *   acp_status_changed
 *   acp_user_message
 *   acp_user_message_chunk
 *   acp_agent_message_chunk
 *   acp_agent_thought_chunk
 *   acp_tool_call_started
 *   acp_tool_input_delta
 *   acp_tool_call_update
 *   acp_permission_request
 *   acp_plan_update
 *   acp_usage_update
 *   acp_modes_state
 *   acp_current_mode_update
 *   acp_config_option_update
 *   acp_finalize_blocks
 *   acp_run_completed
 *   acp_run_failed
 *   acp_connection_error
 *   acp_environment_event
 *
 * Output (JSONL on stdout):
 *   { "type": "agent", "event": ... }             one agent definition (--list-agents)
 *   { "type": "session", "event": ... }           session after start (--no-session to skip)
 *   { "type": "replay_acp", "event": ... }        prior raw ACP messages when --raw-acp --replay
 *   { "type": "acp_client_event", "event": ... }  live translated ACP client events
 *   { "type": "acp_message", "event": ... }       live raw ACP JSON-RPC messages (--raw-acp)
 *
 * Quick:
 *   ./scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"
 *
 * Full example (resume a session, restart its runtime, replay prior events, filter noisy types):
 *
 *   ./scripts/interact-with-remote-agent.sh \
 *     --agent MyPiOpenAiAgent \
 *     --session '{"id":"8f2c1a40-9b3e-4d12-8c01-2a9f0e7d31b4","agent":"MyPiOpenAiAgent","name":"vault-chat","createdAt":"2026-06-02T18:30:00.000Z","restart":{"cwd":"/Users/me/vault"}}' \
 *     --restart \
 *     --replay \
 *     --omit-deltas \
 *     --omit status_changed,environment_event \
 *     "Summarize our thread and list open tasks"
 *
 *   npm run agent:cli -- \
 *     --agent MyPiOpenAiAgent \
 *     --session '{"id":"8f2c1a40-9b3e-4d12-8c01-2a9f0e7d31b4","agent":"MyPiOpenAiAgent","name":"vault-chat","createdAt":"2026-06-02T18:30:00.000Z","restart":{"cwd":"/Users/me/vault"}}' \
 *     --restart --replay --omit-deltas --omit status_changed,environment_event \
 *     "Summarize our thread and list open tasks"
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSessionSummary } from "../../../server/src/shared/agent.js";
import type { AcpServerMessage, JsonRpcMessage } from "../../../server/src/shared/acp.js";
import type { AcpClientEvent } from "./acpClientTypes.js";
import { RemoteAgent } from "./remoteAgent.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const SERVER_ROOT = path.join(REPO_ROOT, "server");

const ACP_CLIENT_EVENT_TYPES = [
  "acp_status_changed",
  "acp_user_message",
  "acp_user_message_chunk",
  "acp_agent_message_chunk",
  "acp_agent_thought_chunk",
  "acp_tool_call_started",
  "acp_tool_input_delta",
  "acp_tool_call_update",
  "acp_permission_request",
  "acp_plan_update",
  "acp_usage_update",
  "acp_modes_state",
  "acp_current_mode_update",
  "acp_config_option_update",
  "acp_finalize_blocks",
  "acp_run_completed",
  "acp_run_failed",
  "acp_connection_error",
  "acp_environment_event",
] as const;

type AcpClientEventType = typeof ACP_CLIENT_EVENT_TYPES[number];

const DELTA_EVENT_TYPES: AcpClientEventType[] = [
  "acp_user_message_chunk",
  "acp_agent_message_chunk",
  "acp_agent_thought_chunk",
  "acp_tool_input_delta",
];

export type EventFilter = {
  only?: Set<AcpClientEventType>;
  omit: Set<AcpClientEventType>;
  showSession: boolean;
  showReplay: boolean;
};

function usage(): never {
  console.log(`Usage:
  ./scripts/interact-with-remote-agent.sh [options] <prompt>
  npm run agent:cli -- [options] <prompt>

Options:
  --agent <id>           Agent backend (default: MyPiOpenAiAgent)
  --list-agents          Print all known agent ids and exit
  --session '<json>'     Continue an existing session record
  --restart              Restart existing session in place
  --replay               Emit HTTP replay events on start
  --omit-deltas          Hide message/tool delta ACP client events
  --omit <types>         Comma-separated event types to hide (repeatable)
  --only <types>         Comma-separated event types to show (hides all others)
  --mode <id>            Set ACP session mode before prompting
  --steer <text>         Send _rookery/steering_prompt during the run
  --steer-after-ms <n>   Delay before sending steering prompt (default: 1500)
  --permission <mode>    Auto-respond to permission requests: allow-once | allow-always | reject-once | cancel
  --cancel-after-ms <n>  Send ACP session/cancel after n ms
  --no-session           Do not print the session record line
  --no-replay            Do not print replay lines (even with --replay)
  --raw-acp              Print raw ACP JSON-RPC traffic
  -h, --help

ACP client event types: ${ACP_CLIENT_EVENT_TYPES.join(", ")}

Output is JSONL on stdout. Examples:
  ./scripts/interact-with-remote-agent.sh --list-agents
  ./scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"
  ./scripts/interact-with-remote-agent.sh --raw-acp --agent MyPiOpenAiAgent --steer "Also include banana." "Run sleep 5 then report back"
  ./scripts/interact-with-remote-agent.sh --agent PirateClaudeAgent --mode bypassPermissions --steer "Also include banana." --steer-after-ms 2000 --cancel-after-ms 12000 "Run sleep 5 then report back"`);
  process.exit(2);
}

function parseEventTypes(value: string): AcpClientEventType[] {
  const types = value.split(",").map((part) => part.trim()).filter(Boolean);
  const invalid = types.filter((type) => !ACP_CLIENT_EVENT_TYPES.includes(type as AcpClientEventType));
  if (invalid.length > 0) {
    console.error(`Unknown event type(s): ${invalid.join(", ")}`);
    usage();
  }
  return types as AcpClientEventType[];
}

type PermissionMode = "allow-once" | "allow-always" | "reject-once" | "cancel";

function parseArgs(argv: string[]): {
  agent: string;
  session?: AgentSessionSummary;
  prompt: string;
  restart: boolean;
  replay: boolean;
  filter: EventFilter;
  rawAcp: boolean;
  listAgents: boolean;
  modeId?: string;
  steerText?: string;
  steerAfterMs: number;
  cancelAfterMs?: number;
  permissionMode?: PermissionMode;
} {
  let agent = "MyPiOpenAiAgent";
  let session: AgentSessionSummary | undefined;
  let restart = false;
  let replay = false;
  let omitDeltas = false;
  const omit = new Set<AcpClientEventType>();
  let only: Set<AcpClientEventType> | undefined;
  let showSession = true;
  let showReplay = true;
  let rawAcp = false;
  let listAgents = false;
  let modeId: string | undefined;
  let steerText: string | undefined;
  let steerAfterMs = 1500;
  let cancelAfterMs: number | undefined;
  let permissionMode: PermissionMode | undefined;
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") {
      const value = argv[++i];
      if (!value) usage();
      agent = value;
    } else if (arg === "--session") {
      const value = argv[++i];
      if (!value) usage();
      session = JSON.parse(value) as AgentSessionSummary;
    } else if (arg === "--restart") {
      restart = true;
    } else if (arg === "--replay") {
      replay = true;
    } else if (arg === "--omit-deltas") {
      omitDeltas = true;
    } else if (arg === "--omit") {
      const value = argv[++i];
      if (!value) usage();
      for (const type of parseEventTypes(value)) omit.add(type);
    } else if (arg === "--only") {
      const value = argv[++i];
      if (!value) usage();
      only = new Set(parseEventTypes(value));
    } else if (arg === "--no-session") {
      showSession = false;
    } else if (arg === "--no-replay") {
      showReplay = false;
    } else if (arg === "--raw-acp") {
      rawAcp = true;
    } else if (arg === "--list-agents") {
      listAgents = true;
    } else if (arg === "--mode") {
      const value = argv[++i];
      if (!value) usage();
      modeId = value;
    } else if (arg === "--steer") {
      const value = argv[++i];
      if (!value) usage();
      steerText = value;
    } else if (arg === "--steer-after-ms") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) usage();
      steerAfterMs = value;
    } else if (arg === "--permission") {
      const value = argv[++i] as PermissionMode | undefined;
      if (!value || !["allow-once", "allow-always", "reject-once", "cancel"].includes(value)) usage();
      permissionMode = value;
    } else if (arg === "--cancel-after-ms") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) usage();
      cancelAfterMs = value;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      promptParts.push(arg);
    }
  }

  if (omitDeltas) {
    for (const type of DELTA_EVENT_TYPES) omit.add(type);
  }

  const prompt = promptParts.join(" ").trim();
  if (!listAgents && !prompt) usage();

  return {
    agent,
    session,
    prompt,
    restart,
    replay,
    filter: { only, omit, showSession, showReplay },
    rawAcp,
    listAgents,
    ...(modeId ? { modeId } : {}),
    ...(steerText ? { steerText } : {}),
    steerAfterMs,
    ...(cancelAfterMs !== undefined ? { cancelAfterMs } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}

function shouldEmitClientEvent(event: AcpClientEvent, filter: EventFilter): boolean {
  if (filter.only) return filter.only.has(event.type);
  return !filter.omit.has(event.type);
}

function createEventLogger(filter: EventFilter) {
  return (event: AcpClientEvent) => {
    if (!shouldEmitClientEvent(event, filter)) return;
    console.log(JSON.stringify({ type: "acp_client_event", event }));
  };
}

async function printRawAcpSession(baseUrl: string, options: {
  agent: string;
  session?: AgentSessionSummary;
  restart: boolean;
  replay: boolean;
  prompt: string;
  filter: EventFilter;
  modeId?: string;
  steerText?: string;
  steerAfterMs: number;
  cancelAfterMs?: number;
  permissionMode?: PermissionMode;
}): Promise<void> {
  const startResponse = await fetch(`${baseUrl}/api/agent/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: options.agent,
      ...(options.session ? { session: options.session } : {}),
      ...(options.restart ? { restartExisting: true } : {}),
      ...(options.replay ? { includeReplayEvents: true } : {}),
    }),
  });
  const startResult = await startResponse.json() as { session: AgentSessionSummary; replayMessages?: AcpServerMessage[] };
  if (options.filter.showSession) {
    console.log(JSON.stringify({ type: "session", event: startResult.session }));
  }
  if (options.filter.showReplay && startResult.replayMessages) {
    for (const message of startResult.replayMessages) {
      console.log(JSON.stringify({ type: "replay_acp", event: message }));
    }
  }

  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${encodeURIComponent(startResult.session.id)}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });

  let modeDone = options.modeId ? false : true;
  let promptDone = false;
  let steerDone = options.steerText ? false : true;
  const done = new Promise<void>((resolve, reject) => {
    const maybeResolve = () => {
      if (modeDone && promptDone && steerDone) resolve();
    };
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as JsonRpcMessage;
      console.log(JSON.stringify({ type: "acp_message", event: message }));
      if ("method" in message && message.method === "session/request_permission" && options.permissionMode) {
        const requestId = "id" in message ? message.id : undefined;
        if (requestId !== undefined) {
          const optionId = options.permissionMode === "allow-once"
            ? "allow-once"
            : options.permissionMode === "allow-always"
              ? "allow-always"
              : options.permissionMode === "reject-once"
                ? "reject-once"
                : undefined;
          ws.send(JSON.stringify(optionId
            ? { jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "selected", optionId } } }
            : { jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "cancelled" } } }));
        }
      }
      if ("id" in message && message.id === "mode-1" && (("result" in message) || ("error" in message))) {
        if ("error" in message) reject(new Error(`set mode failed: ${message.error.message}`));
        else {
          modeDone = true;
          maybeResolve();
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "prompt-1",
            method: "session/prompt",
            params: { sessionId: startResult.session.id, prompt: [{ type: "text", text: options.prompt }] },
          }));
        }
      }
      if ("id" in message && message.id === "prompt-1" && (("result" in message) || ("error" in message))) {
        if ("error" in message) reject(new Error(message.error.message));
        else {
          promptDone = true;
          maybeResolve();
        }
      }
      if ("id" in message && message.id === "steer-1" && (("result" in message) || ("error" in message))) {
        if ("error" in message) reject(new Error(`steering prompt failed: ${message.error.message}`));
        else {
          steerDone = true;
          maybeResolve();
        }
      }
    });
    ws.addEventListener("close", () => resolve(), { once: true });
  });

  if (options.modeId) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "mode-1",
      method: "session/set_mode",
      params: { sessionId: startResult.session.id, modeId: options.modeId },
    }));
  } else {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "prompt-1",
      method: "session/prompt",
      params: { sessionId: startResult.session.id, prompt: [{ type: "text", text: options.prompt }] },
    }));
  }

  if (options.steerText) {
    setTimeout(() => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "steer-1",
        method: "_rookery/steering_prompt",
        params: { sessionId: startResult.session.id, text: options.steerText },
      }));
    }, options.steerAfterMs);
  }

  if (options.cancelAfterMs !== undefined) {
    setTimeout(() => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: startResult.session.id },
      }));
    }, options.cancelAfterMs);
  }

  await done;
  ws.close();
}

async function main() {
  const { agent, session, prompt, restart, replay, filter, rawAcp, listAgents, modeId, steerText, steerAfterMs, cancelAfterMs, permissionMode } = parseArgs(process.argv.slice(2));

  const serverEntry = pathToFileURL(path.join(SERVER_ROOT, "src/server/index.js")).href;
  const { buildServer } = await import(serverEntry);
  const app = await buildServer({ enableClient: false, logger: false });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine server address.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    if (listAgents) {
      const response = await fetch(`${baseUrl}/api/agents`);
      const payload = await response.json() as { agents: Array<Record<string, unknown>> };
      for (const definition of payload.agents) {
        console.log(JSON.stringify({ type: "agent", event: definition }));
      }
      return;
    }

    if (rawAcp) {
      await printRawAcpSession(baseUrl, { agent, session, restart, replay, prompt, filter, modeId, steerText, steerAfterMs, cancelAfterMs, permissionMode });
      return;
    }

    let remoteAgent: RemoteAgent;
    const logSessionEvent = (event: AcpClientEvent) => {
      createEventLogger(filter)(event);
      if (event.type === "acp_permission_request" && permissionMode && remoteAgent) {
        const optionId = permissionMode === "allow-once"
          ? "allow-once"
          : permissionMode === "allow-always"
            ? "allow-always"
            : permissionMode === "reject-once"
              ? "reject-once"
              : undefined;
        void remoteAgent.respondToPermissionRequest(
          event.requestId,
          optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
        );
      }
    };

    remoteAgent = new RemoteAgent({
      backend: agent,
      session,
      startEndpoint: `${baseUrl}/api/agent/start`,
      wsEndpoint: `${baseUrl}/api/ws`,
      includeReplayEvents: replay,
      restartExisting: restart,
      onAcpEvent: logSessionEvent,
    });

    const startResult = await remoteAgent.start();
    if (filter.showSession) {
      console.log(JSON.stringify({ type: "session", event: startResult.session }));
    }
    if (modeId) await remoteAgent.setMode(modeId);

    const runPromise = remoteAgent.run(prompt);
    const steeringPromise = steerText
      ? new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            remoteAgent.sendSteeringMessage(steerText).then(() => resolve()).catch(reject);
          }, steerAfterMs);
        })
      : Promise.resolve();
    const cancelPromise = cancelAfterMs !== undefined
      ? new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            remoteAgent.cancel().then(() => resolve()).catch(reject);
          }, cancelAfterMs);
        })
      : Promise.resolve();
    await Promise.all([runPromise, steeringPromise, cancelPromise]);
    remoteAgent.close();
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
