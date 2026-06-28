import type { LocalEnvironmentRepository } from "./LocalEnvironmentRepository.js";
import type { EnvironmentDecisionStore } from "./EnvironmentDecisionStore.js";
import type { SkillPreview } from "../../shared/environment.js";
import type {
  EnvironmentDecision,
  EnvironmentEventListener,
  EnvironmentOfferInfo,
  EnvironmentRecord,
  EffectiveDecision,
  EphemeralDecision,
} from "./types.js";

interface AvailableEnvironment {
  record: EnvironmentRecord;
  skillPaths: string[];
  info: EnvironmentOfferInfo;
}

interface DirectEnvironmentRegistration {
  record: EnvironmentRecord;
  info: EnvironmentOfferInfo;
  impliedIds: string[];
}

/**
 * Service-layer coordinator for the environment model (see the brainstorm doc).
 *
 * Three orthogonal concepts:
 *  - **available** — global, in-memory: an env is currently "around" (provider says so).
 *  - **decision** — per-environment, global: the 2×2 (accept/approve/ignore/reject).
 *      Ephemeral (accept/ignore) is in-memory and cleared when the env leaves; persistent
 *      (approve/reject) lives in the decision store. Ephemeral overrides persistent.
 *  - **entered** — per-session, derived: a room has an env iff it's available AND the
 *      effective decision is accept/approve.
 *
 * The manager never touches runtimes or sockets; it pushes lifecycle calls to subscribed
 * SessionRooms (the listeners), which load/unload skills and fan out to clients.
 */
export class EnvironmentManager {
  private readonly available = new Map<string, AvailableEnvironment>();
  private readonly directRegistrations = new Map<string, DirectEnvironmentRegistration>();
  private readonly availableRefCounts = new Map<string, number>();
  private readonly ephemeral = new Map<string, EphemeralDecision>();
  private readonly listeners = new Map<string, EnvironmentEventListener>();
  private readonly entered = new Map<string, Set<string>>();

  constructor(
    private readonly repository: LocalEnvironmentRepository,
    private readonly decisions: EnvironmentDecisionStore,
  ) {}

  // --- Availability lifecycle -------------------------------------------------

  /**
   * A provider reports the user is now "in" this environment. Applies to all open rooms.
   * `extraSkillPaths` are merged into the leaf env's skills (used to inject a
   * synthesized location-context bundle so a skill-less env still carries metadata).
   */
  async registerAvailableEnvironment(env: EnvironmentRecord, info: EnvironmentOfferInfo = {}, extraSkillPaths: string[] = []): Promise<void> {
    const impliedIds = this.impliedEnvironmentIds(env.id);
    const existing = this.directRegistrations.get(env.id);
    if (existing) {
      this.directRegistrations.set(env.id, { record: env, info, impliedIds });
      return;
    }

    this.directRegistrations.set(env.id, { record: env, info, impliedIds });
    for (const impliedId of impliedIds) {
      const nextCount = (this.availableRefCounts.get(impliedId) ?? 0) + 1;
      this.availableRefCounts.set(impliedId, nextCount);
      if (nextCount > 1) continue;

      const repoSkillPaths = await this.repository.getSkillPaths(impliedId);
      // Only the leaf (the registered id itself) gets the injected extra skills.
      const skillPaths = impliedId === env.id ? [...new Set([...repoSkillPaths, ...extraSkillPaths])] : repoSkillPaths;
      this.available.set(impliedId, {
        record: { id: impliedId, metadata: env.metadata },
        skillPaths,
        info,
      });
      for (const sessionId of this.listeners.keys()) {
        this.applyEnvironmentToSession(sessionId, impliedId);
      }
    }
  }

  /** A provider reports the environment is gone (e.g. the page closed). Ends the episode. */
  unregister(environmentId: string): boolean {
    const direct = this.directRegistrations.get(environmentId);
    if (!direct) return false;
    this.directRegistrations.delete(environmentId);

    for (const impliedId of [...direct.impliedIds].reverse()) {
      const nextCount = (this.availableRefCounts.get(impliedId) ?? 0) - 1;
      if (nextCount > 0) {
        this.availableRefCounts.set(impliedId, nextCount);
        continue;
      }
      this.availableRefCounts.delete(impliedId);
      this.available.delete(impliedId);
      this.ephemeral.delete(impliedId);
      for (const sessionId of this.listeners.keys()) {
        const listener = this.listeners.get(sessionId)!;
        this.exitForSession(sessionId, impliedId);
        listener.onEnvironmentResolved(impliedId, "unavailable");
      }
    }
    return true;
  }

