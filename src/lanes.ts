/**
 * Exclusive write lanes for parallel implementers.
 * Soft enforcement via kick text; hard rejection when owns= sets overlap in-flight.
 *
 * Multi-writer jobs require disjoint owns= (launcher plans lanes in plan.md).
 */

export class LaneError extends Error {}

/** Normalize a project-relative path for comparison (posix-ish, no leading ./). */
export function normalizeLanePath(raw: string): string {
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) {
    throw new LaneError("Empty path in owns=/forbid=");
  }
  if (p.startsWith("/") || p.startsWith("~/") || p === "~") {
    throw new LaneError(
      `Lane path '${raw}' must be project-relative (no absolute or '~/').`,
    );
  }
  const parts = p.split("/");
  if (parts.includes("..")) {
    throw new LaneError(`Lane path '${raw}' must not contain '..'.`);
  }
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  if (!p) {
    throw new LaneError(`Lane path '${raw}' resolved empty.`);
  }
  return p;
}

export function parsePathList(raw?: string | string[]): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw)
    ? raw
    : raw.split(",").map((s) => s.trim());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!part.trim()) continue;
    const n = normalizeLanePath(part);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b + "/")) return true;
  if (b.startsWith(a + "/")) return true;
  return false;
}

export function findOverlappingPath(
  candidate: string[],
  held: string[],
): { a: string; b: string } | null {
  for (const a of candidate) {
    for (const b of held) {
      if (pathsOverlap(a, b)) return { a, b };
    }
  }
  return null;
}

export type LaneClaim = {
  key: string;
  owns: string[];
};

/**
 * Reject when candidate owns overlaps any in-flight claim
 * (or overlaps its own forbid list).
 *
 * Multi-writer rule: if there is already an in-flight owns= claim and this
 * spawn also has owns=, both must be non-overlapping. Spawns without owns=
 * are treated as non-writers (research/chat) and do not claim lanes.
 */
export function assertLaneAvailable(opts: {
  key: string;
  owns: string[];
  forbid?: string[];
  inFlight: LaneClaim[];
}): void {
  const owns = opts.owns;
  const forbid = opts.forbid ?? [];

  if (owns.length === 0) {
    const writers = opts.inFlight.filter((c) => c.owns.length > 0);
    // Non-writer alongside writers is OK.
    void writers;
    return;
  }

  const selfConflict = findOverlappingPath(owns, forbid);
  if (selfConflict) {
    throw new LaneError(
      `owns= path '${selfConflict.a}' overlaps forbid= '${selfConflict.b}'. ` +
        `Remove it from one list.`,
    );
  }

  for (const claim of opts.inFlight) {
    if (claim.key === opts.key) continue;
    if (!claim.owns.length) continue;
    const hit = findOverlappingPath(owns, claim.owns);
    if (hit) {
      throw new LaneError(
        `Write-lane conflict: '${opts.key}' owns '${hit.a}' overlaps ` +
          `'${claim.key}' owns '${hit.b}'. ` +
          `Partition disjoint owns= sets in plan.md Parallel lanes (or serialize).`,
      );
    }
  }
}

/**
 * When another writer is already in flight, a new writer must declare owns=.
 */
export function assertMultiWriterOwns(opts: {
  owns: string[];
  inFlight: LaneClaim[];
}): void {
  const writersFlying = opts.inFlight.some((c) => c.owns.length > 0);
  if (!writersFlying) return;
  if (opts.owns.length > 0) return;
  throw new LaneError(
    `A repo writer is already in flight. New writers must pass disjoint owns= ` +
      `(and usually forbid=). Plan Parallel lanes in plan.md first.`,
  );
}

export function formatLaneKickBlock(opts: {
  owns: string[];
  forbid: string[];
}): string {
  const lines = [
    "",
    "## Exclusive write lane (hard constraint)",
    "You are one parallel worker. Stay in your lane:",
    "- ONLY create/edit/delete files under **Owns** below (plus your handoff `output=` file if set).",
    "- Do NOT modify **Forbid** paths or shared roots (package.json, lockfiles, tsconfig, main entrypoints) unless listed in Owns.",
    "- Do NOT fix stubs or neighboring modules outside Owns — leave them for their owner.",
    "- If you need a change outside Owns, stop and write that need in your handoff output; do not edit it.",
  ];

  if (opts.owns.length) {
    lines.push("", "**Owns** (exclusive write set):");
    for (const p of opts.owns) lines.push(`- ${p}`);
  }
  if (opts.forbid.length) {
    lines.push("", "**Forbid** (do not modify):");
    for (const p of opts.forbid) lines.push(`- ${p}`);
  }

  return lines.join("\n");
}
