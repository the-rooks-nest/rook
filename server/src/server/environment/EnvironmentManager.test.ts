// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentManager } from "./EnvironmentManager.js";
import { EnvironmentDecisionStore } from "./EnvironmentDecisionStore.js";
import type { EnvironmentRepositoryService } from "./EnvironmentRepositoryService.js";
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

  beforeEach(() => {
    decisions = new EnvironmentDecisionStore(":memory:");
    nowMs = Date.parse("2026-07-02T12:00:00.000Z");
  });

  afterEach(() => {
    decisions.close();
  });

  function newManager(activeWindowMs = 6 * 60_000, recentRetentionMs = 30 * 60_000): EnvironmentManager {
    return new EnvironmentManager(mockRepositoryService(), decisions, {
      activeEnvironmentWindowMs: activeWindowMs,
      recentEnvironmentRetentionMs: recentRetentionMs,
      logger: { info: vi.fn() },
      now: () => nowMs,
    });
  }

  it("keeps a registered environment active in memory", async () => {
    const manager = newManager();

    await manager.registerAvailableEnvironment({ id: "web:example.com", metadata: {} }, { sourceName: "Example" });

    expect(manager.isAvailable("web:example.com")).toBe(true);
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

  it("retains persistent decisions and ephemeral visit decisions", () => {
    const manager = newManager();

    manager.decideEnvironment("web:example.com", "approve");
    expect(manager.effectiveDecision("web:example.com")).toBe("approve");

    manager.decideEnvironment("web:example.com", "ignore");
    expect(manager.effectiveDecision("web:example.com")).toBe("ignore");
  });

  it("tracks subscriptions without entering environments", async () => {
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

    expect(listener.onEnvironmentOffered).toHaveBeenCalledWith({
      environmentId: "web:example.com",
      bundleId: "testing",
      bundleHash: "hash-1",
      sourceName: "Example",
      canonicalSourceUrl: undefined,
      skills: ["consult"],
      mcpServers: ["crm"],
      apps: ["slack"],
    });
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
});
