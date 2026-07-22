import type { AgentRuntimeProfile } from "../config/agentRuntimes.js";
import type { EnvironmentManager } from "../environment/EnvironmentManager.js";
import type { EnvironmentBundleOffer, EnvironmentEventListener, EnvironmentResolution } from "../environment/types.js";
import type { SessionRecord, SessionRepository } from "../repositories/SessionRepository.js";
import { SessionRuntime, type JsonObject, type JsonRpcMessage, type RuntimeNotification, type SessionRuntimeConfiguration } from "../runtime/SessionRuntime.js";
import { runtimeLaunchPlan, runtimeSessionParams } from "../runtime/runtimeLaunchPlan.js";

/**
 * Owns the configured runtime catalog and lazily creates one isolated
 * `SessionRuntime` per public session. A process is never shared by sessions:
 * environment-specific skills and startup instructions belong to one session.
 */
export class AgentRuntimeManager {
  private readonly profilesById: Map<string, AgentRuntimeProfile>;
  private readonly sessionRuntimes = new Map<string, SessionRuntime>();
  private readonly subscribers = new Map<string, Map<RuntimeNotification, { environmentOffers: boolean }>>();
  private readonly unresolvedOffers = new Map<string, Map<string, EnvironmentBundleOffer>>();
  private readonly runtimeSubscriptions = new Map<string, () => void>();
  private readonly inboundRequestRoutes = new Map<string, SessionRuntime>();
  private readonly environmentSubscriptions = new Set<string>();
  private readonly restoredEnvironmentMembership = new Set<string>();
  private readonly environmentSkillPaths = new Map<string, Map<string, string[]>>();
  private readonly environmentRestartQueues = new Map<string, Promise<void>>();

  constructor(
    profiles: AgentRuntimeProfile[],
    private readonly sessions: SessionRepository,
    private readonly repoRoot: string,
    private readonly environmentManager?: EnvironmentManager,
  ) {
    this.profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  runtimeIds(): string[] {
    return [...this.profilesById.keys()];
  }

  runtimeDefinitions(): Array<Pick<AgentRuntimeProfile, "id" | "type" | "parentId" | "model">> {
    return this.runtimeIds().map((id) => {
      const profile = this.profilesById.get(id)!;
      return {
        id: profile.id,
        type: profile.type,
        ...(profile.parentId !== undefined ? { parentId: profile.parentId } : {}),
        ...(profile.model ? { model: profile.model } : {}),
      };
    });
  }

  defaultRuntimeId(): string | undefined {
    return this.runtimeIds()[0];
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.sessions.list();
  }

  async createSession(runtimeId: string, params: JsonObject, title: string): Promise<SessionRecord> {
    const profile = this.requireProfile(runtimeId);
    const runtime = this.createSessionRuntime(profile);
    const result = await runtime.request("session/new", runtimeSessionParams(profile, params, runtime.configuration));
    const runtimeSessionId = sessionIdFromResult(result);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: crypto.randomUUID(),
      runtimeId,
      runtimeSessionId,
      title,
      cwd: typeof params.cwd === "string" ? params.cwd : this.repoRoot,
      startedAt: now,
      updatedAt: now,
    };
    await this.sessions.save(record);
    this.attachSessionRuntime(record.sessionId, runtime);
    this.subscribeToEnvironments(record.sessionId);
    return record;
  }

  async requestForSession(sessionId: string, method: string, params: JsonObject): Promise<unknown> {
    const record = await this.requireSession(sessionId);
    await this.restoreEnvironmentMembership(record);
    const runtime = this.runtimeFor(record);
    const runtimeParams =
      method === "session/load" || method === "session/resume"
        ? { cwd: record.cwd, mcpServers: [], ...params, sessionId: record.runtimeSessionId }
        : { ...params, sessionId: record.runtimeSessionId };
    const result = await runtime.request(method, runtimeSessionParams(runtime.profile, runtimeParams, runtime.configuration));
    await this.sessions.touch(sessionId);
    return rewriteResultSessionId(record, result);
  }

