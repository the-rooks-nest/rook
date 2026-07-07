import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "../paths.js";

export interface EnvironmentMetadataCaptureRecord {
  capturedAt: string;
  environmentId: string;
  sourceName?: string;
  canonicalSourceUrl?: string;
  metadata: Record<string, unknown>;
}

export interface EnvironmentRegistrationCaptureSink {
  initialize(): Promise<void>;
  capture(record: EnvironmentMetadataCaptureRecord): Promise<void>;
}

export const DEFAULT_ENVIRONMENT_METADATA_CAPTURE_DIR = path.join(REPO_ROOT, "IGNORED", "environment_metadata_captures");

export function environmentMetadataCaptureFileName(environmentId: string): string {
  return `${environmentId.replaceAll(":", "-").replaceAll("/", "--").replaceAll("\\", "--")}.jsonl`;
}

export class JsonlEnvironmentMetadataCaptureSink implements EnvironmentRegistrationCaptureSink {
  constructor(private readonly dir = DEFAULT_ENVIRONMENT_METADATA_CAPTURE_DIR) {}

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async capture(record: EnvironmentMetadataCaptureRecord): Promise<void> {
    await this.initialize();
    await appendFile(path.join(this.dir, environmentMetadataCaptureFileName(record.environmentId)), `${JSON.stringify(record)}\n`, "utf8");
  }
}

export class NoopEnvironmentRegistrationCaptureSink implements EnvironmentRegistrationCaptureSink {
  async initialize(): Promise<void> {}
  async capture(_record: EnvironmentMetadataCaptureRecord): Promise<void> {}
}
