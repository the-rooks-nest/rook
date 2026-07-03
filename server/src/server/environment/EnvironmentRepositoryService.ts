import crypto from "node:crypto";
import path from "node:path";
import type { EnvironmentBundleResult, EnvironmentBundle } from "../../shared/environmentRepository.js";
import type { EnvironmentPreview } from "../../shared/environment.js";
import { EnvironmentRepository } from "./EnvironmentRepository.js";

export interface ResolvedEnvironmentBundle {
  bundle: EnvironmentBundle;
  bundleHash: string;
}

export class EnvironmentRepositoryService {
  constructor(private readonly repository: EnvironmentRepository) {}

  async getBundles(environmentId: string): Promise<EnvironmentBundleResult> {
    return this.repository.getBundles(environmentId);
  }

  async getResolvedBundles(environmentId: string): Promise<ResolvedEnvironmentBundle[]> {
    const result = await this.repository.getBundles(environmentId);
    return result.bundles
      .filter((bundle) => bundle.valid)
      .map((bundle) => ({ bundle, bundleHash: hashBundle(bundle) }));
  }

  async getValidBundles(environmentId: string): Promise<EnvironmentBundle[]> {
    return (await this.getResolvedBundles(environmentId)).map(({ bundle }) => bundle);
  }

  async getBundleCollectionPaths(environmentId: string): Promise<string[]> {
    const bundles = (await this.getResolvedBundles(environmentId)).map(({ bundle }) => bundle);
    return unique(
      bundles
        .map((bundle) => bundle.bundlePath)
        .filter((bundlePath): bundlePath is string => Boolean(bundlePath))
        .map((bundlePath) => path.dirname(bundlePath)),
    );
  }

  async getEnvironmentPreview(environmentId: string): Promise<EnvironmentPreview> {
    const result = await this.repository.getBundles(environmentId);
    return {
      environmentId,
      bundles: result.bundles.map((bundle) => ({
        id: bundle.id,
        bundleId: bundle.bundleId,
        environmentId: bundle.environmentId,
        repository: bundle.repository,
        valid: bundle.valid,
        bundleHash: hashBundle(bundle),
        skills: bundle.skills,
        mcpServers: bundle.mcpServers,
        apps: bundle.apps,
        errors: bundle.errors,
      })),
    };
  }

  async getBundleInspection(environmentId: string): Promise<EnvironmentBundle[]> {
    const result = await this.repository.getBundles(environmentId);
    return result.bundles;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function hashBundle(bundle: EnvironmentBundle): string {
  const hash = crypto.createHash("sha256");
  hash.update("rook-environment-bundle-v1\n");
  for (const [groupName, artifacts] of [
    ["skills", bundle.skills],
    ["mcp-servers", bundle.mcpServers],
    ["apps", bundle.apps],
  ] as const) {
    hash.update(`${groupName}\n`);
    for (const artifact of [...artifacts].sort((a, b) => a.id.localeCompare(b.id))) {
      hash.update(`${artifact.id}\n`);
      for (const filePath of Object.keys(artifact.files).sort((a, b) => a.localeCompare(b))) {
        hash.update(`${filePath}\n`);
        hash.update(artifact.files[filePath]);
        hash.update("\n\u0000\n");
      }
    }
  }
  return hash.digest("hex");
}
