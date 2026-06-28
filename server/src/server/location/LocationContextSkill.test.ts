// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvironmentCandidate } from "../../shared/environment.js";
import { renderLocationContextSkill, writeLocationContextSkill } from "./LocationContextSkill.js";

function candidate(over: Partial<EnvironmentCandidate>): EnvironmentCandidate {
  return {
    environmentId: "loc:x.com/tn-1-main",
    displayName: "X",
    confidence: 0.9,
    matchReasons: ["inside_building"],
    hasKnownEnvironment: false,
    ...over,
  };
}

const current = candidate({
  environmentId: "loc:cicis.com/tn-37211-5705-nolensville-pike",
  displayName: "Cicis",
  operator: "Cicis",
  address: "5705 Nolensville Pike",
  website: "https://www.cicis.com/locations/tn-nashville",
  latitude: 36.06,
  longitude: -86.7,
});
const neighbor = candidate({ environmentId: "loc:gamestop.com/tn-37211-5705", displayName: "GameStop", operator: "GameStop", address: "5705 Nolensville Pike Ste 2" });

describe("location context skill", () => {
  it("puts the current env id in frontmatter and lists current + nearby metadata", () => {
    const md = renderLocationContextSkill(current, [neighbor]);
    expect(md).toContain("environment: loc:cicis.com/tn-37211-5705-nolensville-pike");
    expect(md).toContain("### Cicis");
    expect(md).toContain("https://www.cicis.com/locations/tn-nashville");
    expect(md).toContain("36.06, -86.7");
    expect(md).toContain("Nearby in this building");
    expect(md).toContain("### GameStop");
  });

  it("omits the nearby section when there are no neighbors", () => {
    expect(renderLocationContextSkill(current, [])).not.toContain("Nearby in this building");
  });

  it("writes a SKILL.md bundle and returns its dir", () => {
    const dir = writeLocationContextSkill(current, [neighbor]);
    const contents = readFileSync(path.join(dir, "SKILL.md"), "utf8");
    expect(contents).toContain("name: location-context");
    expect(contents).toContain("### GameStop");
  });
});