  async notifyForSession(sessionId: string, method: string, params: JsonObject): Promise<void> {
    const record = await this.requireSession(sessionId);
    await this.restoreEnvironmentMembership(record);
    const runtime = this.runtimeFor(record);
    await runtime.notify(method, { ...params, sessionId: record.runtimeSessionId });
    await this.sessions.touch(sessionId);
  }

  /**
   * Atomically applies session-specific environment launch state. The old
   * process remains usable until a replacement has successfully loaded the
   * exact same ACP session; loading failure never creates a fresh session.
   */
  /** Applies an explicit non-ACP enter/leave request for one session. */
  async applyEnvironmentChange(sessionId: string, enterEnvironmentIds: string[], leaveEnvironmentIds: string[]): Promise<string[]> {
    if (!this.environmentManager) throw new Error("Environment manager is not configured.");
    await this.requireSession(sessionId);
    this.subscribeToEnvironments(sessionId);
    for (const environmentId of leaveEnvironmentIds) this.environmentManager.exitEnvironment(sessionId, environmentId);
    for (const environmentId of enterEnvironmentIds) this.environmentManager.enterEnvironment(sessionId, environmentId);
    await this.environmentRestartQueues.get(sessionId);
    const entered = this.environmentManager.enteredEnvironments(sessionId);
    await this.sessions.replaceEnvironmentIds(sessionId, entered);
    return entered;
  }

  async resolveEnvironmentOffer(sessionId: string, environmentId: string, bundleHash: string, decision: "accept" | "approve" | "ignore" | "reject"): Promise<void> {
    if (!this.environmentManager) throw new Error("Environment manager is not configured.");
    await this.requireSession(sessionId);
    const offer = this.unresolvedOffers.get(sessionId)?.get(bundleHash);
    if (!offer || offer.environmentId !== environmentId) throw new Error("Unknown or resolved environment offer.");
    this.environmentManager.decideEnvironment(environmentId, decision, bundleHash, sessionId);
  }

  async restartSessionForEnvironmentChange(sessionId: string, configuration: SessionRuntimeConfiguration): Promise<void> {
    const record = await this.requireSession(sessionId);
    const current = this.runtimeFor(record);
    const replacement = current.replacement(configuration);
    try {
      const result = await replacement.request(
        "session/load",
        runtimeSessionParams(replacement.profile, { sessionId: record.runtimeSessionId, cwd: record.cwd, mcpServers: [] }, configuration),
      );
      if (typeof result === "object" && result !== null && "sessionId" in result && (result as JsonObject).sessionId !== record.runtimeSessionId) {
        throw new Error("ACP session/load returned a different session ID; refusing to replace session runtime.");
      }
    } catch (error) {
      await replacement.close();
      throw error;
    }

    this.replaceSessionRuntime(sessionId, replacement);
    await current.close();
    await this.sessions.touch(sessionId);
  }

  async closeSession(sessionId: string): Promise<unknown> {
    const record = await this.requireSession(sessionId);
    const runtime = this.runtimeFor(record);
    const result = await runtime.request("session/close", { sessionId: record.runtimeSessionId });
    await runtime.close();
    this.detachSessionRuntime(sessionId);
    await this.sessions.delete(sessionId);
    return result;
  }

  /** Relay a standard ACP response to an ACP request initiated by a runtime. */
  respondToRuntime(message: JsonRpcMessage): boolean {
    const id = message.id;
    if (typeof id !== "string") return false;
    const runtime = this.inboundRequestRoutes.get(id);
    if (!runtime) return false;
    this.inboundRequestRoutes.delete(id);
    runtime.respond({ ...message, id: originalRuntimeRequestId(id) });
    return true;
  }

