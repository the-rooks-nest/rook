// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentCandidate } from "../../shared/environment.js";
import { isDwellArrival, LocationRegistrar, type LocationEnvironmentSink } from "./LocationRegistrar.js";

function sink() {
  return {
    registerAvailableEnvironment: vi.fn(async () => {}),
    decideEnvironment: vi.fn(),
  } satisfies LocationEnvironmentSink;
}

function contextStore() {
  return { setContextBundle: vi.fn(), clear: vi.fn() };
}

function store() {
  return { setContextBundle: vi.fn(), clear: vi.fn() };
}

function cand(id: string, over: Partial<EnvironmentCandidate> = {}): EnvironmentCandidate {
  return { environmentId: id, displayName: id, confidence: 0.9, matchReasons: [], hasKnownEnvironment: false, ...over };
}

const writeStub = () => "/tmp/ctx";

describe("LocationRegistrar", () => {
  it("registers current (with context skill + accept) and neighbors", async () => {
    const s = sink();
    const cs = contextStore();
    const reg = new LocationRegistrar(s, cs, writeStub);
    await reg.sync([
      cand("loc:cicis.com/a", { website: "https://cicis.com/x" }),
      cand("loc:gamestop.com/b"),
    ]);

    expect(s.registerAvailableEnvironment).toHaveBeenCalledTimes(2);
    // the context bundle is served through the repository, not as extraSkillPaths
    expect(cs.setContextBundle).toHaveBeenCalledWith("loc:cicis.com/a", "/tmp/ctx");
    // current gets canonicalSourceUrl + contextText + accept
    expect(s.registerAvailableEnvironment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "loc:cicis.com/a", metadata: expect.objectContaining({ current: true }) }),
      expect.objectContaining({ sourceName: "loc:cicis.com/a", canonicalSourceUrl: "https://cicis.com/x" }),
      expect.stringContaining("loc:cicis.com/a"),
    );
    expect(s.decideEnvironment).toHaveBeenCalledWith("loc:cicis.com/a", "accept");
    // neighbor: no extra skills, current:false
    expect(s.registerAvailableEnvironment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "loc:gamestop.com/b", metadata: expect.objectContaining({ current: false }) }),
      expect.anything(),
    );
  });

  it("skips work when the set is unchanged", async () => {
    const s = sink();
    const cs = contextStore();
    const reg = new LocationRegistrar(s, cs, writeStub);
    const set = [cand("loc:a/1"), cand("loc:b/2")];
    await reg.sync(set);
    s.registerAvailableEnvironment.mockClear();
    await reg.sync([cand("loc:a/1"), cand("loc:b/2")]);
    expect(s.registerAvailableEnvironment).not.toHaveBeenCalled();
  });

  it("registers the next current set when it changes", async () => {
    const s = sink();
    const cs = contextStore();
    const reg = new LocationRegistrar(s, cs, writeStub);
    await reg.sync([cand("loc:a/1"), cand("loc:b/2")]);
    s.registerAvailableEnvironment.mockClear();
    await reg.sync([cand("loc:c/3")]);
    expect(s.registerAvailableEnvironment).toHaveBeenCalledTimes(1);
    expect(s.registerAvailableEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "loc:c/3" }),
      expect.anything(),
      expect.any(String),
    );
  });

  it("does nothing when no candidates remain", async () => {
    const s = sink();
    const cs = contextStore();
    const reg = new LocationRegistrar(s, cs, writeStub);
    await reg.sync([cand("loc:a/1")]);
    s.registerAvailableEnvironment.mockClear();
    await reg.sync([]);
    expect(s.registerAvailableEnvironment).not.toHaveBeenCalled();
  });

  it("does not register a drive-by (moving, not dwelled)", async () => {
    const s = sink();
    const cs = contextStore();
    const reg = new LocationRegistrar(s, cs, writeStub);
    await reg.sync([cand("loc:a/1")], { isStationary: false, speedMetersPerSecond: 20, dwellSeconds: 2 });
    expect(s.registerAvailableEnvironment).not.toHaveBeenCalled();
  });

  it("registers a real dwell, then stops refreshing it when moving away", async () => {
    const s = sink();
    const cs = contextStore();
    const reg = new LocationRegistrar(s, cs, writeStub);
    await reg.sync([cand("loc:a/1")], { isStationary: true });
    expect(s.registerAvailableEnvironment).toHaveBeenCalledTimes(1);
    s.registerAvailableEnvironment.mockClear();
    await reg.sync([cand("loc:b/2")], { isStationary: false, speedMetersPerSecond: 18 });
    expect(s.registerAvailableEnvironment).not.toHaveBeenCalled();
  });
});

describe("isDwellArrival", () => {
  it("accepts stationary / dwelled / slow; rejects clearly moving", () => {
    expect(isDwellArrival({ isStationary: true })).toBe(true);
    expect(isDwellArrival({ dwellSeconds: 45 })).toBe(true);
    expect(isDwellArrival({ speedMetersPerSecond: 0.5 })).toBe(true);
    expect(isDwellArrival({ isStationary: false, speedMetersPerSecond: 20, dwellSeconds: 2 })).toBe(false);
    expect(isDwellArrival({ isStationary: false })).toBe(false);
  });
  it("is permissive with no usable motion signal (back-compat)", () => {
    expect(isDwellArrival(undefined)).toBe(true);
    expect(isDwellArrival({})).toBe(true);
  });
});
