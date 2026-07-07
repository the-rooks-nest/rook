import path from "node:path";
import type { EnvironmentDecisionStore } from "./EnvironmentDecisionStore.js";
import type { EnvironmentPreview } from "../../shared/environment.js";
import type { EnvironmentRepositoryService } from "./EnvironmentRepositoryService.js";
import { ensurePersonalEnvironmentBinding } from "./EnvironmentBinding.js";
import {
  NoopEnvironmentRegistrationCaptureSink,
  type EnvironmentRegistrationCaptureSink,
} from "./environmentMetadataCapture.js";
import { renderEnvironmentPrompt } from "./EnvironmentPromptTemplate.js";
import { renderRookIdentityPrompt } from "./RookIdentityPrompt.js";
import { SessionDecisionRegistry } from "./SessionDecisionRegistry.js";
import type {
  EnvironmentDecision,
  EnvironmentEventListener,
  EnvironmentOfferInfo,
  EnvironmentRecord,
  EffectiveDecision,
  EnvironmentResolution,
} from "./types.js";

interface RememberedBundleEntry {
  bundleId: string;
  bundleHash: string;
  bundlePath?: string;
  skills: string[];
  mcpServers: string[];
  apps: string[];
  agentsMd?: string;
}

interface RememberedEnvironmentEntry {
  record: EnvironmentRecord;
  info: EnvironmentOfferInfo;
  registeredAt?: string;
  lastTouchedAt: string;
  activeUntil?: string;
  status: "active" | "recent";
  contextText?: string;
  bundles: RememberedBundleEntry[];
  bundleIds: string[];
  bundleCollectionPaths: string[];
}

export interface DiagnosticEnvironmentEntry {
  environmentId: string;
  status: "active" | "recent";
  record: EnvironmentRecord;
  info: EnvironmentOfferInfo;
  registeredAt?: string;
  lastTouchedAt: string;
  activeUntil?: string;
  contextText?: string;
  bundles: Array<RememberedBundleEntry & { effectiveDecision: EffectiveDecision }>;
  bundleIds: string[];
  bundleCollectionPaths: string[];
  effectiveDecision: EffectiveDecision;
}

export interface EnvironmentManagerOptions {
  activeEnvironmentWindowMs?: number;
  recentEnvironmentRetentionMs?: number;
  logger?: { info: (...args: any[]) => void };
  now?: () => number;
  registrationCaptureSink?: EnvironmentRegistrationCaptureSink;
}

/**
 * Environment manager.
 *
 * Decision model (the 2×2):
 *   positive × permanent = "approve" → SQLite, survives restarts
 *   positive × session   = "accept"  → in-memory per-session, cleared on exit/expiry
 *   negative × session   = "ignore"  → in-memory per-session, cleared on exit/expiry
 *   negative × permanent = "reject"  → SQLite, survives restarts
 *
 * Behavior:
 * - keep environments in memory as either active or recent
 * - on registration, resolve any valid bundles and remember their exact-content hashes
 * - bundle offers are only issued when a session enters an environment, not on registration
 * - session decisions (accept/ignore) are per-session — session 2 entering the same env
 *   sees its own fresh offers regardless of what session 1 decided
 * - when a session exits an environment, its session decisions for that env are cleared
 * - when a user approves/accepts, any session already inside the env gets skills reloaded
 */
function environmentHierarchy(environmentId: string): string[] {
  const separator = environmentId.indexOf(":");
  if (separator === -1) return [environmentId];

  const prefix = environmentId.slice(0, separator + 1);
  const rest = environmentId.slice(separator + 1);
  if (!rest) return [environmentId];

  const parts = rest.split("/").filter(Boolean);
  if (parts.length === 0) return [environmentId];

  return parts.map((_, index) => `${prefix}${parts.slice(0, index + 1).join("/")}`);
}

export class EnvironmentManager {
  private readonly remembered = new Map<string, RememberedEnvironmentEntry>();
  private readonly sessionDecisions: SessionDecisionRegistry;
  private readonly listeners = new Map<string, EnvironmentEventListener>();
  private readonly explicitlyEntered = new Map<string, Set<string>>();
  private readonly entered = new Map<string, Set<string>>();
  private readonly activeEnvironmentWindowMs: number;
  private readonly recentEnvironmentRetentionMs: number;
  private readonly logger: { info: (...args: any[]) => void };
  private readonly now: () => number;
  private readonly expiryTimer: ReturnType<typeof setInterval>;
  private readonly registrationCaptureSink: EnvironmentRegistrationCaptureSink;

