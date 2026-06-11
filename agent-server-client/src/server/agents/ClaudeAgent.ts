import path from "node:path";
import { AGENT_CLIENT_ROOT, REPO_ROOT } from "../paths.js";
import { BaseAgent, type BaseAgentOptions } from "./BaseAgent.js";
import type { AgentRestartMetadata } from "./sessionLog.js";

export interface ClaudeAgentOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  startupTimeoutMs?: number;
  agentName?: string;
  mcpServers?: Array<Record<string, unknown>>;
}

const CLAUDE_ACP_ENTRYPOINT = path.join(AGENT_CLIENT_ROOT, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");

export type ClaudeCustomAgentDefinition = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  skills?: string[];
};

type ParsedClaudeProfileArgs = {
  additionalDirectories: string[];
  agent?: string;
  agents?: Record<string, ClaudeCustomAgentDefinition>;
  appendSystemPrompt?: string;
};

function readFlagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  const inlinePrefix = `${flag}=`;
  if (current.startsWith(inlinePrefix)) {
    const value = current.slice(inlinePrefix.length);
    if (!value) throw new Error(`ClaudeAgent requires a value for ${flag}.`);
    return { value, nextIndex: index };
  }
  if (current !== flag) throw new Error(`ClaudeAgent internal error: expected ${flag}.`);

  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`ClaudeAgent requires a value after ${flag}.`);
  }
  return { value: next, nextIndex: index + 1 };
}

function parseAgentsJson(raw: string): Record<string, ClaudeCustomAgentDefinition> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ClaudeAgent --agents value must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ClaudeAgent --agents value must be a JSON object.");
  }

  const agents: Record<string, ClaudeCustomAgentDefinition> = {};
  for (const [name, definition] of Object.entries(parsed)) {
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      throw new Error(`ClaudeAgent --agents entry '${name}' must be an object.`);
    }
    const { description, prompt } = definition as { description?: unknown; prompt?: unknown };
    if (typeof description !== "string" || description.length === 0) {
      throw new Error(`ClaudeAgent --agents entry '${name}' requires a non-empty description.`);
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error(`ClaudeAgent --agents entry '${name}' requires a non-empty prompt.`);
    }
    agents[name] = definition as ClaudeCustomAgentDefinition;
  }
  return agents;
}

function parseClaudeProfileArgs(args: string[] | undefined, cwd: string): ParsedClaudeProfileArgs {
  const parsed: ParsedClaudeProfileArgs = { additionalDirectories: [] };

  for (let index = 0; index < (args ?? []).length; index += 1) {
    const value = args?.[index];
    if (!value) continue;

    if (value === "--add-dir" || value.startsWith("--add-dir=")) {
      const { value: dir, nextIndex } = readFlagValue(args ?? [], index, "--add-dir");
      parsed.additionalDirectories.push(path.resolve(cwd, dir));
      index = nextIndex;
      continue;
    }

    if (value === "--agent" || value.startsWith("--agent=")) {
      const { value: agent, nextIndex } = readFlagValue(args ?? [], index, "--agent");
      parsed.agent = agent;
      index = nextIndex;
      continue;
    }

    if (value === "--agents" || value.startsWith("--agents=")) {
      const { value: agentsJson, nextIndex } = readFlagValue(args ?? [], index, "--agents");
      parsed.agents = parseAgentsJson(agentsJson);
      index = nextIndex;
      continue;
    }

    if (value === "--append-system-prompt" || value.startsWith("--append-system-prompt=")) {
      const { value: prompt, nextIndex } = readFlagValue(args ?? [], index, "--append-system-prompt");
      parsed.appendSystemPrompt = prompt;
      index = nextIndex;
      continue;
    }

    throw new Error(`Unsupported ClaudeAgent arg: ${value}`);
  }

  parsed.additionalDirectories = [...new Set(parsed.additionalDirectories)];
  return parsed;
}

function buildClaudeCodeOptions(parsed: ParsedClaudeProfileArgs): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (parsed.additionalDirectories.length > 0) options.additionalDirectories = parsed.additionalDirectories;
  if (parsed.agent) options.agent = parsed.agent;
  if (parsed.agents) options.agents = parsed.agents;
  if (parsed.appendSystemPrompt) {
    options.extraArgs = { "append-system-prompt": parsed.appendSystemPrompt };
  }
  return options;
}

function buildClaudeSessionPayload(
  parsed: ParsedClaudeProfileArgs,
  mcpServers: Array<Record<string, unknown>>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const claudeCodeOptions = buildClaudeCodeOptions(parsed);
  return {
    ...base,
    mcpServers,
    ...(parsed.additionalDirectories.length > 0 ? { additionalDirectories: parsed.additionalDirectories } : {}),
    ...(Object.keys(claudeCodeOptions).length > 0 ? { _meta: { claudeCode: { options: claudeCodeOptions } } } : {}),
  };
}

function normalizeMcpServers(servers: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  return (servers ?? []).filter((server) => typeof server === "object" && server !== null && !Array.isArray(server));
}

function toBaseAgentOptions(options: ClaudeAgentOptions, restartMetadata?: AgentRestartMetadata): BaseAgentOptions {
  const cwd = options.cwd ?? REPO_ROOT;
  const claudeCommand = options.command?.trim() || "claude";

  return {
    command: "node",
    args: [CLAUDE_ACP_ENTRYPOINT],
    env: {
      ...(options.env ?? {}),
      CLAUDE_CODE_EXECUTABLE: claudeCommand,
    },
    cwd,
    sessionCwd: typeof restartMetadata?.cwd === "string" ? restartMetadata.cwd : cwd,
    startupTimeoutMs: options.startupTimeoutMs,
    agentName: options.agentName,
  };
}

export class ClaudeAgent extends BaseAgent {
  private readonly parsedProfileArgs: ParsedClaudeProfileArgs;
  private readonly mcpServers: Array<Record<string, unknown>>;

  constructor(options: ClaudeAgentOptions = {}, restartMetadata?: AgentRestartMetadata) {
    const cwd = options.cwd ?? REPO_ROOT;
    super(toBaseAgentOptions(options, restartMetadata), restartMetadata);
    this.parsedProfileArgs = parseClaudeProfileArgs(options.args, cwd);
    this.mcpServers = normalizeMcpServers(options.mcpServers);
  }

  protected override buildSessionNewParams(cwd: string): unknown {
    return buildClaudeSessionPayload(this.parsedProfileArgs, this.mcpServers, { cwd });
  }

  protected override buildSessionLoadParams(sessionId: string, cwd: string): unknown {
    return buildClaudeSessionPayload(this.parsedProfileArgs, this.mcpServers, { sessionId, cwd });
  }
}
