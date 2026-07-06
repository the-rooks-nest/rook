import { existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../paths.js";
import { AGENT_PROFILES } from "../config/agentProfiles.js";
import { BaseAgent, type BaseAgentOptions } from "./BaseAgent.js";
import { PiAgent, type PiAgentOptions } from "./PiAgent.js";
import { ClaudeAgent, type ClaudeAgentOptions } from "./ClaudeAgent.js";
import { CursorAgent, type CursorAgentOptions } from "./CursorAgent.js";
import { MockAgent } from "./MockAgent.js";
import type { AgentRestartMetadata } from "./sessionLog.js";

export interface AgentDefinition {
  id: string;
  parentId: string | null;
}

export interface AgentCreateOptions {
  skillPaths?: string[];
  extensionPaths?: string[];
  appendSystemPrompt?: string;
}

type AgentFactory = (restartMetadata?: AgentRestartMetadata, options?: AgentCreateOptions) => BaseAgent;

type AgentRegistryEntry = {
  id: string;
  parentId: string | null;
  create: AgentFactory;
};

function uniqueNonEmpty(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))];
}

const CREATE_SKILLS_PATH = path.join(REPO_ROOT, "skills", "create-skills");
const PROMPT_TRACE_LOGGER_EXTENSION_PATH = path.join(REPO_ROOT, "dev-tools", "prompt-trace-logger.ts");

function defaultPiSkillPaths(): string[] {
  return existsSync(CREATE_SKILLS_PATH) ? [CREATE_SKILLS_PATH] : [];
}

function defaultPiExtensionPaths(): string[] {
  // TODO: gate this behind an explicit dev-mode / prod-mode distinction once we have one.
  return existsSync(PROMPT_TRACE_LOGGER_EXTENSION_PATH) ? [PROMPT_TRACE_LOGGER_EXTENSION_PATH] : [];
}

function createPiAgent(restartMetadata: AgentRestartMetadata | undefined, options: PiAgentOptions): BaseAgent {
  return new PiAgent(options, restartMetadata);
}

function createGenericAcpAgent(restartMetadata: AgentRestartMetadata | undefined, options: BaseAgentOptions): BaseAgent {
  return new BaseAgent(options, restartMetadata);
}

function createClaudeAgent(restartMetadata: AgentRestartMetadata | undefined, options: ClaudeAgentOptions): BaseAgent {
  return new ClaudeAgent(options, restartMetadata);
}

function createCursorAgent(restartMetadata: AgentRestartMetadata | undefined, options: CursorAgentOptions): BaseAgent {
  return new CursorAgent(options, restartMetadata);
}

const AGENT_REGISTRY: AgentRegistryEntry[] = [
  {
    id: "PiAgent",
    parentId: null,
    create: (restartMetadata, options) => createPiAgent(restartMetadata, {
      cwd: REPO_ROOT,
      agentName: "PiAgent",
      skillPaths: uniqueNonEmpty([...defaultPiSkillPaths(), ...(options?.skillPaths ?? [])]),
      extensionPaths: uniqueNonEmpty([...defaultPiExtensionPaths(), ...(options?.extensionPaths ?? [])]),
      appendSystemPrompt: options?.appendSystemPrompt,
    }),
  },
  {
    id: "ClaudeAgent",
    parentId: null,
    create: (restartMetadata) => createClaudeAgent(restartMetadata, {
      cwd: REPO_ROOT,
      agentName: "ClaudeAgent",
    }),
  },
  {
    id: "CursorAgent",
    parentId: null,
    create: (restartMetadata) => createCursorAgent(restartMetadata, {
      cwd: REPO_ROOT,
      agentName: "CursorAgent",
    }),
  },
  // MockAgent — replays a transcript. Remove this entry + MockAgent.ts to delete.
  {
    id: "MockAgent",
    parentId: null,
    create: () => new MockAgent(),
  },
  ...AGENT_PROFILES.map((profile): AgentRegistryEntry => {
    if (profile.type === "pi") {
      return {
        id: profile.id,
        parentId: profile.parentId ?? "PiAgent",
        create: (restartMetadata, options) => createPiAgent(restartMetadata, {
          command: profile.command,
          cwd: profile.cwd ?? REPO_ROOT,
          args: profile.args,
          agentName: profile.id,
          skillPaths: uniqueNonEmpty([...defaultPiSkillPaths(), ...(profile.skillPaths ?? []), ...(options?.skillPaths ?? [])]),
          extensionPaths: uniqueNonEmpty([...defaultPiExtensionPaths(), ...(profile.extensionPaths ?? []), ...(options?.extensionPaths ?? [])]),
          startupTimeoutMs: profile.startupTimeoutMs,
          appendSystemPrompt: options?.appendSystemPrompt,
        }),
      };
    }

    if (profile.type === "claude") {
      return {
        id: profile.id,
        parentId: profile.parentId ?? "ClaudeAgent",
        create: (restartMetadata) => createClaudeAgent(restartMetadata, {
          command: profile.command,
          args: profile.args,
          env: profile.env,
          cwd: profile.cwd ?? REPO_ROOT,
          agentName: profile.id,
          startupTimeoutMs: profile.startupTimeoutMs,
          mcpServers: profile.mcpServers,
        }),
      };
    }

    if (profile.type === "cursor") {
      return {
        id: profile.id,
        parentId: profile.parentId ?? "CursorAgent",
        create: (restartMetadata) => createCursorAgent(restartMetadata, {
          command: profile.command,
          cwd: profile.cwd ?? REPO_ROOT,
          agentName: profile.id,
          startupTimeoutMs: profile.startupTimeoutMs,
          model: profile.model,
        }),
      };
    }

    return {
      id: profile.id,
      parentId: profile.parentId ?? null,
      create: (restartMetadata) => createGenericAcpAgent(restartMetadata, {
        command: profile.command ?? "node",
        args: profile.args,
        env: profile.env,
        cwd: profile.cwd ?? REPO_ROOT,
        sessionCwd: typeof restartMetadata?.cwd === "string" ? restartMetadata.cwd : (profile.cwd ?? REPO_ROOT),
        agentName: profile.id,
        startupTimeoutMs: profile.startupTimeoutMs,
      }),
    };
  }),
];

function findAgentEntry(id: string): AgentRegistryEntry | undefined {
  return AGENT_REGISTRY.find((entry) => entry.id === id);
}

export function getAgentDefinitions(): AgentDefinition[] {
  return AGENT_REGISTRY.map(({ id, parentId }) => ({ id, parentId }));
}

export function isKnownAgent(id: string): boolean {
  return findAgentEntry(id) !== undefined;
}

export function createAgent(id: string, restartMetadata?: AgentRestartMetadata, options?: AgentCreateOptions): BaseAgent {
  const entry = findAgentEntry(id);
  if (!entry) throw new Error(`Unknown agent: ${id}`);
  return entry.create(restartMetadata, options);
}
