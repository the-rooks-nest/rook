import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../paths";
import { PiAgent } from "./PiAgent";

const MY_AGENT_PACKAGE = path.join(REPO_ROOT, "..", "my-agent");

describe("PiAgent", () => {
  it("translates Pi launch args into a generated pi-acp launcher", () => {
    const agent = new PiAgent({
      args: ["-e", MY_AGENT_PACKAGE],
      skillPaths: ["/tmp/a/skills", "/tmp/b/skills"],
      extensionPaths: ["/tmp/parentMessageTool.ts"],
      appendSystemPrompt: "Environment instructions",
      agentName: "MyPiOpenAiAgent",
      cwd: REPO_ROOT,
    });

    const options = agent as unknown as { options: { args: string[]; env: Record<string, string> } };
    expect(options.options.args.at(0)).toContain("pi-acp/dist/index.js");
    expect(options.options.env.PI_ACP_PI_COMMAND).toContain(".var/rook/generated/pi-launchers/");
    expect(options.options.env.ROOK_PI_TRACE_LOG_PATH).toBe("/tmp/pi-traces.jsonl");

    const launcher = readFileSync(options.options.env.PI_ACP_PI_COMMAND, "utf8");
    expect(launcher).toContain(JSON.stringify("pi"));
    expect(launcher).toContain(JSON.stringify(["-e", MY_AGENT_PACKAGE]));
    expect(launcher).toContain(JSON.stringify(["/tmp/a/skills", "/tmp/b/skills"]));
    expect(launcher).toContain(JSON.stringify(["/tmp/parentMessageTool.ts"]));
    expect(launcher).toContain('["-e", extensionPath]');
    expect(launcher).toContain(JSON.stringify("Environment instructions"));
    expect(launcher).toContain('["--append-system-prompt", appendSystemPrompt]');
    expect(launcher).toContain(' + "\\n");');
  });
});
