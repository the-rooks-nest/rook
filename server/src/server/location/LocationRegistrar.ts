import type { EnvironmentCandidate } from "../../shared/environment.js";
import { writeLocationContextSkill } from "./LocationContextSkill.js";

/** The slice of EnvironmentManager the registrar needs (eases testing). */
export interface LocationEnvironmentSink {
  registerAvailableEnvironment(
    env: { id: string; metadata: Record<string, unknown> },
    info: { sourceName?: string; canonicalSourceUrl?: string },
    extraSkillPaths?: string[],
  ): Promise<void>;
  unregister(environmentId: string): boolean;
  decideEnvironment(environmentId: string, decision: "accept" | "approve" | "ignore" | "reject"): void;
}

type ContextSkillWriter = (current: EnvironmentCandidate, nearby: EnvironmentCandidate[]) => string;

/** Motion/dwell signal from the identify request, used to reject drive-by registration. */
export interface ArrivalMotion {
  isStationary?: boolean;
  dwellSeconds?: number;
  speedMetersPerSecond?: number;
}

/** Min sustained dwell (s) to treat a detection as a real visit (from trace analysis). */
export const MIN_DWELL_SECONDS = 30;
/** Speed (m/s) at/below which the device is "settled" (matches the client gate). */
export const STATIONARY_SPEED_MPS = 1.5;

/**
 * Whether an identify request looks like a real arrival/dwell (vs a drive-by). Trace
 * analysis shows visits are minutes-long at ~0 m/s while pass-throughs are brief and
 * fast, so we register only when the device is stationary / dwelled / slow. With no
 * usable motion signal we stay permissive (back-compat).
 */
export function isDwellArrival(m: ArrivalMotion | undefined, minDwellSeconds = MIN_DWELL_SECONDS, stationarySpeed = STATIONARY_SPEED_MPS): boolean {
  if (!m) return true;
  if (m.isStationary === true) return true;
  if ((m.dwellSeconds ?? 0) >= minDwellSeconds) return true;
  if (m.speedMetersPerSecond !== undefined) return m.speedMetersPerSecond <= stationarySpeed;
  if (m.isStationary === false) return false; // explicitly moving, no other signal
  return true; // no usable motion signal -> permissive
}

/** Build the registration metadata from a candidate (the full business record). */
function metadataFor(c: EnvironmentCandidate, current: boolean): Record<string, unknown> {
  return {
    current,
    displayName: c.displayName,
    ...(c.operator ? { operator: c.operator } : {}),
    ...(c.storeNumber ? { storeNumber: c.storeNumber } : {}),
    ...(c.address ? { address: c.address } : {}),
    ...(c.website ? { website: c.website } : {}),
    ...(c.latitude !== undefined ? { latitude: c.latitude } : {}),
    ...(c.longitude !== undefined ? { longitude: c.longitude } : {}),
    ...(c.matchReasons ? { matchReasons: c.matchReasons } : {}),
    confidence: c.confidence,
  };
}

/**
 * Registers the identified in-building set into the environment availability flow
 * (server-side, on each identify). Marks one best-guess "current" business that
 * auto-enters with a synthesized location-context skill; registers the same-building
 * neighbors so their (hierarchical) skills can load. Replaces the prior set each call.
 */
export class LocationRegistrar {
  private registeredIds: string[] = [];

  constructor(
    private readonly manager: LocationEnvironmentSink,
    private readonly writeContextSkill: ContextSkillWriter = writeLocationContextSkill,
  ) {}

  async sync(candidates: EnvironmentCandidate[], motion?: ArrivalMotion): Promise<void> {
    // Only make a location available to the agent on a real dwell, not a drive-by.
    const dwell = isDwellArrival(motion);
    const nextIds = dwell ? candidates.map((c) => c.environmentId) : [];
    if (sameSet(nextIds, this.registeredIds)) return; // no change -> avoid agent churn

    // Replace the whole prior set.
    for (const id of this.registeredIds) this.manager.unregister(id);
    this.registeredIds = [];

    if (!dwell || candidates.length === 0) return; // moving through, or left the area

    const [current, ...nearby] = candidates;
    const contextDir = this.writeContextSkill(current, nearby);

    await this.manager.registerAvailableEnvironment(
      { id: current.environmentId, metadata: metadataFor(current, true) },
      { sourceName: current.displayName, ...(current.website ? { canonicalSourceUrl: current.website } : {}) },
      [contextDir],
    );
    // Auto-enter the current location so the agent gets the context immediately.
    this.manager.decideEnvironment(current.environmentId, "accept");

    for (const c of nearby) {
      await this.manager.registerAvailableEnvironment(
        { id: c.environmentId, metadata: metadataFor(c, false) },
        { sourceName: c.displayName, ...(c.website ? { canonicalSourceUrl: c.website } : {}) },
      );
    }

    this.registeredIds = nextIds;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}
