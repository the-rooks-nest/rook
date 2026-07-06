import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../paths.js";
import { BaseAgent } from "./BaseAgent.js";
import { appendSessionRecord, createSessionRecord } from "./sessionLog.js";

// ---------------------------------------------------------------------------
// Transcript format (.var/example_transcript.json)
//
// [
//   {
//     "timestamp": "2026-07-05T12:00:00Z",
//     "events": [
//       { "type": "thinking",         "text": "Let me think..." },
//       { "type": "agent_message",    "text": "Here's the result." },
//       { "type": "tool_call",        "id": "call_1", "name": "read", "input": { "path": "foo.txt" } },
//       { "type": "tool_result",      "id": "call_1", "output": "contents of foo.txt" },
//       { "type": "agent_message",    "text": "The file says hello." }
//     ]
//   }
// ]
//
// Each top-level entry is a "turn" consumed per user message.  The mock agent
// ignores the user's actual input and replays the next turn in order.
// ---------------------------------------------------------------------------

const TRANSCRIPT_PATH = path.join(REPO_ROOT, ".var", "example_transcript.json");
const TOKEN_DELAY_MS = 20;
const MESSAGE_DELAY_MS = 500;

type TranscriptEvent = ThinkingEvent | AgentMessageEvent | ToolCallEvent | ToolResultEvent;

interface ThinkingEvent {
  type: "thinking";
  text: string;
}

interface AgentMessageEvent {
  type: "agent_message";
  text: string;
}

interface ToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultEvent {
  type: "tool_result";
  id: string;
  output: string;
}

interface TranscriptTurn {
  timestamp: string;
  events: TranscriptEvent[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidTranscriptEvent(value: unknown): value is TranscriptEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const type = event.type;
  if (type === "thinking" || type === "agent_message") {
    return typeof event.text === "string";
  }
  if (type === "tool_call") {
    return typeof event.id === "string" && typeof event.name === "string";
  }
  if (type === "tool_result") {
    return typeof event.id === "string" && typeof event.output === "string";
  }
  return false;
}

function isValidTranscriptTurn(value: unknown): value is TranscriptTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Record<string, unknown>;
  return typeof turn.timestamp === "string" && Array.isArray(turn.events) && turn.events.every(isValidTranscriptEvent);
}

function loadTranscript(): TranscriptTurn[] {
  if (!existsSync(TRANSCRIPT_PATH)) {
    throw new Error(
      `No mock transcript found at ${TRANSCRIPT_PATH}.\n` +
        `Use the create-a-mock-transcript skill to create one (it saves there automatically).`,
    );
  }
  const raw = readFileSync(TRANSCRIPT_PATH, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Mock transcript at ${TRANSCRIPT_PATH} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Mock transcript at ${TRANSCRIPT_PATH} must be a JSON array of turns.`);
  }
  if (!parsed.every(isValidTranscriptTurn)) {
    throw new Error(`Mock transcript at ${TRANSCRIPT_PATH} contains invalid turns. See the create-a-mock-transcript skill for the expected format.`);
  }
  return parsed as TranscriptTurn[];
}

/**
 * MockAgent replays a pre-recorded transcript instead of calling a real AI
 * backend.  Each call to run() consumes the next turn from the transcript
 * (ignoring the user's message) and streams the events back token-by-token
 * with realistic timing.
 *
 * Remove this file and its single registration line in agentDiscovery.ts to
 * delete the agent — nothing else depends on it.
 */
export class MockAgent extends BaseAgent {
  private transcript: TranscriptTurn[];
  private turnIndex = 0;

  constructor() {
    super({ command: "mock", cwd: REPO_ROOT, agentName: "MockAgent" });
    this.transcript = loadTranscript();
  }

  // ---- lifecycle (no subprocess) ------------------------------------------------

  protected override async start(): Promise<void> {
    const sessionId = crypto.randomUUID();
    this.sessionIdValue = sessionId;
    this.sessionRecord = createSessionRecord({
      agent: this.agentName,
      name: "mock-session",
      id: sessionId,
      restart: { sessionId, cwd: process.cwd() },
    });
    await appendSessionRecord(this.sessionRecord);
  }

  // BaseAgent.ensureStarted() calls start() then registerSession(), but
  // registerSession() calls sendRequest("session/new") which requires a
  // subprocess. Override to skip the ACP handshake entirely.
  protected override async registerSession() {
    if (!this.sessionRecord) throw new Error("MockAgent must be started first.");
    return this.sessionRecord;
  }

  // ---- replay -------------------------------------------------------------------

  protected override async runImpl(_userMessage: string): Promise<void> {
    if (this.turnIndex >= this.transcript.length) {
      this.emitAcpUpdate({ sessionUpdate: "_rookery_run_completed", stopReason: "end_turn" });
      return;
    }

    const turn = this.transcript[this.turnIndex++];

    for (let i = 0; i < turn.events.length; i++) {
      if (i > 0) await sleep(MESSAGE_DELAY_MS);

      const event = turn.events[i];
      switch (event.type) {
        case "thinking":
          await this.streamTokens(event.text, "agent_thought_chunk");
          break;
        case "agent_message":
          await this.streamTokens(event.text, "agent_message_chunk");
          break;
        case "tool_call":
          this.emitToolCallStart(event);
          if (typeof event.input === "string") {
            await this.streamToolInput(event.id, event.name, event.input);
          } else if (event.input !== undefined && event.input !== null) {
            await this.streamToolInput(event.id, event.name, JSON.stringify(event.input));
          }
          break;
        case "tool_result":
          this.emitToolCallComplete(event);
          break;
      }
    }

    this.emitAcpUpdate({ sessionUpdate: "_rookery_run_completed", stopReason: "end_turn" });
  }

  // ---- streaming helpers --------------------------------------------------------

  private async streamTokens(text: string, sessionUpdate: string): Promise<void> {
    const tokens = text.split(/(?<=\s)/); // split after whitespace, keeping the space
    for (const token of tokens) {
      this.emitAcpUpdate({
        sessionUpdate,
        content: { type: "text", text: token },
      });
      await sleep(TOKEN_DELAY_MS);
    }
  }

  private async streamToolInput(toolCallId: string, toolName: string, input: string): Promise<void> {
    const tokens = input.split(/(?<=\s)/);
    for (const token of tokens) {
      this.emitAcpUpdate({
        sessionUpdate: "_rookery_tool_input_delta",
        toolCallId,
        toolName,
        delta: token,
      });
      await sleep(TOKEN_DELAY_MS);
    }
    this.emitAcpUpdate({
      sessionUpdate: "_rookery_tool_call_ready",
      toolCallId,
      toolName,
    });
  }

  private emitToolCallStart(event: ToolCallEvent): void {
    this.emitAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: event.id,
      title: event.name,
      kind: event.name,
      status: "in_progress",
    });
  }

  private emitToolCallComplete(event: ToolResultEvent): void {
    this.emitAcpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      status: "completed",
      content: [{ type: "text", text: event.output }],
    });
  }
}
