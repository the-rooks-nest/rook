import type { SessionDecision, EffectiveDecision, PermanentDecision } from "./types.js";
import type { EnvironmentDecisionStore } from "./EnvironmentDecisionStore.js";

/**
 * Per-session, in-memory decision registry.
 *
 * Each session gets its own map of (bundleHash → accept/ignore).
 * Permanent decisions (approve/reject) live in the EnvironmentDecisionStore (SQLite)
 * and are consulted as a fallback via the provided store reference.
 *
 * Session decisions are cleared when:
 * - the session exits the environment (caller calls clearSessionForBundles)
 * - the environment expires (caller calls clearAllForBundles)
 * - a bundle disappears on re-registration (caller calls clearAllForBundle)
 * - the session unsubscribes (caller calls clearSession)
 */
export class SessionDecisionRegistry {
  private readonly perSession = new Map<string, Map<string, SessionDecision>>();

  constructor(private readonly permanentStore: EnvironmentDecisionStore) {}

  /** Effective decision for a bundle hash from a session's perspective. */
  effective(bundleHash: string, sessionId?: string): EffectiveDecision {
    if (sessionId) {
      const sessionDecision = this.perSession.get(sessionId)?.get(bundleHash);
      if (sessionDecision) return sessionDecision;
    }
    return this.permanentStore.getDecision(bundleHash) ?? "undecided";
  }

  /** Store a permanent decision (clears any session-level override for this hash). */
  setPermanent(bundleHash: string, environmentId: string, bundleId: string | null, decision: PermanentDecision): void {
    this.permanentStore.setDecision(bundleHash, environmentId, bundleId, decision);
    this.clearAllForBundle(bundleHash);
  }

  /** Store a session-scoped decision for the given session. Does nothing without sessionId. */
  setSession(sessionId: string | undefined, bundleHash: string, decision: SessionDecision): void {
    if (!sessionId) return;
    let map = this.perSession.get(sessionId);
    if (!map) {
      map = new Map();
      this.perSession.set(sessionId, map);
    }
    map.set(bundleHash, decision);
  }

  /** Drop all decisions for the given session (on unsubscribe). */
  clearSession(sessionId: string): void {
    this.perSession.delete(sessionId);
  }

  /** Drop this session's decisions for the given bundle hashes (on environment exit). */
  clearSessionForBundles(sessionId: string, bundleHashes: Iterable<string>): void {
    const map = this.perSession.get(sessionId);
    if (!map) return;
    for (const hash of bundleHashes) {
      map.delete(hash);
    }
    if (map.size === 0) this.perSession.delete(sessionId);
  }

  /** Drop every session's decision for a single bundle hash (bundle removed on re-registration). */
  clearAllForBundle(bundleHash: string): void {
    for (const map of this.perSession.values()) {
      map.delete(bundleHash);
    }
  }

  /** Drop every session's decisions for multiple bundle hashes (environment expired). */
  clearAllForBundles(bundleHashes: Iterable<string>): void {
    for (const hash of bundleHashes) {
      this.clearAllForBundle(hash);
    }
  }

  /** Whether any session has any decision. */
  get isEmpty(): boolean {
    return this.perSession.size === 0;
  }
}
