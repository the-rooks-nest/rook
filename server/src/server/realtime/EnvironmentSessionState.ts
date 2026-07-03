import {
  ENVIRONMENT_OFFER_AVAILABLE_KIND,
  ENVIRONMENT_OFFER_RESOLVED_KIND,
} from "../../shared/environment.js";
import type { AcpSessionUpdateNotification } from "../../shared/acp.js";
import type { AcpOutboundMessage, EnvironmentEventPayload } from "../../shared/realtime.js";
import type { EnvironmentBundleOffer, EnvironmentResolution } from "../environment/types.js";
import type { RuntimeRebuilder, RoomRuntime } from "./SessionRoom.js";

export class EnvironmentSessionState {
  private baseSkillPaths: string[] = [];
  private readonly environmentSkillPaths = new Map<string, string[]>();
  private readonly pendingEnvironmentOffers = new Map<string, EnvironmentBundleOffer>();
  private rebuildRuntime: RuntimeRebuilder | null = null;

  configureRuntime(baseSkillPaths: string[], rebuild: RuntimeRebuilder): void {
    if (this.rebuildRuntime) return;
    this.baseSkillPaths = baseSkillPaths;
    this.rebuildRuntime = rebuild;
  }

  offer(offer: EnvironmentBundleOffer): EnvironmentEventPayload {
    this.pendingEnvironmentOffers.set(offer.bundleHash, offer);
    return {
      kind: ENVIRONMENT_OFFER_AVAILABLE_KIND,
      payload: offer,
    };
  }

  resolve(environmentId: string, bundleId: string, bundleHash: string, resolution: EnvironmentResolution): EnvironmentEventPayload {
    this.pendingEnvironmentOffers.delete(bundleHash);
    return {
      kind: ENVIRONMENT_OFFER_RESOLVED_KIND,
      payload: { environmentId, bundleId, bundleHash, decision: resolution },
    };
  }

  enter(environmentId: string, skillPaths: string[]): boolean {
    this.environmentSkillPaths.set(environmentId, skillPaths);
    return true;
  }

  exit(environmentId: string): boolean {
    return this.environmentSkillPaths.delete(environmentId);
  }

  hasRuntimeRebuilder(): boolean {
    return this.rebuildRuntime !== null;
  }

  async rebuild(skillPaths: string[]): Promise<RoomRuntime> {
    if (!this.rebuildRuntime) throw new Error("Environment runtime is not configured.");
    return this.rebuildRuntime(skillPaths);
  }

  currentSkillPaths(): string[] {
    return [...new Set([...this.baseSkillPaths, ...[...this.environmentSkillPaths.values()].flat()])];
  }

  pendingOfferMessages(sessionId: string): AcpOutboundMessage[] {
    return [...this.pendingEnvironmentOffers.values()].map((offer) => {
      const message: AcpSessionUpdateNotification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "_rookery_environment_event",
            kind: ENVIRONMENT_OFFER_AVAILABLE_KIND,
            payload: offer,
          },
        },
      };
      return { type: "acp_message", message };
    });
  }
}