  constructor(
    private readonly repositoryService: EnvironmentRepositoryService,
    decisions: EnvironmentDecisionStore,
    options: EnvironmentManagerOptions = {},
  ) {
    this.sessionDecisions = new SessionDecisionRegistry(decisions);
    this.activeEnvironmentWindowMs = options.activeEnvironmentWindowMs ?? 6 * 60_000;
    this.recentEnvironmentRetentionMs = options.recentEnvironmentRetentionMs ?? 30 * 60_000;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.registrationCaptureSink = options.registrationCaptureSink ?? new NoopEnvironmentRegistrationCaptureSink();
    this.expiryTimer = setInterval(() => this.pruneMemory(), Math.min(this.activeEnvironmentWindowMs, 60_000));
    this.expiryTimer.unref?.();
  }

  async registerAvailableEnvironment(env: EnvironmentRecord, info: EnvironmentOfferInfo = {}, contextText?: string): Promise<void> {
    this.pruneMemory();

    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const existing = this.remembered.get(env.id);
    try {
      await this.registrationCaptureSink.capture({
        capturedAt: nowIso,
        environmentId: env.id,
        sourceName: info.sourceName,
        canonicalSourceUrl: info.canonicalSourceUrl,
        metadata: env.metadata,
      });
    } catch (error) {
      this.logger.info({ environmentId: env.id, error }, "failed to append environment metadata capture");
    }
    const registeredAt = existing?.status === "active" ? (existing.registeredAt ?? nowIso) : nowIso;
    const activeUntil = new Date(now + this.activeEnvironmentWindowMs).toISOString();
    const resolvedBundles = await this.repositoryService.getResolvedBundles(env.id);
    const bundles = resolvedBundles.map(({ bundle, bundleHash }) => ({
      bundleId: bundle.bundleId,
      bundleHash,
      bundlePath: bundle.bundlePath,
      skills: bundle.skills.map((artifact) => artifact.id).sort((a, b) => a.localeCompare(b)),
      mcpServers: bundle.mcpServers.map((artifact) => artifact.id).sort((a, b) => a.localeCompare(b)),
      apps: bundle.apps.map((artifact) => artifact.id).sort((a, b) => a.localeCompare(b)),
      agentsMd: bundle.agentsMd,
    }));
    const bundleIds = bundles.map((bundle) => bundle.bundleId);
    const bundleCollectionPaths = [...new Set(
      bundles
        .map((bundle) => bundle.bundlePath)
        .filter((bundlePath): bundlePath is string => Boolean(bundlePath))
        .map((bundlePath) => path.dirname(bundlePath)),
    )].sort((a, b) => a.localeCompare(b));
    const entry: RememberedEnvironmentEntry = {
      record: {
        id: env.id,
        metadata: {
          ...env.metadata,
          registeredAt,
        },
      },
      info,
      registeredAt,
      lastTouchedAt: nowIso,
      activeUntil,
      status: "active",
      bundles,
      bundleIds,
      bundleCollectionPaths,
      ...(contextText ? { contextText } : {}),
    };
    this.remembered.set(env.id, entry);
    this.logger.info(
      {
        environmentId: env.id,
        previousStatus: existing?.status,
        registeredAt,
        activeUntil,
        sourceName: info.sourceName,
        bundleIds,
        bundleCollectionPaths,
      },
      "environment registered",
    );

    const previousBundles = existing?.status === "active" ? existing.bundles : [];
    const previousBundleHashes = new Set(previousBundles.map((bundle) => bundle.bundleHash));
    const currentBundleHashes = new Set(bundles.map((bundle) => bundle.bundleHash));
    for (const previousBundle of previousBundles) {
      if (currentBundleHashes.has(previousBundle.bundleHash)) continue;
      this.sessionDecisions.clearAllForBundle(previousBundle.bundleHash);
      this.broadcastBundleResolution(env.id, previousBundle.bundleId, previousBundle.bundleHash, "unavailable");
    }
    // Offers are deferred until a session enters the environment (see syncEnteredEnvironments).

    // Auto-register any hierarchy parents that aren't already active so
    // computeEffectiveEnteredSet can cascade entry into them. Parents get a
    // minimal no-bundle entry (same info / contextText as the child).
    for (const parentId of environmentHierarchy(env.id)) {
      if (parentId === env.id) continue;
      const parent = this.remembered.get(parentId);
      if (parent?.status === "active") continue;

      const parentEntry: RememberedEnvironmentEntry = {
        record: { id: parentId, metadata: { ...env.metadata, registeredAt: nowIso } },
        // Strip sourceName so the parent's label in the UI won't be a duplicate
        // of the child's. canonicalSourceUrl is still useful and non-confusing.
        info: { canonicalSourceUrl: info.canonicalSourceUrl },
        registeredAt: nowIso,
        lastTouchedAt: nowIso,
        activeUntil,
        status: "active",
        bundles: [],
        bundleIds: [],
        bundleCollectionPaths: [],
        ...(contextText ? { contextText } : {}),
      };
      this.remembered.set(parentId, parentEntry);
      this.logger.info(
        { environmentId: parentId, parentOf: env.id, registeredAt: nowIso, activeUntil },
        "environment auto-registered (parent)",
      );
    }
  }

