import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PermanentDecision } from "./types.js";
import { REPO_ROOT } from "../paths.js";

/**
 * Repository layer for persistent bundle decisions (Approve / Reject).
 *
 * Backed by Node's built-in `node:sqlite`. The service layer never sees SQL — if we
 * later swap in another backend, only this file changes. Ephemeral decisions
 * (Accept / Ignore) are NOT stored here; they live in memory on the EnvironmentManager.
 *
 * The stored key is a bundle-content hash. Each row also records which
 * environment and bundle the decision was made for, for auditability.
 */
export class EnvironmentDecisionStore {
  private readonly db: DatabaseSync;

  /**
   * @param location filesystem path to the SQLite file, or ":memory:" for tests.
   * Defaults to a gitignored runtime location under `.var`.
   */
  constructor(location?: string) {
    const filename = location ?? path.join(REPO_ROOT, ".var", "rook", "environment-decisions.sqlite");
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS environment_decisions (
        bundle_hash TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        bundle_id TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
        updated_at TEXT NOT NULL
      )
    `);
  }

  getDecision(bundleHash: string): PermanentDecision | null {
    const row = this.db
      .prepare("SELECT decision FROM environment_decisions WHERE bundle_hash = ?")
      .get(bundleHash) as { decision: PermanentDecision } | undefined;
    return row?.decision ?? null;
  }

  setDecision(bundleHash: string, environmentId: string, bundleId: string | null, decision: PermanentDecision): void {
    this.db
      .prepare(`
        INSERT INTO environment_decisions (bundle_hash, environment_id, bundle_id, decision, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (bundle_hash) DO UPDATE SET environment_id = excluded.environment_id, bundle_id = excluded.bundle_id, decision = excluded.decision, updated_at = excluded.updated_at
      `)
      .run(bundleHash, environmentId, bundleId, decision, new Date().toISOString());
  }

  clearDecision(bundleHash: string): void {
    this.db.prepare("DELETE FROM environment_decisions WHERE bundle_hash = ?").run(bundleHash);
  }

  close(): void {
    this.db.close();
  }
}
