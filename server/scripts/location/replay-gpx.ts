/**
 * Replay a GPX route against the running server's location-identify endpoint.
 *
 * CLVisit (the on-device trigger) can't fire in the simulator, so this exercises
 * the whole server pipeline (identify -> locationKey -> restrictToPlace ->
 * LocationRegistrar -> context skill) by POSTing each trackpoint directly.
 *
 * Usage (server must be running, e.g. `npm run dev`):
 *   npm run replay:gpx -- <file.gpx> [baseUrl] [stride]
 * `stride` replays every Nth trackpoint (default 1) — useful for dense GPS traces
 * (e.g. a Garmin run logs a point per second).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGpxPoints } from "../../src/server/location/gpx.js";
import { REPO_ROOT } from "../../src/server/paths.js";

const CONTEXT_SKILL = path.join(REPO_ROOT, ".var", "agent-station", "location-context", "location-context", "SKILL.md");

async function currentContextName(): Promise<string | null> {
  try {
    const md = await readFile(CONTEXT_SKILL, "utf8");
    return /^### (.+)$/m.exec(md.split("## Current business")[1] ?? md)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const gpxPath = process.argv[2];
  const baseUrl = process.argv[3] ?? "http://127.0.0.1:7665";
  const stride = Math.max(1, Number(process.argv[4] ?? 1) || 1);
  if (!gpxPath) {
    console.error("usage: npm run replay:gpx -- <file.gpx> [baseUrl] [stride]");
    process.exit(1);
  }

  const all = parseGpxPoints(await readFile(gpxPath, "utf8"));
  const points = stride > 1 ? all.filter((_, i) => i % stride === 0) : all;
  console.log(`Replaying ${points.length} of ${all.length} point(s) (stride ${stride}) against ${baseUrl}\n`);

  let prevTopId: string | undefined;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const coord = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    let candidates: Array<{ environmentId: string; displayName: string; storeNumber?: string }> = [];
    try {
      const resp = await fetch(`${baseUrl}/api/environments/register-location`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ latitude: p.lat, longitude: p.lon, isStationary: true, source: "visit" }),
      });
      candidates = ((await resp.json()) as { candidates?: typeof candidates }).candidates ?? [];
    } catch (error) {
      console.log(`[${i}] ${coord} -> ERROR ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const top = candidates[0];
    const changed = top?.environmentId !== prevTopId ? "   << changed" : "";
    prevTopId = top?.environmentId;

    if (!top) {
      console.log(`[${i}] ${coord} -> (no candidates)${changed}`);
      continue;
    }
    const store = top.bestGuessStoreNumber ? ` store-${top.bestGuessStoreNumber}` : "";
    console.log(`[${i}] ${coord} -> ${top.displayName} (${top.environmentId})${store}${changed}`);
    const nearby = candidates.slice(1).map((c) => c.displayName);
    if (nearby.length) {
      console.log(`      nearby(${nearby.length}): ${nearby.slice(0, 6).join(", ")}${nearby.length > 6 ? ", …" : ""}`);
    }
    const ctx = await currentContextName();
    if (ctx) console.log(`      context skill current: ${ctx}`);
  }
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  void main();
}
