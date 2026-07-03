import type { EnvironmentEventPayload } from "../../shared/realtime.js";
import {
  ENVIRONMENT_ENTERED_KIND,
  ENVIRONMENT_EXITED_KIND,
} from "../../shared/environment.js";
import type { JsonRpcFailure, JsonRpcSuccess } from "../../shared/acp.js";
import type { EnvironmentBundleOffer, EnvironmentEventListener, EnvironmentResolution } from "../environment/types.js";
import type { BaseAgent } from "../agents/BaseAgent.js";
import type { AgentSessionRecord } from "../agents/sessionLog.js";
import { EnvironmentSessionState } from "./EnvironmentSessionState.js";
import { RoomEventStream, type RoomSubscriber } from "./RoomEventStream.js";

/** Builds a fresh runtime for this session with the given skill paths (used for env restarts). */
export type RuntimeRebuilder = (skillPaths: string[]) => Promise<RoomRuntime>;

export type { RoomSubscriber };

export interface RoomRuntime {
  session: AgentSessionRecord;
  agentId: string;
  agent: BaseAgent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logEnvironmentEvent(sessionId: string, event: string, environmentId: string, extra: Record<string, unknown> = {}): void {
  console.log(`[environment] session=${sessionId} event=${event} environment=${environmentId}${Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ""}`);
}

function stoppedError(): Error {
  return new Error("Session room stopped.");
}

export class SessionRoom implements EnvironmentEventListener {
  private readonly events: RoomEventStream;
  private readonly environmentState = new EnvironmentSessionState();
  /** Ambient context (e.g. current location) per entered environment, pushed to the agent. */
  private readonly environmentContext = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private started = false;
  private startPromise: Promise<void> | null = null;

  constructor(
    readonly sessionId: string,
    private currentRuntime: RoomRuntime,
    private readonly options: { idleTimeoutMs?: number; onIdle?: () => Promise<void> | void } = {},
  ) {
    this.events = new RoomEventStream(sessionId);
    this.scheduleIdleStop();
  }

  get agentId(): string {
    return this.currentRuntime.agentId;
  }

  get session(): AgentSessionRecord {
    return this.currentRuntime.session;
  }

  get runtime(): RoomRuntime {
    return this.currentRuntime;
  }

