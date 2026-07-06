#!/usr/bin/env -S node --experimental-sqlite
/**
 * Dump the environment_decisions table to the terminal.
 *
 * Run from repo root:
 *
 *   node scripts/dump-environment-decisions.ts
 *   ./scripts/dump-environment-decisions.sh
 *
 * Or via npm (from the server package):
 *
 *   cd server && npm run env:dump
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

// Resolve REPO_ROOT the same way the server does (walk up from this script).
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

const dbPath = path.join(repoRoot, ".var", "rook", "environment-decisions.sqlite");

if (!existsSync(dbPath)) {
  console.log("No environment decisions database found at:");
  console.log(`  ${dbPath}`);
  process.exit(0);
}

const db = new DatabaseSync(dbPath);

type Row = {
  bundle_hash: string;
  environment_id: string;
  bundle_id: string | null;
  decision: string;
  updated_at: string;
};

const rows = db.prepare(
  "SELECT bundle_hash, environment_id, bundle_id, decision, updated_at FROM environment_decisions ORDER BY updated_at DESC",
).all() as Row[];

db.close();

if (rows.length === 0) {
  console.log("environment_decisions table is empty.");
  process.exit(0);
}

// Column widths
const hashW = Math.max(12, ...rows.map((r) => r.bundle_hash.length));
const envW = Math.max(14, ...rows.map((r) => r.environment_id.length));
const bundleW = Math.max(9, ...rows.map((r) => (r.bundle_id ?? "(none)").length));
const decW = 8;
const timeW = 20;

const pad = (s: string, w: number) => s.padEnd(w);

// Header
console.log();
console.log(
  `${pad("bundle_hash", hashW)}  ${pad("environment_id", envW)}  ${pad("bundle_id", bundleW)}  ${pad("decision", decW)}  ${pad("updated_at", timeW)}`,
);
console.log(
  `${"─".repeat(hashW)}  ${"─".repeat(envW)}  ${"─".repeat(bundleW)}  ${"─".repeat(decW)}  ${"─".repeat(timeW)}`,
);

for (const row of rows) {
  // Truncate the hash for readability (show first 16 chars).
  const shortHash = row.bundle_hash.length > 16
    ? row.bundle_hash.slice(0, 16) + "…"
    : row.bundle_hash;
  console.log(
    `${pad(shortHash, hashW)}  ${pad(row.environment_id, envW)}  ${pad(row.bundle_id ?? "(none)", bundleW)}  ${pad(row.decision, decW)}  ${pad(row.updated_at.replace("T", " ").slice(0, 19), timeW)}`,
  );
}

console.log(`\n${rows.length} row${rows.length === 1 ? "" : "s"}.`);
console.log(`Database: ${dbPath}`);