  /**
   * Record a decision. Persistent decisions (approve/reject) go to SQLite.
   * Session decisions (accept/ignore) are per-session in-memory and cleared on exit/expiry.
   *
   * @param sessionId required for session-scoped decisions (accept/ignore); optional for permanent.
   */
  decideEnvironment(environmentId: string, decision: EnvironmentDecision, bundleHash?: string, sessionId?: string): void {
    this.pruneMemory();
    const decisionKey = bundleHash ?? environmentId;
    const bundle = bundleHash
      ? this.remembered.get(environmentId)?.bundles.find((candidate) => candidate.bundleHash === bundleHash)
      : undefined;

    if (decision === "approve" || decision === "reject") {
      // Permanent: store in SQLite, clear session-level overrides.
      this.sessionDecisions.setPermanent(decisionKey, environmentId, bundle?.bundleId ?? null, decision);
    } else {
      // Session-scoped: store per-session. If no sessionId is provided,
      // apply to every session that has entered this environment (fallback).
      const targetSessions = sessionId
        ? [sessionId]
        : [...this.entered.entries()].filter(([, envs]) => envs.has(environmentId)).map(([sid]) => sid);
      for (const sid of targetSessions) {
        this.sessionDecisions.setSession(sid, decisionKey, decision);
      }
    }

    if (bundle) {
      this.broadcastBundleResolution(
        environmentId,
        bundle.bundleId,
        bundle.bundleHash,
        decision === "accept" || decision === "approve" ? "approved" : "dismissed",
      );
    }

    // When accepting or approving a bundle, reload skills for any session already inside this env.
    if (decision === "accept" || decision === "approve") {
      for (const [sid, entered] of this.entered.entries()) {
        if (!entered.has(environmentId)) continue;
        const listener = this.listeners.get(sid);
        if (!listener) continue;
        const entry = this.remembered.get(environmentId);
        if (!entry || entry.status !== "active") continue;
        listener.onEnvironmentEntered(environmentId, this.skillPathsForEntry(entry, sid), entry.contextText);
      }
    }
  }

  /** Get the effective decision for a bundle hash from a session's perspective. */
  effectiveDecision(bundleHash: string, sessionId?: string): EffectiveDecision {
    this.pruneMemory();
    return this.sessionDecisions.effective(bundleHash, sessionId);
  }

  subscribe(sessionId: string, listener: EnvironmentEventListener): void {
    this.pruneMemory();
    this.listeners.set(sessionId, listener);
    if (!this.explicitlyEntered.has(sessionId)) this.explicitlyEntered.set(sessionId, new Set());
    if (!this.entered.has(sessionId)) this.entered.set(sessionId, new Set());
    // Offers are deferred until the session enters an environment.
  }

  unsubscribe(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.explicitlyEntered.delete(sessionId);
    this.entered.delete(sessionId);
    this.sessionDecisions.clearSession(sessionId);
  }

  async getEnvironmentPreview(environmentId: string): Promise<EnvironmentPreview> {
    return this.repositoryService.getEnvironmentPreview(environmentId);
  }

  isAvailable(environmentId: string): boolean {
    this.pruneMemory();
    return this.remembered.get(environmentId)?.status === "active";
  }

  enteredEnvironments(sessionId: string): string[] {
    return [...(this.entered.get(sessionId) ?? [])];
  }

