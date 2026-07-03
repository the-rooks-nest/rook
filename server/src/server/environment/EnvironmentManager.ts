import path from "node:path";
import type { EnvironmentDecisionStore } from "./EnvironmentDecisionStore.js";
import type { EnvironmentPreview } from "../../shared/environment.js";
import type { EnvironmentRepositoryService } from "./EnvironmentRepositoryService.js";
import type {
  EnvironmentBundleOffer,
  EnvironmentDecision,
  EnvironmentEventListener,
  EnvironmentOfferInfo,
  EnvironmentRecord,
  EffectiveDecision,
  EphemeralDecision,
  EnvironmentResolution,
} from "./types.js";

interface RememberedBundleEntry {
  bundleId: string;
  bundleHash: string;
  bundlePath?: string;
  skills: string[];
  mcpServers: string[];
  apps: string[];
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
}

/**
 * Simplified environment manager.
 *
 * Current behavior:
 * - keep environments in memory as either active or recent
 * - on registration, resolve any valid bundles and remember their exact-content hashes
 * - active = touched by register within the active window
 * - when the active window expires, the environment moves to recent
 * - recent entries are retained for a second, longer TTL before being forgotten
 * - log register / expiry activity
 * - push bundle offer / resolution events into subscribed rooms
 * - do not yet load bundle capabilities into runtimes during registration
 */
export class EnvironmentManager {
  private readonly remembered = new Map<string, RememberedEnvironmentEntry>();
  private readonly ephemeral = new Map<string, EphemeralDecision>();
  private readonly listeners = new Map<string, EnvironmentEventListener>();
  private readonly entered = new Map<string, Set<string>>();
  private readonly activeEnvironmentWindowMs: number;
  private readonly recentEnvironmentRetentionMs: number;
  private readonly logger: { info: (...args: any[]) => void };
  private readonly now: () => number;
  private readonly expiryTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly repositoryService: EnvironmentRepositoryService,
    private readonly decisions: EnvironmentDecisionStore,
    options: EnvironmentManagerOptions = {},
  ) {
    this.activeEnvironmentWindowMs = options.activeEnvironmentWindowMs ?? 6 * 60_000;
    this.recentEnvironmentRetentionMs = options.recentEnvironmentRetentionMs ?? 30 * 60_000;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.expiryTimer = setInterval(() => this.pruneMemory(), Math.min(this.activeEnvironmentWindowMs, 60_000));
    this.expiryTimer.unref?.();
  }

  async registerAvailableEnvironment(env: EnvironmentRecord, info: EnvironmentOfferInfo = {}, contextText?: string): Promise<void> {
    this.pruneMemory();

    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const existing = this.remembered.get(env.id);
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
      this.ephemeral.delete(previousBundle.bundleHash);
      this.broadcastBundleResolution(env.id, previousBundle.bundleId, previousBundle.bundleHash, "unavailable");
    }
    for (const bundle of bundles) {
      if (previousBundleHashes.has(bundle.bundleHash)) continue;
      if (this.effectiveDecision(bundle.bundleHash) !== "undecided") continue;
      this.broadcastBundleOffer({
        environmentId: env.id,
        bundleId: bundle.bundleId,
        bundleHash: bundle.bundleHash,
        sourceName: info.sourceName,
        canonicalSourceUrl: info.canonicalSourceUrl,
        skills: bundle.skills,
        mcpServers: bundle.mcpServers,
        apps: bundle.apps,
      });
    }
  }

  decideEnvironment(environmentId: string, decision: EnvironmentDecision, bundleHash?: string): void {
    this.pruneMemory();
    const decisionKey = bundleHash ?? environmentId;
    if (decision === "approve" || decision === "reject") {
      this.decisions.setDecision(decisionKey, decision);
      this.ephemeral.delete(decisionKey);
    } else {
      this.ephemeral.set(decisionKey, decision);
    }

    if (bundleHash) {
      const bundle = this.remembered.get(environmentId)?.bundles.find((candidate) => candidate.bundleHash == bundleHash);
      if (bundle) {
        this.broadcastBundleResolution(
          environmentId,
          bundle.bundleId,
          bundle.bundleHash,
          decision === "accept" || decision === "approve" ? "approved" : "dismissed",
        );
      }
    }
  }

  effectiveDecision(environmentId: string): EffectiveDecision {
    this.pruneMemory();
    const ephemeral = this.ephemeral.get(environmentId);
    if (ephemeral) return ephemeral;
    return this.decisions.getDecision(environmentId) ?? "undecided";
  }

  subscribe(sessionId: string, listener: EnvironmentEventListener): void {
    this.pruneMemory();
    this.listeners.set(sessionId, listener);
    if (!this.entered.has(sessionId)) this.entered.set(sessionId, new Set());
    for (const entry of this.remembered.values()) {
      if (entry.status !== "active") continue;
      for (const bundle of entry.bundles) {
        if (this.effectiveDecision(bundle.bundleHash) !== "undecided") continue;
        listener.onEnvironmentOffered({
          environmentId: entry.record.id,
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
  }

  unsubscribe(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.entered.delete(sessionId);
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

  diagnosticSnapshot(): DiagnosticEnvironmentEntry[] {
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
          effectiveDecision: this.effectiveDecision(bundle.bundleHash),
        })),
        bundleIds: entry.bundleIds,
        bundleCollectionPaths: entry.bundleCollectionPaths,
        effectiveDecision: this.effectiveDecision(environmentId),
      }))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return a.environmentId.localeCompare(b.environmentId);
      });
  }

  private broadcastBundleOffer(offer: EnvironmentBundleOffer): void {
    for (const listener of this.listeners.values()) {
      listener.onEnvironmentOffered(offer);
    }
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
          this.ephemeral.delete(environmentId);
          for (const bundle of entry.bundles) {
            this.ephemeral.delete(bundle.bundleHash);
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
        this.ephemeral.delete(environmentId);
        for (const bundle of entry.bundles) {
          this.ephemeral.delete(bundle.bundleHash);
        }
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
