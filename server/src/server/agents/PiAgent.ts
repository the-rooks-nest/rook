import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { SERVER_ROOT, REPO_ROOT } from "../paths.js";
import { BaseAgent, type BaseAgentOptions } from "./BaseAgent.js";
import type { JsonRpcMessage } from "../../shared/acp.js";
import type { AgentRestartMetadata } from "./sessionLog.js";

export interface PiAgentOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  startupTimeoutMs?: number;
  skillPaths?: string[];
  extensionPaths?: string[];
  appendSystemPrompt?: string;
  agentName?: string;
}

const DEFAULT_ARGS: string[] = [];
const PI_ACP_ENTRYPOINT = path.join(SERVER_ROOT, "node_modules", "pi-acp", "dist", "index.js");
const GENERATED_LAUNCHER_DIR = path.join(REPO_ROOT, ".var", "rook", "generated", "pi-launchers");

function uniqueNonEmpty(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))];
}

function ensurePiLauncher(options: { command: string; args: string[]; skillPaths: string[]; extensionPaths: string[]; appendSystemPrompt?: string }): string {
  mkdirSync(GENERATED_LAUNCHER_DIR, { recursive: true });

  const launcherSpec = JSON.stringify(options);
  const digest = createHash("sha256").update(launcherSpec).digest("hex").slice(0, 12);
  const launcherPath = path.join(GENERATED_LAUNCHER_DIR, `pi-launch-${digest}.mjs`);
  const launcherSource = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const piBinary = ${JSON.stringify(options.command)};
const baseArgs = ${JSON.stringify(options.args)};
const skillPaths = ${JSON.stringify(options.skillPaths)};
const extensionPaths = ${JSON.stringify(options.extensionPaths)};
const appendSystemPrompt = ${JSON.stringify(options.appendSystemPrompt ?? "")};
const forwardedArgs = process.argv.slice(2);
const extensionArgs = extensionPaths.flatMap((extensionPath) => ["-e", extensionPath]);
const skillArgs = skillPaths.flatMap((skillPath) => ["--skill", skillPath]);
const appendSystemPromptArgs = appendSystemPrompt ? ["--append-system-prompt", appendSystemPrompt] : [];

const child = spawn(piBinary, [...baseArgs, ...forwardedArgs, ...appendSystemPromptArgs, ...extensionArgs, ...skillArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on("error", (error) => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\\n");
  process.exit(1);
});
`;

  writeFileSync(launcherPath, launcherSource, "utf8");
  chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function toBaseAgentOptions(options: PiAgentOptions, restartMetadata?: AgentRestartMetadata): BaseAgentOptions {
  const skillPaths = uniqueNonEmpty(options.skillPaths);
  const extensionPaths = uniqueNonEmpty(options.extensionPaths);
  const cwd = options.cwd ?? REPO_ROOT;
  const piCommand = options.command?.trim() || "pi";
  const launcherPath = ensurePiLauncher({
    command: piCommand,
    args: options.args ?? DEFAULT_ARGS,
    skillPaths,
    extensionPaths,
    appendSystemPrompt: options.appendSystemPrompt,
  });

  return {
    command: "node",
    args: [PI_ACP_ENTRYPOINT],
    env: {
      PI_ACP_PI_COMMAND: launcherPath,
      ROOK_PI_TRACE_LOG_PATH: "/tmp/pi-traces.jsonl",
    },
    cwd,
    sessionCwd: typeof restartMetadata?.cwd === "string" ? restartMetadata.cwd : cwd,
    startupTimeoutMs: options.startupTimeoutMs,
    agentName: options.agentName,
  };
}

export class PiAgent extends BaseAgent {
  constructor(options: PiAgentOptions = {}, restartMetadata?: AgentRestartMetadata) {
    super(toBaseAgentOptions(options, restartMetadata), restartMetadata);
  }

  protected override shouldIgnoreServerMessage(message: JsonRpcMessage): boolean {
    if (!("method" in message) || message.method !== "session/update") return false;
    const params = message.params as { update?: { sessionUpdate?: unknown; content?: { text?: unknown } } } | undefined;
    if (params?.update?.sessionUpdate !== "agent_message_chunk") return false;
    const text = params.update.content?.text;
    return typeof text === "string" && text.startsWith("pi v") && text.includes("Skills");
  }

  override async sendSteeringMessage(userMessage: string): Promise<void> {
    await this.ensureStarted();
    const trimmed = userMessage.trim();
    if (!trimmed) return;

    if (!this.hasActiveWorkflow || !this.sessionId) {
      await super.sendSteeringMessage(trimmed);
      return;
    }

    this.emitUserMessageChunk(trimmed);
    try {
      await this.sendRequest("_rookery/steering_prompt", { sessionId: this.sessionId, text: trimmed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Method not found") || message.includes("Cannot send steering prompt without an active turn")) {
        await super.sendSteeringMessage(trimmed);
        return;
      }
      throw error;
    }
  }
}