  // --- Decisions (the 2×2) ----------------------------------------------------

  /** Record a decision (global, from any client) and re-apply it to every open room. */
  decideEnvironment(environmentId: string, decision: EnvironmentDecision): void {
    if (decision === "approve" || decision === "reject") {
      this.decisions.setDecision(environmentId, decision);
      this.ephemeral.delete(environmentId);
    } else {
      this.ephemeral.set(environmentId, decision);
    }

    const resolution = decision === "accept" || decision === "approve" ? "approved" : "dismissed";
    for (const sessionId of this.listeners.keys()) {
      this.applyEnvironmentToSession(sessionId, environmentId);
      this.listeners.get(sessionId)!.onEnvironmentResolved(environmentId, resolution);
    }
  }

  /** Effective decision: ephemeral (this-visit) overrides persistent (approve/reject). */
  effectiveDecision(environmentId: string): EffectiveDecision {
    const ephemeral = this.ephemeral.get(environmentId);
    if (ephemeral) return ephemeral;
    return this.decisions.getDecision(environmentId) ?? "undecided";
  }

  // --- Subscriptions (one per SessionRoom) ------------------------------------

  subscribe(sessionId: string, listener: EnvironmentEventListener): void {
    this.listeners.set(sessionId, listener);
    if (!this.entered.has(sessionId)) this.entered.set(sessionId, new Set());
    for (const environmentId of this.available.keys()) {
      this.applyEnvironmentToSession(sessionId, environmentId);
    }
  }

  unsubscribe(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.entered.delete(sessionId);
  }

  // --- Reads ------------------------------------------------------------------

  async getSkillPreviews(environmentId: string): Promise<SkillPreview[]> {
    return this.repository.getSkillPreviews(environmentId);
  }

  isAvailable(environmentId: string): boolean {
    return this.available.has(environmentId);
  }

  enteredEnvironments(sessionId: string): string[] {
    return [...(this.entered.get(sessionId) ?? [])];
  }

  // --- Internal ---------------------------------------------------------------

  private impliedEnvironmentIds(environmentId: string): string[] {
    const colonIndex = environmentId.indexOf(":");
    if (colonIndex === -1) return [environmentId];
    const kind = environmentId.slice(0, colonIndex);
    const envPath = environmentId.slice(colonIndex + 1).replace(/\/+$/g, "");
    if (!kind || !envPath) return [environmentId];
    const segments = envPath.split("/").filter(Boolean);
    if (segments.length === 0) return [environmentId];
    const implied: string[] = [];
    for (let i = 1; i <= segments.length; i += 1) {
      implied.push(`${kind}:${segments.slice(0, i).join("/")}`);
    }
    return implied;
  }

  /** Resolve what should happen for one env in one session, per its effective decision. */
  private applyEnvironmentToSession(sessionId: string, environmentId: string): void {
    const listener = this.listeners.get(sessionId);
    const available = this.available.get(environmentId);
    if (!listener || !available) return;
    if (available.skillPaths.length === 0) {
      this.exitForSession(sessionId, environmentId);
      return;
    }

    switch (this.effectiveDecision(environmentId)) {
      case "approve":
      case "accept":
        this.enterForSession(sessionId, environmentId, available);
        break;
      case "ignore":
      case "reject":
        this.exitForSession(sessionId, environmentId);
        break;
      case "undecided":
        listener.onEnvironmentOffered(environmentId, available.info);
        break;
    }
  }

  private enterForSession(sessionId: string, environmentId: string, _available: AvailableEnvironment): void {
    const set = this.entered.get(sessionId)!;
    if (set.has(environmentId)) return;
    set.add(environmentId);
    this.listeners.get(sessionId)!.onEnvironmentEntered(environmentId, this.inheritedSkillPaths(environmentId));
  }

  private inheritedSkillPaths(environmentId: string): string[] {
    const paths = this.impliedEnvironmentIds(environmentId)
      .flatMap((id) => this.available.get(id)?.skillPaths ?? []);
    return [...new Set(paths)];
  }

  private exitForSession(sessionId: string, environmentId: string): void {
    const set = this.entered.get(sessionId);
    if (!set?.has(environmentId)) return;
    set.delete(environmentId);
    this.listeners.get(sessionId)!.onEnvironmentExited(environmentId);
  }
}
