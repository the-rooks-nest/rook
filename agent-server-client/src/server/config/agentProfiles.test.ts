import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CLIENT_ROOT } from "../paths";
import { loadAgentProfiles } from "./agentProfiles";

const profilesPath = path.join(AGENT_CLIENT_ROOT, "config", "agent-profiles.json");
const backupPath = `${profilesPath}.vitest-backup`;

function restoreProfilesFile(): void {
  rmSync(profilesPath, { force: true });
  if (existsSync(backupPath)) renameSync(backupPath, profilesPath);
}

describe("loadAgentProfiles", () => {
  afterEach(() => {
    restoreProfilesFile();
  });

  it("returns an empty list when no config file exists", () => {
    if (existsSync(profilesPath)) renameSync(profilesPath, backupPath);
    expect(loadAgentProfiles()).toEqual([]);
  });

  it("keeps valid pi/acp profiles and drops invalid ones", () => {
    if (existsSync(profilesPath)) renameSync(profilesPath, backupPath);
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [
        { id: "MyPiAgent", type: "pi", args: ["-e", "../my-agent"], startupTimeoutMs: 5000 },
        { id: "MyClaudeAgent", type: "claude", command: "claude", args: ["--add-dir", "../workspace"], mcpServers: [{ name: "docs", command: "npx" }] },
        { id: "Worker", type: "acp", command: "node", env: { FOO: "bar" } },
        { id: "", type: "pi" },
        { id: "BadEnv", type: "acp", env: { BAD: 123 } },
        { id: "BadArgs", type: "pi", args: ["ok", 1] },
        { id: "BadClaudeMcp", type: "claude", mcpServers: ["bad"] },
        { id: "BadType", type: "other" },
      ],
    }), "utf8");

    expect(loadAgentProfiles()).toEqual([
      { id: "MyPiAgent", type: "pi", args: ["-e", "../my-agent"], startupTimeoutMs: 5000 },
      { id: "MyClaudeAgent", type: "claude", command: "claude", args: ["--add-dir", "../workspace"], mcpServers: [{ name: "docs", command: "npx" }] },
      { id: "Worker", type: "acp", command: "node", env: { FOO: "bar" } },
    ]);
  });
});