  runtimeInstructionsForSession(sessionId: string): string | undefined {
    const entries = this.enteredEnvironments(sessionId)
      .map((environmentId) => {
        const remembered = this.remembered.get(environmentId);
        const binding = ensurePersonalEnvironmentBinding(environmentId);
        if (!binding) return null;

        // Gather AGENTS.md content from every remembered bundle that has it.
        const agentsMdBundles = (remembered?.bundles ?? [])
          .filter((b) => b.agentsMd)
          .map((b) => ({ bundleId: b.bundleId, content: b.agentsMd! }));

        return {
          environmentId,
          metadata: (remembered?.record.metadata ?? {}) as Record<string, unknown>,
          sourceName: remembered?.info.sourceName,
          canonicalSourceUrl: remembered?.info.canonicalSourceUrl,
          contextText: remembered?.contextText,
          bindingDir: binding.personalBundleDir,
          skillsDir: binding.skillsDir,
          existingSkills: binding.existingSkills,
          agentsMdBundles,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const envPrompt = renderEnvironmentPrompt(entries);
    return [renderRookIdentityPrompt(), envPrompt].filter(Boolean).join("\n\n");
  }

  enterEnvironment(sessionId: string, environmentId: string): string[] {
    this.pruneMemory();
    const listener = this.listeners.get(sessionId);
    if (!listener) return [];

    const entry = this.remembered.get(environmentId);
    if (!entry || entry.status !== "active") return [];

    if (!this.explicitlyEntered.has(sessionId)) this.explicitlyEntered.set(sessionId, new Set());
    this.explicitlyEntered.get(sessionId)!.add(environmentId);

    return this.syncEnteredEnvironments(sessionId, listener);
  }

  exitEnvironment(sessionId: string, environmentId: string): string[] {
    this.pruneMemory();
    const listener = this.listeners.get(sessionId);
    if (!listener) return this.enteredEnvironments(sessionId);

    const explicit = this.explicitlyEntered.get(sessionId);
    if (!explicit?.has(environmentId)) return this.enteredEnvironments(sessionId);
    explicit.delete(environmentId);

    return this.syncEnteredEnvironments(sessionId, listener);
  }

  diagnosticSnapshot(sessionId?: string): DiagnosticEnvironmentEntry[] {
    this.pruneMemory();
    return [...this.remembered.entries()]
      .map(([environmentId, entry]) => ({
        environmentId,
        status: entry.status,
        record: entry.record,
        info: entry.info,
        registeredAt: entry.registeredAt,
        lastTouchedAt: entry.lastTouchedAt,
        activeUntil: entry.activeUntil,
        contextText: entry.contextText,
        bundles: entry.bundles.map((bundle) => ({
          ...bundle,
          effectiveDecision: this.effectiveDecision(bundle.bundleHash, sessionId),
        })),
        bundleIds: entry.bundleIds,
        bundleCollectionPaths: entry.bundleCollectionPaths,
        effectiveDecision: this.effectiveDecision(environmentId, sessionId),
      }))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return a.environmentId.localeCompare(b.environmentId);
      });
  }

  environmentList(sessionId: string): {
    environmentId: string;
    sourceName?: string;
    status: "active" | "recent";
    lastTouchedAt: string;
    entered: boolean;
    bundleCount: number;
    approvedBundleCount: number;
  }[] {
    this.pruneMemory();
    const entered = this.entered.get(sessionId) ?? new Set();
    const entries = this.diagnosticSnapshot(sessionId);

    const list = entries.map((entry) => {
      const approved = entry.bundles.filter(
        (b) => b.effectiveDecision === "accept" || b.effectiveDecision === "approve",
      ).length;
      return {
        environmentId: entry.environmentId,
        sourceName: entry.info.sourceName,
        status: entry.status,
        lastTouchedAt: entry.lastTouchedAt,
        entered: entered.has(entry.environmentId),
        bundleCount: entry.bundles.length,
        approvedBundleCount: approved,
      };
    });

    // Sort: entered first, then active by recency, then recent by recency.
    list.sort((a, b) => {
      if (a.entered !== b.entered) return a.entered ? -1 : 1;
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return b.lastTouchedAt.localeCompare(a.lastTouchedAt);
    });

    return list;
  }

  private syncEnteredEnvironments(sessionId: string, listener: EnvironmentEventListener): string[] {
    if (!this.entered.has(sessionId)) this.entered.set(sessionId, new Set());
    const current = this.entered.get(sessionId)!;
    const next = this.computeEffectiveEnteredSet(sessionId);

    for (const environmentId of next) {
      if (current.has(environmentId)) continue;
      const entry = this.remembered.get(environmentId);
      if (!entry || entry.status !== "active") continue;

      ensurePersonalEnvironmentBinding(environmentId);
      listener.onEnvironmentEntered(environmentId, this.skillPathsForEntry(entry, sessionId), entry.contextText);

      // Offer undecided bundles only when this session enters the environment.
      for (const bundle of entry.bundles) {
        if (this.effectiveDecision(bundle.bundleHash, sessionId) !== "undecided") continue;
        listener.onEnvironmentOffered({
          environmentId,
          bundleId: bundle.bundleId,
          bundleHash: bundle.bundleHash,
          sourceName: entry.info.sourceName,
          canonicalSourceUrl: entry.info.canonicalSourceUrl,
          skills: bundle.skills,
          mcpServers: bundle.mcpServers,
          apps: bundle.apps,
        });
      }
    }

    for (const environmentId of current) {
      if (next.has(environmentId)) continue;
      listener.onEnvironmentExited(environmentId);
      // Clear this session's decisions for the exited environment's bundles.
      const entry = this.remembered.get(environmentId);
      if (entry) {
        this.sessionDecisions.clearSessionForBundles(sessionId, entry.bundles.map((b) => b.bundleHash));
      }
    }

    this.entered.set(sessionId, next);
    return [...next];
  }

  private computeEffectiveEnteredSet(sessionId: string): Set<string> {
    const effective = new Set<string>();
    for (const environmentId of this.explicitlyEntered.get(sessionId) ?? []) {
      for (const candidateId of environmentHierarchy(environmentId)) {
        const entry = this.remembered.get(candidateId);
        if (!entry || entry.status !== "active") continue;
        effective.add(candidateId);
      }
    }
    return effective;
  }

  private skillPathsForEntry(entry: RememberedEnvironmentEntry, sessionId: string): string[] {
    const skillPaths: string[] = [];
    for (const bundle of entry.bundles) {
      const decision = this.sessionDecisions.effective(bundle.bundleHash, sessionId);
      if (decision !== "accept" && decision !== "approve") continue;
      if (!bundle.bundlePath) continue;
      for (const skillId of bundle.skills) {
        skillPaths.push(path.join(bundle.bundlePath, "skills", skillId));
      }
    }
    return skillPaths;
  }

  private broadcastBundleResolution(environmentId: string, bundleId: string, bundleHash: string, resolution: EnvironmentResolution): void {
    for (const listener of this.listeners.values()) {
      listener.onEnvironmentResolved(environmentId, bundleId, bundleHash, resolution);
    }
  }

  close(): void {
    clearInterval(this.expiryTimer);
  }

  private pruneMemory(): void {
    const now = this.now();
    for (const [environmentId, entry] of this.remembered.entries()) {
      if (entry.status === "active") {
        const activeUntil = entry.activeUntil ? Date.parse(entry.activeUntil) : 0;
        if (activeUntil <= now) {
          this.remembered.set(environmentId, {
            ...entry,
            status: "recent",
            activeUntil: undefined,
          });
          // Clear all sessions' decisions for this environment's bundles.
          this.sessionDecisions.clearAllForBundles(entry.bundles.map((b) => b.bundleHash));
          for (const bundle of entry.bundles) {
            this.broadcastBundleResolution(environmentId, bundle.bundleId, bundle.bundleHash, "unavailable");
          }
          this.logger.info(
            {
              environmentId,
              registeredAt: entry.registeredAt,
              lastTouchedAt: entry.lastTouchedAt,
            },
            "environment moved to recent",
          );
          continue;
        }
      }

      if (entry.status === "recent") {
        const lastTouchedAt = Date.parse(entry.lastTouchedAt);
        if (lastTouchedAt + this.recentEnvironmentRetentionMs > now) continue;
        this.remembered.delete(environmentId);
        this.sessionDecisions.clearAllForBundles(entry.bundles.map((b) => b.bundleHash));
        this.logger.info(
          {
            environmentId,
            lastTouchedAt: entry.lastTouchedAt,
          },
          "environment forgotten",
        );
      }
    }
  }
}
