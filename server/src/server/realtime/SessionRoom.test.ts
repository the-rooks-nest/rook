import { describe, expect, it } from "vitest";
import { BaseAgent } from "../agents/BaseAgent.js";
import type { AgentSessionRecord } from "../agents/sessionLog.js";
import { SessionRoom } from "./SessionRoom.js";
import { ENVIRONMENT_OFFER_AVAILABLE_KIND } from "../../shared/environment.js";
import type { AcpOutboundMessage } from "../../shared/realtime.js";

class TestAgent extends BaseAgent {
  constructor() {
    super({ command: "node", args: ["noop"], cwd: process.cwd(), sessionCwd: process.cwd(), agentName: "TestAgent" });
  }

  override async ensureStarted(): Promise<void> {
    this.started = true;
    this.sessionRecord ??= {
      id: "s1",
      agent: "TestAgent",
      name: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      restart: {},
    } satisfies AgentSessionRecord;
  }

  override async run(_userMessage: string): Promise<void> {
    await this.ensureStarted();
    await this.runImpl();
  }

  override async stop(): Promise<void> {}

  protected override async runImpl(): Promise<void> {}
}

describe("SessionRoom", () => {
  function createRoom(agent: BaseAgent) {
    const room = new SessionRoom("s1", {
      session: {
        id: "s1",
        agent: "TestAgent",
        name: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        restart: {},
      },
      agentId: "TestAgent",
      agent,
    });
    room.attachRuntimeEventSink();
    return room;
  }

  it("replays unresolved environment offers to late-joining subscribers", () => {
    const room = createRoom(new TestAgent());
    room.onEnvironmentOffered({
      environmentId: "web:example.com",
      bundleId: "contact",
      bundleHash: "hash-1",
      sourceName: "Example",
      canonicalSourceUrl: "https://example.com",
      skills: ["talk-to-consultant"],
      mcpServers: [],
      apps: [],
    });

    const seen: AcpOutboundMessage[] = [];
    const unsubscribe = room.subscribe((event) => {
      seen.push(event);
    });
    unsubscribe();

    expect(seen).toEqual([
      {
        type: "acp_message",
        message: expect.objectContaining({
          method: "session/update",
          params: expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: "_rookery_environment_event",
              kind: ENVIRONMENT_OFFER_AVAILABLE_KIND,
              payload: {
                environmentId: "web:example.com",
                bundleId: "contact",
                bundleHash: "hash-1",
                sourceName: "Example",
                canonicalSourceUrl: "https://example.com",
                skills: ["talk-to-consultant"],
                mcpServers: [],
                apps: [],
              },
            }),
          }),
        }),
      },
    ]);
  });

  it("does not replay environment offers after they are resolved", () => {
    const room = createRoom(new TestAgent());
    room.onEnvironmentOffered({
      environmentId: "web:example.com",
      bundleId: "contact",
      bundleHash: "hash-1",
      sourceName: "Example",
      canonicalSourceUrl: undefined,
      skills: ["talk-to-consultant"],
      mcpServers: [],
      apps: [],
    });
    room.onEnvironmentResolved("web:example.com", "contact", "hash-1", "approved");

    const seen: AcpOutboundMessage[] = [];
    const unsubscribe = room.subscribe((event) => {
      seen.push(event);
    });
    unsubscribe();

    expect(seen).toEqual([]);
  });

  it("delegates send-now steering messages to the agent runtime", async () => {
    class SteeringAgent extends TestAgent {
      seen: string[] = [];

      override async sendSteeringMessage(message: string): Promise<void> {
        this.seen.push(message);
      }
    }

    const agent = new SteeringAgent();
    const room = createRoom(agent);

    await room.sendSteeringMessage("Keep going");

    expect(agent.seen).toEqual(["Keep going"]);
  });

  it("publishes run_failed to current subscribers when an agent run rejects", async () => {
    class RejectingAgent extends TestAgent {
      protected override async runImpl(): Promise<void> {
        throw new Error("boom");
      }
    }

    const room = createRoom(new RejectingAgent());
    const seen: AcpOutboundMessage[] = [];
    const unsubscribe = room.subscribe((event) => {
      seen.push(event);
    });

    await room.run("hello");
    unsubscribe();

    expect(seen).toEqual([
      {
        type: "acp_message",
        message: expect.objectContaining({
          method: "session/update",
          params: expect.objectContaining({
            sessionId: "s1",
            update: expect.objectContaining({
              sessionUpdate: "_rookery_run_failed",
              error: "boom",
            }),
          }),
        }),
      },
    ]);
  });

  it("cancels an active run before rebuilding when an environment is entered", async () => {
    class BlockingAgent extends TestAgent {
      cancelled = 0;
      private resolveRun?: () => void;
      startedRun!: Promise<void>;
      private markStarted!: () => void;

      constructor() {
        super();
        this.startedRun = new Promise<void>((resolve) => {
          this.markStarted = resolve;
        });
      }

      override async cancel(): Promise<void> {
        this.cancelled += 1;
        this.resolveRun?.();
      }

      protected override async runImpl(): Promise<void> {
        this.markStarted();
        await new Promise<void>((resolve) => {
          this.resolveRun = resolve;
        });
      }
    }

    const agent = new BlockingAgent();
    const room = createRoom(agent);
    room.configureEnvironmentRuntime([], async () => ({
      session: room.session,
      agentId: room.agentId,
      agent,
    }));

    const running = room.run("hello");
    await agent.startedRun;

    room.onEnvironmentEntered("web:example.com", ["/repo/web/example.com"]);
    await running;

    expect(agent.cancelled).toBe(1);
  });

  it("rejects new work after the room is stopped", async () => {
    const room = createRoom(new TestAgent());

    await room.stop();

    await expect(room.ensureStarted()).rejects.toThrow("Session room stopped.");
    await expect(room.sendSteeringMessage("Keep going")).rejects.toThrow("Session room stopped.");
    await expect(room.setMode("ask")).rejects.toThrow("Session room stopped.");
    await expect(room.setConfigOption("verbosity", "high")).rejects.toThrow("Session room stopped.");
    await expect(room.cancel()).rejects.toThrow("Session room stopped.");
    await expect(room.run("hello")).resolves.toEqual({ ok: false, error: "Session room stopped." });
  });
});