  subscribe(sessionId: string, listener: RuntimeNotification, options: { environmentOffers?: boolean } = {}): () => void {
    const listeners = this.subscribers.get(sessionId) ?? new Map<RuntimeNotification, { environmentOffers: boolean }>();
    listeners.set(listener, { environmentOffers: options.environmentOffers === true });
    this.subscribers.set(sessionId, listeners);
    if (options.environmentOffers) {
      for (const offer of this.unresolvedOffers.get(sessionId)?.values() ?? []) listener(environmentOfferMessage(sessionId, offer));
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(sessionId);
    };
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.runtimeSubscriptions.values()) unsubscribe();
    this.runtimeSubscriptions.clear();
    await Promise.all([...this.sessionRuntimes.values()].map((runtime) => runtime.close()));
    this.sessionRuntimes.clear();
    this.inboundRequestRoutes.clear();
    if (this.environmentManager) {
      for (const sessionId of this.environmentSubscriptions) this.environmentManager.unsubscribe(sessionId);
    }
    this.environmentSubscriptions.clear();
    this.environmentSkillPaths.clear();
    this.environmentRestartQueues.clear();
    this.restoredEnvironmentMembership.clear();
  }

  private runtimeFor(record: SessionRecord): SessionRuntime {
    const existing = this.sessionRuntimes.get(record.sessionId);
    if (existing) return existing;
    const runtime = this.createSessionRuntime(this.requireProfile(record.runtimeId));
    this.attachSessionRuntime(record.sessionId, runtime);
    this.subscribeToEnvironments(record.sessionId);
    return runtime;
  }

  private createSessionRuntime(profile: AgentRuntimeProfile): SessionRuntime {
    return new SessionRuntime(profile, this.repoRoot, runtimeLaunchPlan);
  }

  private attachSessionRuntime(sessionId: string, runtime: SessionRuntime): void {
    this.sessionRuntimes.set(sessionId, runtime);
    if (this.runtimeSubscriptions.has(sessionId)) return;
    this.runtimeSubscriptions.set(sessionId, runtime.onNotification((message) => {
      let outbound = rewriteMessageSessionId(message, sessionId);
      if (typeof message.id === "string" || typeof message.id === "number") {
        const requestId = publicRuntimeRequestId(sessionId, message.id);
        this.inboundRequestRoutes.set(requestId, runtime);
        outbound = { ...outbound, id: requestId };
      }
      for (const listener of this.subscribers.get(sessionId)?.keys() ?? []) listener(outbound);
    }));
  }

  private replaceSessionRuntime(sessionId: string, replacement: SessionRuntime): void {
    this.runtimeSubscriptions.get(sessionId)?.();
    this.runtimeSubscriptions.delete(sessionId);
    this.sessionRuntimes.set(sessionId, replacement);
    this.attachSessionRuntime(sessionId, replacement);
  }

  private detachSessionRuntime(sessionId: string): void {
    this.runtimeSubscriptions.get(sessionId)?.();
    this.runtimeSubscriptions.delete(sessionId);
    this.sessionRuntimes.delete(sessionId);
    this.subscribers.delete(sessionId);
    if (this.environmentManager && this.environmentSubscriptions.delete(sessionId)) this.environmentManager.unsubscribe(sessionId);
    this.environmentSkillPaths.delete(sessionId);
    this.environmentRestartQueues.delete(sessionId);
    this.restoredEnvironmentMembership.delete(sessionId);
  }

  private subscribeToEnvironments(sessionId: string): void {
    if (!this.environmentManager || this.environmentSubscriptions.has(sessionId)) return;
    this.environmentSubscriptions.add(sessionId);
    const listener: EnvironmentEventListener = {
      onEnvironmentOffered: (offer: EnvironmentBundleOffer) => this.publishEnvironmentOffer(sessionId, offer),
      onEnvironmentResolved: (environmentId: string, bundleId: string, bundleHash: string, resolution: EnvironmentResolution) => this.publishEnvironmentOfferResolution(sessionId, environmentId, bundleId, bundleHash, resolution),
      onEnvironmentEntered: (environmentId, skillPaths) => this.updateEnvironmentState(sessionId, environmentId, skillPaths),
      onEnvironmentExited: (environmentId) => this.removeEnvironmentState(sessionId, environmentId),
    };
    this.environmentManager.subscribe(sessionId, listener);
  }

  private publishEnvironmentOffer(sessionId: string, offer: EnvironmentBundleOffer): void {
    const offers = this.unresolvedOffers.get(sessionId) ?? new Map<string, EnvironmentBundleOffer>();
    offers.set(offer.bundleHash, offer);
    this.unresolvedOffers.set(sessionId, offers);
    for (const [listener, capabilities] of this.subscribers.get(sessionId) ?? []) {
      if (capabilities.environmentOffers) listener(environmentOfferMessage(sessionId, offer));
    }
  }

  private publishEnvironmentOfferResolution(sessionId: string, environmentId: string, bundleId: string, bundleHash: string, resolution: EnvironmentResolution): void {
    this.unresolvedOffers.get(sessionId)?.delete(bundleHash);
    const message: JsonRpcMessage = { jsonrpc: "2.0", method: "_com.rookkeeper/environment_offer_resolved", params: { sessionId, environmentId, bundleId, bundleHash, resolution } };
    for (const [listener, capabilities] of this.subscribers.get(sessionId) ?? []) {
      if (capabilities.environmentOffers) listener(message);
    }
  }

  private async restoreEnvironmentMembership(record: SessionRecord): Promise<void> {
    if (!this.environmentManager || this.restoredEnvironmentMembership.has(record.sessionId)) return;
    this.subscribeToEnvironments(record.sessionId);
    this.restoredEnvironmentMembership.add(record.sessionId);
    for (const environmentId of await this.sessions.environmentIds(record.sessionId)) {
      this.environmentManager.enterEnvironment(record.sessionId, environmentId);
    }
    await this.environmentRestartQueues.get(record.sessionId);
  }

  private updateEnvironmentState(sessionId: string, environmentId: string, skillPaths: string[]): void {
    const paths = this.environmentSkillPaths.get(sessionId) ?? new Map<string, string[]>();
    paths.set(environmentId, skillPaths);
    this.environmentSkillPaths.set(sessionId, paths);
    this.scheduleEnvironmentRestart(sessionId);
  }

  private removeEnvironmentState(sessionId: string, environmentId: string): void {
    this.environmentSkillPaths.get(sessionId)?.delete(environmentId);
    this.scheduleEnvironmentRestart(sessionId);
  }

  private scheduleEnvironmentRestart(sessionId: string): void {
    const restart = async () => {
      const paths = this.environmentSkillPaths.get(sessionId);
      const configuration: SessionRuntimeConfiguration = {
        enteredEnvironmentIds: [...(paths?.keys() ?? [])],
        skillPaths: [...new Set([...(paths?.values() ?? [])].flat())],
        extensionPaths: [],
        appendSystemPrompt: this.environmentManager?.runtimeInstructionsForSession(sessionId),
      };
      await this.restartSessionForEnvironmentChange(sessionId, configuration);
    };
    const previous = this.environmentRestartQueues.get(sessionId) ?? Promise.resolve();
    const queued = previous.then(restart, restart);
    this.environmentRestartQueues.set(sessionId, queued);
  }

  private requireProfile(runtimeId: string): AgentRuntimeProfile {
    const profile = this.profilesById.get(runtimeId);
    if (!profile) throw new Error(`Unknown configured runtime: ${runtimeId}`);
    return profile;
  }

  private async requireSession(sessionId: string): Promise<SessionRecord> {
    const record = await this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    return record;
  }
}

