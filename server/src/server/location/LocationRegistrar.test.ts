// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentCandidate } from "../../shared/environment.js";
import { isDwellArrival, LocationRegistrar, type LocationEnvironmentSink } from "./LocationRegistrar.js";

function sink() {
  return {
    registerAvailableEnvironment: vi.fn(async () => {}),
    unregister: vi.fn(() => true),
    decideEnvironment: vi.fn(),
  } satisfies LocationEnvironmentSink;
}

function cand(id: string, over: Partial<EnvironmentCandidate> = {}): EnvironmentCandidate {
  return { environmentId: id, displayName: id, confidence: 0.9, matchReasons: [], hasKnownEnvironment: false, ...over };
}

const writeStub = () => "/tmp/ctx";

describe("LocationRegistrar", () => {
  it("registers current (with context skill + accept) and neighbors", async () => {
    const s = sink();
    const reg = new LocationRegistrar(s, writeStub);
    await reg.sync([
      cand("loc:cicis.com/a", { website: "https://cicis.com/x" }),
      cand("loc:gamestop.com/b"),
    ]);

    expect(s.registerAvailableEnvironment).toHaveBeenCalledTimes(2);
    // current gets the context skill path + canonicalSourceUrl + accept
    expect(s.registerAvailableEnvironment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "loc:cicis.com/a", metadata: expect.objectContaining({ current: true }) }),
      expect.objectContaining({ sourceName: "loc:cicis.com/a", canonicalSourceUrl: "https://cicis.com/x" }),
      ["/tmp/ctx"],
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
    const reg = new LocationRegistrar(s, writeStub);
    const set = [cand("loc:a/1"), cand("loc:b/2")];
    await reg.sync(set);
    s.registerAvailableEnvironment.mockClear();
    s.unregister.mockClear();
    await reg.sync([cand("loc:a/1"), cand("loc:b/2")]);
    expect(s.registerAvailableEnvironment).not.toHaveBeenCalled();
    expect(s.unregister).not.toHaveBeenCalled();
  });

  it("replaces the prior set when it changes", async () => {
    const s = sink();
    const reg = new LocationRegistrar(s, writeStub);
    await reg.sync([cand("loc:a/1"), cand("loc:b/2")]);
    s.registerAvailableEnvironment.mockClear();
    await reg.sync([cand("loc:c/3")]);
    expect(s.unregister).toHaveBeenCalledWith("loc:a/1");
    expect(s.unregister).toHaveBeenCalledWith("loc:b/2");
    expect(s.registerAvailableEnvironment).toHaveBeenCalledTimes(1);
  });

  it("unregisters everything when no candidates remain", async () => {
    const s = sink();
    const reg = new LocationRegistrar(s, writeStub);
    await reg.sync([cand("loc:a/1")]);
    s.unregister.mockClear();
    await reg.sync([]);
    expect(s.unregister).toHaveBeenCalledWith("loc:a/1");
  });

  it("does not register a drive-by (moving, not dwelled)", async () => {
    const s = sink();
    const reg = new LocationRegistrar(s, writeStub);
    await reg.sync([cand("loc:a/1")], { isStationary: false, speedMetersPerSecond: 20, dwellSeconds: 2 });
    expect(s.registerAvailableEnvironment).not.toHaveBeenCalled();
  });

  it("registers a real dwell, then drops it when moving away", async () => {
    const s = sink();
    const reg = new LocationRegistrar(s, writeStub);
    await reg.sync([cand("loc:a/1")], { isStationary: true });
    expect(s.registerAvailableEnvironment).toHaveBeenCalledTimes(1);
    await reg.sync([cand("loc:b/2")], { isStationary: false, speedMetersPerSecond: 18 });
    expect(s.unregister).toHaveBeenCalledWith("loc:a/1");
    expect(s.registerAvailableEnvironment).toHaveBeenCalledTimes(1);
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
