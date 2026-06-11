import { REPO_ROOT } from "../paths.js";
import { AGENT_PROFILES } from "../config/agentProfiles.js";
import { BaseAgent, type BaseAgentOptions } from "./BaseAgent.js";
import { PiAgent, type PiAgentOptions } from "./PiAgent.js";
import { ClaudeAgent, type ClaudeAgentOptions } from "./ClaudeAgent.js";
import type { AgentRestartMetadata } from "./sessionLog.js";

export interface AgentDefinition {
  id: string;
  parentId: string | null;
}

export interface AgentCreateOptions {
  skillPaths?: string[];
  extensionPaths?: string[];
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

function createPiAgent(restartMetadata: AgentRestartMetadata | undefined, options: PiAgentOptions): BaseAgent {
  return new PiAgent(options, restartMetadata);
}

function createGenericAcpAgent(restartMetadata: AgentRestartMetadata | undefined, options: BaseAgentOptions): BaseAgent {
  return new BaseAgent(options, restartMetadata);
}

function createClaudeAgent(restartMetadata: AgentRestartMetadata | undefined, options: ClaudeAgentOptions): BaseAgent {
  return new ClaudeAgent(options, restartMetadata);
}

const AGENT_REGISTRY: AgentRegistryEntry[] = [
  {
    id: "PiAgent",
    parentId: null,
    create: (restartMetadata, options) => createPiAgent(restartMetadata, {
      cwd: REPO_ROOT,
      agentName: "PiAgent",
      skillPaths: uniqueNonEmpty(options?.skillPaths),
      extensionPaths: uniqueNonEmpty(options?.extensionPaths),
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
          skillPaths: uniqueNonEmpty([...(profile.skillPaths ?? []), ...(options?.skillPaths ?? [])]),
          extensionPaths: uniqueNonEmpty([...(profile.extensionPaths ?? []), ...(options?.extensionPaths ?? [])]),
          startupTimeoutMs: profile.startupTimeoutMs,
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