function sessionIdFromResult(value: unknown): string {
  if (typeof value !== "object" || value === null || typeof (value as JsonObject).sessionId !== "string") {
    throw new Error("ACP session/new did not return a sessionId.");
  }
  return (value as JsonObject).sessionId as string;
}

function rewriteResultSessionId(record: SessionRecord, result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const value = result as JsonObject;
  return value.sessionId === record.runtimeSessionId ? { ...value, sessionId: record.sessionId } : result;
}

function publicRuntimeRequestId(sessionId: string, requestId: string | number): string {
  return `rook-runtime-request:${encodeURIComponent(sessionId)}:${encodeURIComponent(String(requestId))}`;
}

function originalRuntimeRequestId(publicId: string): string | number {
  const value = publicId.split(":").slice(2).join(":");
  const decoded = decodeURIComponent(value);
  return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
}

function environmentOfferMessage(sessionId: string, offer: EnvironmentBundleOffer): JsonRpcMessage {
  return { jsonrpc: "2.0", method: "_com.rookkeeper/environment_offer", params: { sessionId, ...offer } };
}

function rewriteMessageSessionId(message: JsonRpcMessage, sessionId: string): JsonRpcMessage {
  const params = message.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return message;
  return { ...message, params: { ...(params as JsonObject), sessionId } };
}
