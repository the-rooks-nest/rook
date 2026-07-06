import type { EnvironmentBundle, BundleArtifact, RepositoryReadError } from "./environmentRepository.js";

export interface BundleArtifactPreview extends BundleArtifact {}

export interface EnvironmentBundlePreview extends Pick<EnvironmentBundle, "id" | "bundleId" | "environmentId" | "repository" | "valid"> {
  bundleHash: string;
  skills: BundleArtifactPreview[];
  mcpServers: BundleArtifactPreview[];
  apps: BundleArtifactPreview[];
  errors: RepositoryReadError[];
}

export interface EnvironmentPreview {
  environmentId: string;
  bundles: EnvironmentBundlePreview[];
}

/**
 * The 2×2 decision model:
 * - "approve" = permanently approve (persists in SQLite, survives restarts)
 * - "accept"  = approve for this session (in-memory, cleared on exit/expiry)
 * - "ignore"  = reject for this session (in-memory, cleared on exit/expiry)
 * - "reject"  = permanently reject (persists in SQLite, survives restarts)
 */
export type EnvironmentDecision = "accept" | "approve" | "ignore" | "reject";

export const ENVIRONMENT_OFFER_AVAILABLE_KIND = "environment_offer_available";
export const ENVIRONMENT_OFFER_RESOLVED_KIND = "environment_offer_resolved";
export const ENVIRONMENT_ENTERED_KIND = "environment_entered";
export const ENVIRONMENT_EXITED_KIND = "environment_exited";

export interface EnvironmentOfferAvailablePayload {
  environmentId: string;
  bundleId: string;
  bundleHash: string;
  sourceName?: string;
  canonicalSourceUrl?: string;
  skills: string[];
  mcpServers: string[];
  apps: string[];
}

export interface EnvironmentOfferResolvedPayload {
  environmentId: string;
  bundleId: string;
  bundleHash: string;
  decision: "approved" | "dismissed" | "unavailable";
}

export interface EnvironmentLifecyclePayload {
  environmentId: string;
}

/** Source of a location identification request. */
export type IdentifySource = "visit" | "region" | "manual";

/**
 * Phone -> server payload for identifying which `loc:` environments are
 * likely available at the user's current location (issue #42, phase 1).
 */
export interface IdentifyAvailableRequest {
  latitude: number;
  longitude: number;
  horizontalAccuracy?: number;
  source?: IdentifySource;
  dwellSeconds?: number;
  isStationary?: boolean;
  speedMetersPerSecond?: number;
  observedAt?: string;
}

/** A ranked candidate environment near the requested coordinate. */
export interface EnvironmentCandidate {
  /** Stable URL-like id, e.g. `loc:target.com/tn-37000-1-main-st` or `loc:target.com`. */
  environmentId: string;
  displayName: string;
  operator?: string;
  /** Optional store/branch number metadata (provider value or parsed from the website). */
  storeNumber?: string;
  address?: string;
  /** Business coordinate — the path from the loc: id back to a location. */
  latitude?: number;
  longitude?: number;
  /** Business website, when available (lets the agent reach its link metadata). */
  website?: string;
  distanceMeters?: number;
  /** Rough 0..1 confidence for MVP. */
  confidence: number;
  matchReasons: string[];
  /** Whether the environment repository already knows this environment. */
  hasKnownEnvironment: boolean;
  /** Placeholder skill suggestions from the mocked building->skills system. */
  possibleSkills?: string[];
}

export interface IdentifyAvailableResponse {
  candidates: EnvironmentCandidate[];
}
