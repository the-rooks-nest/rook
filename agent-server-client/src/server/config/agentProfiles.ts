import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_CLIENT_ROOT } from "../paths.js";

export interface AgentProfile {
  id: string;
  type: "acp" | "pi" | "claude";
  parentId?: string | null;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  skillPaths?: string[];
  extensionPaths?: string[];
  startupTimeoutMs?: number;
  mcpServers?: Array<Record<string, unknown>>;
}

type AgentProfilesFile = {
  profiles?: AgentProfile[];
};

const AGENT_PROFILES_PATH = path.join(AGENT_CLIENT_ROOT, "config", "agent-profiles.json");

export function loadAgentProfiles(): AgentProfile[] {
  if (!existsSync(AGENT_PROFILES_PATH)) return [];
  const raw = readFileSync(AGENT_PROFILES_PATH, "utf8");
  const parsed = JSON.parse(raw) as AgentProfilesFile;
  if (!Array.isArray(parsed.profiles)) return [];

  return parsed.profiles.filter((profile): profile is AgentProfile => {
    if (typeof profile?.id !== "string" || profile.id.length === 0) return false;
    if (profile.type !== "acp" && profile.type !== "pi" && profile.type !== "claude") return false;
    if (profile.command !== undefined && typeof profile.command !== "string") return false;
    if (profile.args !== undefined && (!Array.isArray(profile.args) || profile.args.some((value) => typeof value !== "string"))) return false;
    if (profile.env !== undefined) {
      if (typeof profile.env !== "object" || profile.env === null || Array.isArray(profile.env)) return false;
      if (Object.values(profile.env).some((value) => typeof value !== "string")) return false;
    }
    if (profile.startupTimeoutMs !== undefined && typeof profile.startupTimeoutMs !== "number") return false;
    if (profile.mcpServers !== undefined) {
      if (!Array.isArray(profile.mcpServers)) return false;
      if (profile.mcpServers.some((value) => typeof value !== "object" || value === null || Array.isArray(value))) return false;
    }
    return true;
  });
}

export const AGENT_PROFILES = loadAgentProfiles();
