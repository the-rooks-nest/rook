import { afterEach, describe, expect, it, vi } from "vitest";

describe("agentDiscovery", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("exposes the built-in PiAgent plus configured child agents", async () => {
    vi.doMock("../config/agentProfiles.js", () => ({
      AGENT_PROFILES: [
        { id: "MyPiAgent", type: "pi", parentId: "PiAgent", args: ["-e", "../my-agent"], skillPaths: ["/profile-skill"], extensionPaths: ["/profile-extension"], startupTimeoutMs: 3000 },
        { id: "MyClaudeAgent", type: "claude", parentId: "ClaudeAgent", command: "claude", args: ["--add-dir", "../workspace"], env: { ANTHROPIC_API_KEY: "secret" } },
        { id: "Worker", type: "acp", command: "node", args: ["worker.mjs"], env: { FOO: "bar" } },
      ],
    }));

    const { createAgent, getAgentDefinitions, isKnownAgent } = await import("./agentDiscovery");

    expect(getAgentDefinitions()).toEqual([
      { id: "PiAgent", parentId: null },
      { id: "ClaudeAgent", parentId: null },
      { id: "MyPiAgent", parentId: "PiAgent" },
      { id: "MyClaudeAgent", parentId: "ClaudeAgent" },
      { id: "Worker", parentId: null },
    ]);
    expect(isKnownAgent("MyPiAgent")).toBe(true);
    expect(isKnownAgent("unknown")).toBe(false);

    const piAgent = createAgent("MyPiAgent", undefined, {
      skillPaths: ["/runtime-skill", "/profile-skill"],
      extensionPaths: ["/runtime-extension"],
    }) as unknown as { options: { env: Record<string, string> } };
    const launcherPath = piAgent.options.env.PI_ACP_PI_COMMAND;
    expect(launcherPath).toContain(".var/agent-station/generated/pi-launchers/");

    const claudeAgent = createAgent("MyClaudeAgent") as unknown as { options: { env: Record<string, string> } };
    expect(claudeAgent.options.env).toMatchObject({
      CLAUDE_CODE_EXECUTABLE: "claude",
      ANTHROPIC_API_KEY: "secret",
    });

    const worker = createAgent("Worker", { sessionId: "s1", cwd: "/tmp/session" }) as unknown as { options: { command: string; args?: string[]; env?: Record<string, string>; sessionCwd?: string; agentName?: string } };
    expect(worker.options).toMatchObject({
      command: "node",
      args: ["worker.mjs"],
      env: { FOO: "bar" },
      sessionCwd: "/tmp/session",
      agentName: "Worker",
    });
  });

  it("throws for unknown agents", async () => {
    vi.doMock("../config/agentProfiles.js", () => ({ AGENT_PROFILES: [] }));
    const { createAgent } = await import("./agentDiscovery");
    expect(() => createAgent("missing")).toThrow("Unknown agent: missing");
  });
});
