import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PersistentDecision } from "./types.js";
import { REPO_ROOT } from "../paths.js";

/**
 * Repository layer for persistent bundle decisions (Approve / Reject).
 *
 * Backed by Node's built-in `node:sqlite`. The service layer never sees SQL — if we
 * later swap in another backend, only this file changes. Ephemeral decisions
 * (Accept / Ignore) are NOT stored here; they live in memory on the EnvironmentManager.
 *
 * The stored key is an opaque decision key. Today that is typically a bundle-content
 * hash, but older callers may still pass environment ids.
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
        environment_id TEXT PRIMARY KEY,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
        updated_at TEXT NOT NULL
      )
    `);
  }

  getDecision(environmentId: string): PersistentDecision | null {
    const row = this.db
      .prepare("SELECT decision FROM environment_decisions WHERE environment_id = ?")
      .get(environmentId) as { decision: PersistentDecision } | undefined;
    return row?.decision ?? null;
  }

  setDecision(environmentId: string, decision: PersistentDecision): void {
    this.db
      .prepare(`
        INSERT INTO environment_decisions (environment_id, decision, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (environment_id) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at
      `)
      .run(environmentId, decision, new Date().toISOString());
  }

  clearDecision(environmentId: string): void {
    this.db.prepare("DELETE FROM environment_decisions WHERE environment_id = ?").run(environmentId);
  }

  close(): void {
    this.db.close();
  }
}
