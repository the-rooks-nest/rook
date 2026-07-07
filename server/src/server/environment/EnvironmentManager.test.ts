// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentManager } from "./EnvironmentManager.js";
import { EnvironmentDecisionStore } from "./EnvironmentDecisionStore.js";
import type { EnvironmentRepositoryService } from "./EnvironmentRepositoryService.js";
import { JsonlEnvironmentMetadataCaptureSink } from "./environmentMetadataCapture.js";
import type { EnvironmentEventListener } from "./types.js";

function mockRepositoryService(): EnvironmentRepositoryService {
  return {
    getResolvedBundles: vi.fn(async () => []),
    getValidBundles: vi.fn(async () => []),
    getBundleCollectionPaths: vi.fn(async () => []),
    getEnvironmentPreview: vi.fn().mockResolvedValue({ environmentId: "web:example.com", bundles: [] }),
  } as unknown as EnvironmentRepositoryService;
}

function mockListener(): EnvironmentEventListener {
  return {
    onEnvironmentOffered: vi.fn(),
    onEnvironmentEntered: vi.fn(),
    onEnvironmentExited: vi.fn(),
    onEnvironmentResolved: vi.fn(),
  };
}

describe("EnvironmentManager", () => {
  let decisions: EnvironmentDecisionStore;
  let nowMs: number;
  let originalHome: string | undefined;
  let tempHome: string;
  let captureDir: string;

  beforeEach(() => {
    decisions = new EnvironmentDecisionStore(":memory:");
    nowMs = Date.parse("2026-07-02T12:00:00.000Z");
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(path.join(os.tmpdir(), "rook-home-"));
    process.env.HOME = tempHome;
    captureDir = path.join(tempHome, "IGNORED", "environment_metadata_captures");
  });

  afterEach(() => {
    decisions.close();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function captureSink() {
    return new JsonlEnvironmentMetadataCaptureSink(captureDir);
  }

  function newManager(activeWindowMs = 6 * 60_000, recentRetentionMs = 30 * 60_000): EnvironmentManager {
    return new EnvironmentManager(mockRepositoryService(), decisions, {
      activeEnvironmentWindowMs: activeWindowMs,
      recentEnvironmentRetentionMs: recentRetentionMs,
      logger: { info: vi.fn() },
      now: () => nowMs,
      registrationCaptureSink: captureSink(),
    });
  }

  it("keeps a registered environment active in memory", async () => {
    const manager = newManager();

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });

    expect(manager.isAvailable("web:example.com")).toBe(true);
  });

  it("creates IGNORED/environment_metadata_captures and appends environment metadata captures as jsonl", async () => {
    const manager = newManager();

    await manager.registerAvailableEnvironment(
      { id: "web:example.com/docs", metadata: { title: "Docs", tags: ["api"] } },
      { sourceName: "Example Docs", canonicalSourceUrl: "https://example.com/docs" },
    );
    await manager.registerAvailableEnvironment(
      { id: "web:example.com/docs", metadata: { title: "Docs 2" } },
      { sourceName: "Example Docs" },
    );

    const filePath = path.join(captureDir, "web-example.com--docs.jsonl");
    expect(existsSync(path.join(tempHome, "IGNORED"))).toBe(true);
    expect(existsSync(captureDir)).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      capturedAt: "2026-07-02T12:00:00.000Z",
      environmentId: "web:example.com/docs",
      sourceName: "Example Docs",
      canonicalSourceUrl: "https://example.com/docs",
      metadata: { title: "Docs", tags: ["api"] },
    });
    expect(lines[1]).toMatchObject({
      capturedAt: "2026-07-02T12:00:00.000Z",
      environmentId: "web:example.com/docs",
      sourceName: "Example Docs",
      metadata: { title: "Docs 2" },
    });
  });

  it("moves an active environment to recent after the active window", async () => {
    const manager = newManager(1_000, 10_000);
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });

    nowMs += 1_001;

    expect(manager.isAvailable("web:example.com")).toBe(false);
  });

  it("forgets recent environments after the recent retention window", async () => {
    const manager = newManager(1_000, 2_000);
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });

    nowMs += 1_001;
    expect(manager.isAvailable("web:example.com")).toBe(false);

    nowMs += 2_001;
    expect(manager.isAvailable("web:example.com")).toBe(false);
    expect(manager.diagnosticSnapshot()).toEqual([]);
  });

  it("promotes a recent environment back to active when registered again", async () => {
    const manager = newManager(1_000, 10_000);
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });

    nowMs += 1_001;
    expect(manager.isAvailable("web:example.com")).toBe(false);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    expect(manager.isAvailable("web:example.com")).toBe(true);
  });

  it("keeps registeredAt stable when an already-active environment is re-registered", async () => {
    const manager = newManager(10_000, 20_000);
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    const first = manager.diagnosticSnapshot()[0];

    nowMs += 2_000;
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    const second = manager.diagnosticSnapshot()[0];

    expect(second.registeredAt).toBe(first.registeredAt);
    expect(second.record.metadata.registeredAt).toBe(first.record.metadata.registeredAt);
    expect(second.lastTouchedAt).not.toBe(first.lastTouchedAt);
    expect(second.activeUntil).not.toBe(first.activeUntil);
  });

  it("resets registeredAt when a recent environment becomes active again", async () => {
    const manager = newManager(1_000, 10_000);
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    const first = manager.diagnosticSnapshot()[0];

    nowMs += 1_001;
    expect(manager.isAvailable("web:example.com")).toBe(false);

    nowMs += 2_000;
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    const second = manager.diagnosticSnapshot()[0];

    expect(second.registeredAt).not.toBe(first.registeredAt);
    expect(second.record.metadata.registeredAt).not.toBe(first.record.metadata.registeredAt);
    expect(second.lastTouchedAt).toBe(second.registeredAt);
  });

  it("retains permanent decisions and session-scoped decisions", () => {
    const manager = newManager();

    // Permanent approve: no sessionId needed, stored in DB.
    manager.decideEnvironment("web:example.com", "approve");
    expect(manager.effectiveDecision("web:example.com")).toBe("approve");

    // Session-scoped ignore: requires sessionId, in-memory only.
    manager.decideEnvironment("web:example.com", "ignore", undefined, "s1");
    expect(manager.effectiveDecision("web:example.com", "s1")).toBe("ignore");
    // Other sessions don't see it.
    expect(manager.effectiveDecision("web:example.com", "s2")).toBe("approve");
  });

  it("stores environment_id and bundle_id when approving a bundle by hash", async () => {
    const manager = newManager();

    // Simulate an environment with bundles in memory so decideEnvironment can
    // look up the bundle metadata.
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#my-bundle",
          bundleId: "my-bundle",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/my-bundle",
          skills: [],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-abc",
      },
    ] as any);
    const bundleManager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });

    // Register to get the bundle into remembered state.
    await bundleManager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });

    // Approve the bundle by hash.
    bundleManager.decideEnvironment("web:example.com", "approve", "hash-abc");

    // effectiveDecision by hash should return approve.
    expect(bundleManager.effectiveDecision("hash-abc")).toBe("approve");
    // The DB entry should be findable.
    expect(decisions.getDecision("hash-abc")).toBe("approve");
  });

  it("shows per-bundle effectiveDecision in diagnostic snapshot", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#my-bundle",
          bundleId: "my-bundle",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/my-bundle",
          skills: [{ id: "talk", files: {} }],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-abc",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });
    manager.decideEnvironment("web:example.com", "accept", "hash-abc", "s1");

    const snapshot = manager.diagnosticSnapshot("s1");
    expect(snapshot).toHaveLength(1);
    // Per-bundle decision should be "accept" from s1's perspective.
    expect(snapshot[0].bundles[0].effectiveDecision).toBe("accept");
    // Without sessionId, the session decision is invisible (only permanent shows).
    expect(manager.diagnosticSnapshot()[0].bundles[0].effectiveDecision).toBe("undecided");
    // The top-level (environment-keyed) decision won't match the bundle hash.
  });

  it("ephemeral accept is forgotten when the environment expires", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#my-bundle",
          bundleId: "my-bundle",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/my-bundle",
          skills: [],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-abc",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 1_000,
      recentEnvironmentRetentionMs: 30_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    manager.decideEnvironment("web:example.com", "accept", "hash-abc", "s1");
    expect(manager.effectiveDecision("hash-abc", "s1")).toBe("accept");

    // Advance past the active window — environment moves to recent, session-scoped accept is forgotten.
    nowMs += 1_001;
    expect(manager.effectiveDecision("hash-abc", "s1")).toBe("undecided");
  });

  it("approve persists across environment expiry", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#my-bundle",
          bundleId: "my-bundle",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/my-bundle",
          skills: [],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-abc",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 1_000,
      recentEnvironmentRetentionMs: 30_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    manager.decideEnvironment("web:example.com", "approve", "hash-abc");
    expect(manager.effectiveDecision("hash-abc")).toBe("approve");

    // Advance past the active window — environment expires, but approve is in DB.
    nowMs += 1_001;
    expect(manager.effectiveDecision("hash-abc")).toBe("approve");
  });

  it("does not broadcast offers on registration — offers are deferred to enter", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#testing",
          bundleId: "testing",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/testing",
          skills: [{ id: "consult", files: {} }],
          mcpServers: [{ id: "crm", files: {} }],
          apps: [{ id: "slack", files: {} }],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });

    // Registration should NOT broadcast offers.
    expect(listener.onEnvironmentOffered).not.toHaveBeenCalled();
    expect(listener.onEnvironmentEntered).not.toHaveBeenCalled();
    expect(manager.enteredEnvironments("s1")).toEqual([]);
  });

  it("remembers discovered bundle paths with the environment", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#testing",
          bundleId: "testing",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/testing",
          skills: [],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });

    expect(manager.diagnosticSnapshot()).toEqual([
      expect.objectContaining({
        environmentId: "web:example.com",
        bundleIds: ["testing"],
        bundleCollectionPaths: ["/repo/web/example.com/.bundles"],
        bundles: [expect.objectContaining({ bundleId: "testing", bundleHash: "hash-1" })],
      }),
    ]);
  });

  it("enters an environment and calls onEnvironmentEntered with approved skill paths", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#testing",
          bundleId: "testing",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/testing",
          skills: [{ id: "consult", files: {} }],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    // Approve the bundle before entering so skills are included.
    manager.decideEnvironment("web:example.com", "approve", "hash-1");

    const entered = manager.enterEnvironment("s1", "web:example.com");

    expect(entered).toEqual(["web:example.com"]);
    expect(manager.enteredEnvironments("s1")).toEqual(["web:example.com"]);
    expect(listener.onEnvironmentEntered).toHaveBeenCalledWith(
      "web:example.com",
      ["/repo/web/example.com/.bundles/testing/skills/consult"],
      undefined,
    );
    // No offers for already-approved bundles.
    expect(listener.onEnvironmentOffered).not.toHaveBeenCalled();

    const personalSkillsDir = path.join(tempHome, ".rook", "environment-repository", "web", "example.com", ".bundles", "personal", "skills");
    expect(existsSync(personalSkillsDir)).toBe(true);
  });

  it("exits an environment and calls onEnvironmentExited", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#testing",
          bundleId: "testing",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/testing",
          skills: [],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    manager.enterEnvironment("s1", "web:example.com");

    const remaining = manager.exitEnvironment("s1", "web:example.com");

    expect(remaining).toEqual([]);
    expect(manager.enteredEnvironments("s1")).toEqual([]);
    expect(listener.onEnvironmentExited).toHaveBeenCalledWith("web:example.com");
  });

  it("session decisions are cleared when exiting an environment", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#testing",
          bundleId: "testing",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/testing",
          skills: [],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    manager.enterEnvironment("s1", "web:example.com");

    // Accept the bundle for session s1.
    manager.decideEnvironment("web:example.com", "accept", "hash-1", "s1");
    expect(manager.effectiveDecision("hash-1", "s1")).toBe("accept");

    // Exit the environment — session decisions should be cleared.
    manager.exitEnvironment("s1", "web:example.com");
    expect(manager.effectiveDecision("hash-1", "s1")).toBe("undecided");
  });

  it("session decisions are isolated across sessions", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#testing",
          bundleId: "testing",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/testing",
          skills: [{ id: "consult", files: {} }],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const l1 = mockListener();
    const l2 = mockListener();
    manager.subscribe("s1", l1);
    manager.subscribe("s2", l2);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });

    // Session 1 enters and accepts.
    manager.enterEnvironment("s1", "web:example.com");
    manager.decideEnvironment("web:example.com", "accept", "hash-1", "s1");
    expect(manager.effectiveDecision("hash-1", "s1")).toBe("accept");

    // Session 2 enters — should get its own fresh offer, not affected by s1's decision.
    vi.mocked(l2.onEnvironmentOffered).mockClear();
    manager.enterEnvironment("s2", "web:example.com");
    expect(l2.onEnvironmentOffered).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "web:example.com",
        bundleId: "testing",
        bundleHash: "hash-1",
        sourceName: "Example",
      }),
    );
    // s2's onEnvironmentEntered should have empty skills (bundle still undecided from s2's perspective).
    expect(l2.onEnvironmentEntered).toHaveBeenCalledWith("web:example.com", [], undefined);
  });

  it("entering a child environment also enters its active parents", async () => {
    const manager = newManager();
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "app:md.obsidian", metadata: { bundleId: "md.obsidian" } }, { sourceName: "Obsidian" });
    await manager.registerAvailableEnvironment({ id: "app:md.obsidian/Rooknanigans", metadata: { vaultName: "Rooknanigans" } }, { sourceName: "Obsidian · Rooknanigans" });

    const entered = manager.enterEnvironment("s1", "app:md.obsidian/Rooknanigans");

    expect(entered).toEqual(["app:md.obsidian", "app:md.obsidian/Rooknanigans"]);
    expect(manager.enteredEnvironments("s1")).toEqual(["app:md.obsidian", "app:md.obsidian/Rooknanigans"]);
    expect(listener.onEnvironmentEntered).toHaveBeenNthCalledWith(1, "app:md.obsidian", [], undefined);
    expect(listener.onEnvironmentEntered).toHaveBeenNthCalledWith(2, "app:md.obsidian/Rooknanigans", [], undefined);
  });

  it("leaving a child environment also leaves inherited parent entries when no longer needed", async () => {
    const manager = newManager();
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "app:md.obsidian", metadata: {} });
    await manager.registerAvailableEnvironment({ id: "app:md.obsidian/Rooknanigans", metadata: {} });

    manager.enterEnvironment("s1", "app:md.obsidian/Rooknanigans");
    vi.mocked(listener.onEnvironmentExited).mockClear();

    const remaining = manager.exitEnvironment("s1", "app:md.obsidian/Rooknanigans");

    expect(remaining).toEqual([]);
    expect(manager.enteredEnvironments("s1")).toEqual([]);
    expect(listener.onEnvironmentExited).toHaveBeenNthCalledWith(1, "app:md.obsidian");
    expect(listener.onEnvironmentExited).toHaveBeenNthCalledWith(2, "app:md.obsidian/Rooknanigans");
  });

  it("environmentList sorts entered first, then active by recency", async () => {
    const manager = newManager();

    // Register two environments at different times.
    await manager.registerAvailableEnvironment({ id: "web:a.com", metadata: {} }, { sourceName: "A" });
    nowMs += 1_000;
    await manager.registerAvailableEnvironment({ id: "web:b.com", metadata: {} }, { sourceName: "B" });

    // Subscribe and enter the older one.
    const listener = mockListener();
    manager.subscribe("s1", listener);
    manager.enterEnvironment("s1", "web:a.com");

    const list = manager.environmentList("s1");

    // Entered first (web:a.com), then active by recency (web:b.com more recent).
    expect(list[0].environmentId).toBe("web:a.com");
    expect(list[0].entered).toBe(true);
    expect(list[1].environmentId).toBe("web:b.com");
    expect(list[1].entered).toBe(false);
  });

  it("enterEnvironment does nothing for an unsubscribed session", async () => {
    const manager = newManager();
    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });

    const entered = manager.enterEnvironment("nonexistent", "web:example.com");
    expect(entered).toEqual([]);
  });

  it("renders environment binding instructions for all entered environments", async () => {
    const manager = newManager();
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment(
      {
        id: "web:example.com",
        metadata: { title: "Example" },
      },
      { sourceName: "Arc", canonicalSourceUrl: "https://example.com" },
    );
    await manager.registerAvailableEnvironment(
      {
        id: "web:example.com/stuff",
        metadata: { title: "Stuff", tags: ["docs", "support"] },
      },
      { sourceName: "Arc", canonicalSourceUrl: "https://example.com/stuff" },
      "The user is reading the support docs.",
    );
    await manager.registerAvailableEnvironment(
      {
        id: "app:md.obsidian",
        metadata: { bundleId: "md.obsidian" },
      },
      { sourceName: "Obsidian" },
    );
    await manager.registerAvailableEnvironment(
      {
        id: "app:md.obsidian/WorkVault",
        metadata: { vault: "WorkVault" },
      },
      { sourceName: "Obsidian" },
    );

    manager.enterEnvironment("s1", "web:example.com/stuff");
    manager.enterEnvironment("s1", "app:md.obsidian/WorkVault");

    const instructions = manager.runtimeInstructionsForSession("s1");
    // Rook identity prompt is included.
    expect(instructions).toContain("You are Rook");
    // Environment prompt.
    expect(instructions).toContain("Attaching memories");
    expect(instructions).toContain("`web:example.com`");
    expect(instructions).toContain("`web:example.com/stuff`");
    expect(instructions).toContain("`app:md.obsidian`");
    expect(instructions).toContain("`app:md.obsidian/WorkVault`");
    expect(instructions).toContain(path.join(tempHome, ".rook", "environment-repository", "web", "example.com", ".bundles", "personal", "skills"));
    expect(instructions).toContain(path.join(tempHome, ".rook", "environment-repository", "web", "example.com", "stuff", ".bundles", "personal", "skills"));
    expect(instructions).toContain(path.join(tempHome, ".rook", "environment-repository", "app", "md.obsidian", ".bundles", "personal", "skills"));
    expect(instructions).toContain(path.join(tempHome, ".rook", "environment-repository", "app", "md.obsidian", "WorkVault", ".bundles", "personal", "skills"));
    expect(instructions).toContain("https://example.com/stuff");
    expect(instructions).toContain("The user is reading the support docs.");
    expect(instructions).toContain('"vault": "WorkVault"');
  });

  it("injects AGENTS.md content into the runtime prompt", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#default",
          bundleId: "default",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/default",
          skills: [],
          mcpServers: [],
          apps: [],
          agentsMd: "# Example Instructions\n\nAlways be polite.",
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    manager.enterEnvironment("s1", "web:example.com");

    const instructions = manager.runtimeInstructionsForSession("s1");
    expect(instructions).toContain("#### Environment instructions");
    expect(instructions).toContain("# Example Instructions");
    expect(instructions).toContain("Always be polite.");
  });

  it("omits AGENTS.md section when no bundles have it", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#default",
          bundleId: "default",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/default",
          skills: [],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} });
    manager.enterEnvironment("s1", "web:example.com");

    const instructions = manager.runtimeInstructionsForSession("s1");
    expect(instructions).not.toContain("#### Environment instructions");
  });

  it("offers undecided bundles when entering, and loads skills after approval", async () => {
    const repositoryService = mockRepositoryService();
    vi.mocked(repositoryService.getResolvedBundles).mockResolvedValue([
      {
        bundle: {
          id: "web:example.com#testing",
          bundleId: "testing",
          environmentId: "web:example.com",
          repository: "/repo",
          bundlePath: "/repo/web/example.com/.bundles/testing",
          skills: [{ id: "consult", files: {} }],
          mcpServers: [],
          apps: [],
          valid: true,
          errors: [],
        },
        bundleHash: "hash-1",
      },
    ] as any);
    const manager = new EnvironmentManager(repositoryService, decisions, {
      activeEnvironmentWindowMs: 6 * 60_000,
      recentEnvironmentRetentionMs: 30 * 60_000,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
    const listener = mockListener();
    manager.subscribe("s1", listener);

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });

    // Enter with an undecided bundle — it should be offered but not loaded.
    manager.enterEnvironment("s1", "web:example.com");

    expect(manager.enteredEnvironments("s1")).toEqual(["web:example.com"]);
    // onEnvironmentEntered called with empty skills (bundle is undecided).
    expect(listener.onEnvironmentEntered).toHaveBeenCalledWith(
      "web:example.com",
      [],
      undefined,
    );
    // Offer emitted for the undecided bundle.
    expect(listener.onEnvironmentOffered).toHaveBeenCalledWith({
      environmentId: "web:example.com",
      bundleId: "testing",
      bundleHash: "hash-1",
      sourceName: "Example",
      canonicalSourceUrl: undefined,
      skills: ["consult"],
      mcpServers: [],
      apps: [],
    });

    // Now accept for this session — should trigger a re-enter with skills.
    vi.mocked(listener.onEnvironmentEntered).mockClear();
    manager.decideEnvironment("web:example.com", "accept", "hash-1", "s1");

    expect(listener.onEnvironmentEntered).toHaveBeenCalledWith(
      "web:example.com",
      ["/repo/web/example.com/.bundles/testing/skills/consult"],
      undefined,
    );
  });
});
