import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMPETING_PACKAGE_NAMES } from "./config.ts";

export class CompetingPackageError extends Error {}

function settingsPaths(cwd = process.cwd()): string[] {
  return [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
}

function collectPackageStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPackageStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectPackageStrings(v, out);
    }
  }
}

/**
 * Scan Pi settings for known competing herdr packages.
 * Our package name is `pi-herdr` — competitors are listed in COMPETING_PACKAGE_NAMES.
 *
 * @param cwd project cwd for `.pi/settings.json`
 * @param extraPaths optional absolute settings paths (tests); when set, replaces defaults
 */
export function findCompetingPackages(
  cwd = process.cwd(),
  extraPaths?: string[],
): string[] {
  const found = new Set<string>();
  const paths = extraPaths ?? settingsPaths(cwd);
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const pkgs: string[] = [];
    collectPackageStrings(raw, pkgs);
    for (const pkg of pkgs) {
      const lower = pkg.toLowerCase();
      for (const name of COMPETING_PACKAGE_NAMES) {
        if (lower.includes(name.toLowerCase())) {
          found.add(`${name} (via ${pkg})`);
        }
      }
    }
  }
  return [...found];
}

export function assertNoCompetingPackages(cwd = process.cwd()): void {
  const hits = findCompetingPackages(cwd);
  if (!hits.length) return;
  throw new CompetingPackageError(
    `pi-herdr refuses to load: competing herdr package(s) in Pi settings:\n` +
      hits.map((h) => `  - ${h}`).join("\n") +
      `\nRemove them (pi remove … / edit settings) then /reload. ` +
      `This package vendors the herdr tool — duplicates confuse the launcher.`,
  );
}
