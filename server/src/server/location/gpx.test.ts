// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGpxPoints } from "./gpx.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-fixtures", "gpx");
const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".gpx"));

describe("parseGpxPoints", () => {
  it("extracts lat/lon from trkpt/wpt/rtept tags (self-closing or with children)", () => {
    const xml = `
      <gpx>
        <trk><trkseg>
          <trkpt lat="35.04974" lon="-89.69605"><ele>110</ele></trkpt>
          <trkpt lat="36.0589" lon="-86.7135"/>
        </trkseg></trk>
        <wpt lat="36.1627" lon="-86.7816"></wpt>
        <rte><rtept lat="25.0" lon="-45.0"/></rte>
      </gpx>`;
    expect(parseGpxPoints(xml)).toEqual([
      { lat: 35.04974, lon: -89.69605 },
      { lat: 36.0589, lon: -86.7135 },
      { lat: 36.1627, lon: -86.7816 },
      { lat: 25.0, lon: -45.0 },
    ]);
  });

  it("tolerates attribute order and whitespace, ignores non-point tags", () => {
    const xml = `<trkpt  lon = "-86.5"  lat="36.5" ><time>x</time></trkpt><name lat="0" lon="0"/>`;
    // <name> is not a point tag -> ignored; lon-before-lat still parses.
    expect(parseGpxPoints(xml)).toEqual([{ lat: 36.5, lon: -86.5 }]);
  });

  it("returns [] for a GPX with no points", () => {
    expect(parseGpxPoints("<gpx><trk><trkseg></trkseg></trk></gpx>")).toEqual([]);
  });
});

describe("parseGpxPoints on real OSM traces (NC/TN fixtures)", () => {
  it("has fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)("parses %s into many southeast-US points", (file) => {
    const points = parseGpxPoints(readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
    expect(points.length).toBeGreaterThan(100);
    for (const p of points) {
      expect(p.lat).toBeGreaterThan(30);
      expect(p.lat).toBeLessThan(37);
      expect(p.lon).toBeGreaterThan(-91);
      expect(p.lon).toBeLessThan(-77);
    }
  });
});