  get subscriberCount(): number {
    return this.events.subscriberCount;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  setRuntime(runtime: RoomRuntime): void {
    this.currentRuntime = runtime;
  }

  attachRuntimeEventSink(): void {
    this.currentRuntime.agent.setAcpEventSink((notification) => {
      void this.events.publishAcpUpdate(notification);
    });
    this.currentRuntime.agent.setAcpPermissionRequestSink((request) => {
      void this.events.publishAcpRequest(request);
    });
  }

  configureEnvironmentRuntime(baseSkillPaths: string[], rebuild: RuntimeRebuilder): void {
    this.environmentState.configureRuntime(baseSkillPaths, rebuild);
  }

  onEnvironmentOffered(offer: EnvironmentBundleOffer): void {
    logEnvironmentEvent(this.sessionId, "offered", offer.environmentId, {
      bundleId: offer.bundleId,
      bundleHash: offer.bundleHash,
      sourceName: offer.sourceName,
      canonicalSourceUrl: offer.canonicalSourceUrl,
    });
    void this.broadcastEnvironmentEvent(this.environmentState.offer(offer));
  }

  onEnvironmentResolved(environmentId: string, bundleId: string, bundleHash: string, resolution: EnvironmentResolution): void {
    logEnvironmentEvent(this.sessionId, "resolved", environmentId, { bundleId, bundleHash, resolution });
    void this.broadcastEnvironmentEvent(this.environmentState.resolve(environmentId, bundleId, bundleHash, resolution));
  }

  onEnvironmentEntered(environmentId: string, skillPaths: string[], contextText?: string): void {
    logEnvironmentEvent(this.sessionId, "entered", environmentId, { skillPathCount: skillPaths.length, hasContext: Boolean(contextText) });
    if (contextText) this.environmentContext.set(environmentId, contextText);
    else this.environmentContext.delete(environmentId);
    this.environmentState.enter(environmentId, skillPaths);
    this.scheduleRuntimeRebuild(ENVIRONMENT_ENTERED_KIND, environmentId, true);
  }

  onEnvironmentExited(environmentId: string): void {
    this.environmentContext.delete(environmentId);
    if (!this.environmentState.exit(environmentId)) return;
    logEnvironmentEvent(this.sessionId, "exited", environmentId);
    this.scheduleRuntimeRebuild(ENVIRONMENT_EXITED_KIND, environmentId, false);
  }

  /** Compose the ambient context from all entered environments (null when none). */
  private currentLocationContext(): string | null {
    if (this.environmentContext.size === 0) return null;
    return [...this.environmentContext.values()].join("\n\n");
  }

  private scheduleRuntimeRebuild(kind: string, environmentId: string, interruptActiveRun: boolean): void {
    if (!this.environmentState.hasRuntimeRebuilder()) return;
    if (interruptActiveRun) {
      const pendingCancel = this.currentRuntime.agent.cancel?.();
      if (pendingCancel) void pendingCancel.catch(() => {});
    }
    const rebuild = async () => {
      if (this.stopped || !this.environmentState.hasRuntimeRebuilder()) return;
      try {
        const previousAgent = this.currentRuntime.agent;
        const nextRuntime = await this.environmentState.rebuild(this.environmentState.currentSkillPaths());
        await previousAgent.stop();
        this.setRuntime(nextRuntime);
        nextRuntime.agent.setContextEntry("location", this.currentLocationContext());
        this.attachRuntimeEventSink();
        this.started = true;
        await this.broadcastEnvironmentEvent({ kind, payload: { environmentId } });
      } catch (error) {
        await this.broadcastEnvironmentEvent({
          kind: ENVIRONMENT_EXITED_KIND,
          payload: { environmentId, error: error instanceof Error ? error.message : String(error) },
        });
      }
    };
    this.queue = this.queue.then(rebuild, rebuild);
  }

  subscribe(subscriber: RoomSubscriber): () => void {
    this.cancelIdleStop();
    const unsubscribe = this.events.subscribe(subscriber);
    this.emitPendingEnvironmentOffers(subscriber);
    return () => this.removeSubscriber(unsubscribe);
  }

  async ensureStarted(): Promise<void> {
    if (this.stopped) throw stoppedError();
    if (this.started) return;
    if (!this.startPromise) {
      this.startPromise = this.currentRuntime.agent.ensureStarted()
        .then(() => {
          if (this.stopped) throw stoppedError();
          this.started = true;
        })
        .finally(() => {
          this.startPromise = null;
        });
    }
    await this.startPromise;
  }

  async run(message: string): Promise<{ ok: true; stopReason: string } | { ok: false; error: string }> {
    const run = async () => {
      try {
        if (this.stopped) throw stoppedError();
        await this.ensureStarted();
        if (this.stopped) throw stoppedError();
        await this.currentRuntime.agent.run(message);
        return { ok: true, stopReason: this.currentRuntime.agent.lastStopReason ?? "end_turn" } as const;
      } catch (error) {
        const errorMsg = errorMessage(error);
        void this.events.publishAcpUpdate({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.sessionId,
            update: { sessionUpdate: "_rookery_run_failed", error: errorMsg },
          },
        } as never);
        return { ok: false, error: errorMsg } as const;
      }
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.then(() => undefined, () => undefined);
    return await pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelIdleStop();
    await this.currentRuntime.agent.stop();
  }

  async cancel(): Promise<void> {
    if (this.stopped) throw stoppedError();
    await this.currentRuntime.agent.cancel();
  }

  async sendSteeringMessage(message: string): Promise<void> {
    if (this.stopped) throw stoppedError();
    await this.ensureStarted();
    await this.currentRuntime.agent.sendSteeringMessage(message);
  }

  async setMode(modeId: string): Promise<unknown> {
    if (this.stopped) throw stoppedError();
    await this.ensureStarted();
    return await this.currentRuntime.agent.setMode(modeId);
  }

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    if (this.stopped) throw stoppedError();
    await this.ensureStarted();
    return await this.currentRuntime.agent.setConfigOption(configId, value);
  }

  respondToPermissionRequest(message: JsonRpcSuccess | JsonRpcFailure): void {
    if (this.stopped) return;
    this.currentRuntime.agent.respondToPermissionRequest(message);
  }

  async broadcastEnvironmentEvent(event: EnvironmentEventPayload): Promise<void> {
    await this.events.publishAcpUpdate({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: this.sessionId,
        update: { sessionUpdate: "_rookery_environment_event", kind: event.kind, ...(event.payload !== undefined ? { payload: event.payload } : {}) },
      },
    } as never);
  }

  private emitPendingEnvironmentOffers(subscriber: RoomSubscriber): void {
    for (const message of this.environmentState.pendingOfferMessages(this.sessionId)) {
      subscriber(message);
    }
  }

  private removeSubscriber(unsubscribe: () => void): void {
    unsubscribe();
    if (this.events.subscriberCount === 0) this.scheduleIdleStop();
  }

  private scheduleIdleStop(): void {
    if (this.stopped || this.events.subscriberCount > 0 || this.idleTimer !== null) return;
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 15_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.stopped || this.events.subscriberCount > 0) return;
      void this.options.onIdle?.();
    }, idleTimeoutMs);
  }

  private cancelIdleStop(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
