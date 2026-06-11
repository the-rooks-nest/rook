import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../paths";
import { ClaudeAgent } from "./ClaudeAgent";

class InspectableClaudeAgent extends ClaudeAgent {
  inspectNewSessionParams(cwd: string): unknown {
    return this.buildSessionNewParams(cwd);
  }

  inspectLoadSessionParams(sessionId: string, cwd: string): unknown {
    return this.buildSessionLoadParams(sessionId, cwd);
  }
}

describe("ClaudeAgent", () => {
  it("translates Claude profile args into ACP session/new and session/load params", () => {
    const cwd = REPO_ROOT;
    const agent = new InspectableClaudeAgent({
      command: "claude",
      cwd,
      args: ["--add-dir", "../my-org-repo", "--add-dir=../shared-repo"],
      env: { ANTHROPIC_API_KEY: "secret" },
      mcpServers: [{ name: "docs", command: "npx", args: ["-y", "docs-server"] }],
      agentName: "MyClaudeAgent",
    });

    const options = agent as unknown as { options: { args: string[]; env: Record<string, string> } };
    expect(options.options.args.at(0)).toContain("@agentclientprotocol/claude-agent-acp/dist/index.js");
    expect(options.options.env).toMatchObject({
      CLAUDE_CODE_EXECUTABLE: "claude",
      ANTHROPIC_API_KEY: "secret",
    });

    const additionalDirectories = [
      path.resolve(cwd, "../my-org-repo"),
      path.resolve(cwd, "../shared-repo"),
    ];

    expect(agent.inspectNewSessionParams(cwd)).toEqual({
      cwd,
      mcpServers: [{ name: "docs", command: "npx", args: ["-y", "docs-server"] }],
      additionalDirectories,
      _meta: { claudeCode: { options: { additionalDirectories } } },
    });

    expect(agent.inspectLoadSessionParams("session-1", cwd)).toEqual({
      sessionId: "session-1",
      cwd,
      mcpServers: [{ name: "docs", command: "npx", args: ["-y", "docs-server"] }],
      additionalDirectories,
      _meta: { claudeCode: { options: { additionalDirectories } } },
    });
  });

  it("maps --agents and --agent profile args into Claude SDK options", () => {
    const cwd = REPO_ROOT;
    const agentsJson = JSON.stringify({
      pirate: {
        description: "Speaks like a pirate",
        prompt: "Always speak like a pirate. Keep responses pirate-themed.",
      },
    });
    const agent = new InspectableClaudeAgent({
      cwd,
      args: ["--agents", agentsJson, "--agent", "pirate"],
    });

    expect(agent.inspectNewSessionParams(cwd)).toEqual({
      cwd,
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            agent: "pirate",
            agents: {
              pirate: {
                description: "Speaks like a pirate",
                prompt: "Always speak like a pirate. Keep responses pirate-themed.",
              },
            },
          },
        },
      },
    });
  });

  it("maps --append-system-prompt profile args into Claude SDK extraArgs", () => {
    const cwd = REPO_ROOT;
    const agent = new InspectableClaudeAgent({
      cwd,
      args: ["--append-system-prompt", "Always speak like a pirate."],
    });

    expect(agent.inspectNewSessionParams(cwd)).toEqual({
      cwd,
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            extraArgs: { "append-system-prompt": "Always speak like a pirate." },
          },
        },
      },
    });
  });

  it("rejects unsupported Claude-specific profile args inside ClaudeAgent", () => {
    expect(() => new ClaudeAgent({ args: ["--interactive"] })).toThrow("Unsupported ClaudeAgent arg: --interactive");
  });

  it("rejects invalid --agents JSON", () => {
    expect(() => new ClaudeAgent({ args: ["--agents", "not-json"] })).toThrow("ClaudeAgent --agents value must be valid JSON.");
  });
});
