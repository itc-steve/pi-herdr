import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCompetingPackages } from "../src/conflict.ts";
import { COMPETING_PACKAGE_NAMES } from "../src/config.ts";

describe("conflict scan", () => {
  it("knows competing package names", () => {
    assert.ok(COMPETING_PACKAGE_NAMES.some((n) => n.includes("pi-custom-herdr")));
    assert.ok(COMPETING_PACKAGE_NAMES.some((n) => n.includes("ogulcancelik")));
  });

  it("detects competitor in project settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herd-conf-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const settings = join(cwd, ".pi", "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        packages: ["npm:@ogulcancelik/pi-herdr"],
      }),
    );
    const hits = findCompetingPackages(cwd, [settings]);
    assert.ok(hits.length >= 1);
  });

  it("ignores clean settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herd-conf-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const settings = join(cwd, ".pi", "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({ packages: ["./pi-herdr"] }),
    );
    const hits = findCompetingPackages(cwd, [settings]);
    assert.equal(hits.length, 0);
  });
});
