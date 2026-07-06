import type { EnvironmentDecision } from "../../shared/environment.js";

export type { EnvironmentDecision };

export interface EnvironmentRecord {
  id: string;
  metadata: Record<string, unknown>;
}

/**
 * Permanently approve / permanently reject — durable decisions stored in SQLite,
 * survive restarts and environment expiry.
 */
export type PermanentDecision = "approve" | "reject";

/**
 * Approve for session / reject for session — scoped to one session's current
 * environment visit. Stored in memory only, cleared when the session exits the
 * environment or the environment expires.
 */
export type SessionDecision = "accept" | "ignore";

/** Effective decision for a bundle hash from a session's perspective, or "undecided". */
export type EffectiveDecision = EnvironmentDecision | "undecided";

/** How an offer was closed — used to dismiss prompts across every client of a room. */
export type EnvironmentResolution = "approved" | "dismissed" | "unavailable";

export interface EnvironmentOfferInfo {
  sourceName?: string;
  canonicalSourceUrl?: string;
}

export interface EnvironmentBundleOffer extends EnvironmentOfferInfo {
  environmentId: string;
  bundleId: string;
  bundleHash: string;
  skills: string[];
  mcpServers: string[];
  apps: string[];
}

/**
 * A subscribed SessionRoom's hooks into environment lifecycle. The EnvironmentManager
 * pushes these; the room turns them into runtime changes and client broadcasts.
 */
export interface EnvironmentEventListener {
  /** An undecided bundle the user should review (prompt in UI). */
  onEnvironmentOffered(offer: EnvironmentBundleOffer): void;
  /** Skills to load for this environment (approved/permanently-approved bundles only).
   * `contextText` (when present) is ambient context pushed into the agent on enter. */
  onEnvironmentEntered(environmentId: string, skillPaths: string[], contextText?: string): void;
  /** Env left or was turned negative: remove skills (restart when idle). */
  onEnvironmentExited(environmentId: string): void;
  /** An offer was resolved (by any client, or because the env left): close prompts. */
  onEnvironmentResolved(environmentId: string, bundleId: string, bundleHash: string, resolution: EnvironmentResolution): void;
}
