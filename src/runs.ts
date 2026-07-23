import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expandHome } from "./config.ts";

export type RunMeta = {
  id: string;
  name: string;
  goal?: string;
  createdAt: string;
};

const TEMPLATE_FILES: Record<string, (goal?: string) => string> = {
  "instruction.md": (goal) =>
    `# Instruction\n\n${goal?.trim() || "(goal TBD)"}\n\n## Constraints\n\n- \n\n## Helpful info\n\n- \n`,
  "context.md": () => `# Context\n\n(fill via herd spawn)\n`,
  "plan.md": () =>
    `# Plan\n\n## Approach\n\n- \n\n## Parallel lanes\n\n` +
    `Before multi-writer fan-out, list disjoint owns=/forbid= per job:\n\n` +
    `| Job label | owns= | forbid= |\n|-----------|-------|--------|\n| | | |\n\n`,
  "progress.md": () => `# Progress\n\n- \n`,
};

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "run";
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function runsRoot(sessionDir: string): string {
  return join(expandHome(sessionDir), "runs");
}

export function activePath(sessionDir: string): string {
  return join(runsRoot(sessionDir), ".active");
}

export function createRun(
  sessionDir: string,
  name: string,
  goal?: string,
): { runId: string; runDir: string; meta: RunMeta } {
  const slug = slugify(name);
  const runId = `${todayStamp()}_${slug}`;
  const runDir = join(runsRoot(sessionDir), runId);
  if (existsSync(runDir)) {
    throw new Error(`Run already exists: ${runId}`);
  }
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  mkdirSync(join(runDir, "jobs"), { recursive: true });
  for (const [file, body] of Object.entries(TEMPLATE_FILES)) {
    writeFileSync(join(runDir, file), body(goal));
  }
  const meta: RunMeta = {
    id: runId,
    name: slug,
    goal: goal?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(runDir, "journal.jsonl"), "");
  setActiveRun(sessionDir, runId);
  return { runId, runDir, meta };
}

export function setActiveRun(sessionDir: string, runId: string): void {
  const root = runsRoot(sessionDir);
  mkdirSync(root, { recursive: true });
  const runDir = join(root, runId);
  if (!existsSync(runDir)) {
    throw new Error(`Unknown run '${runId}'`);
  }
  writeFileSync(activePath(sessionDir), `${runId}\n`);
}

export function getActiveRun(sessionDir: string): string | null {
  const p = activePath(sessionDir);
  if (!existsSync(p)) return null;
  const id = readFileSync(p, "utf8").trim();
  if (!id) return null;
  if (!existsSync(join(runsRoot(sessionDir), id))) return null;
  return id;
}

export function listRuns(sessionDir: string): string[] {
  const root = runsRoot(sessionDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort()
    .reverse();
}

export function runDirFor(sessionDir: string, runId: string): string {
  return join(runsRoot(sessionDir), runId);
}

export function requireActiveOrRef(
  sessionDir: string,
  run?: string,
): { runId: string; runDir: string } {
  const runId = run?.trim() || getActiveRun(sessionDir);
  if (!runId) {
    throw new Error(
      "No active run. Create one with herd run create name=… or pass run=",
    );
  }
  // allow bare slug match
  let resolved = runId;
  const dir = runDirFor(sessionDir, resolved);
  if (!existsSync(dir)) {
    const hits = listRuns(sessionDir).filter(
      (id) => id === runId || id.endsWith(`_${runId}`) || id.includes(runId),
    );
    if (hits.length === 1) resolved = hits[0]!;
    else if (hits.length > 1) {
      throw new Error(`Ambiguous run '${runId}': ${hits.join(", ")}`);
    } else {
      throw new Error(`Unknown run '${runId}'`);
    }
  }
  return { runId: resolved, runDir: runDirFor(sessionDir, resolved) };
}

export function formatRunList(sessionDir: string): string {
  const active = getActiveRun(sessionDir);
  const runs = listRuns(sessionDir);
  if (!runs.length) return "No herd runs yet. herd run create name=…";
  const lines = ["herd runs:"];
  for (const id of runs) {
    lines.push(`  ${id === active ? "*" : " "} ${id}`);
  }
  return lines.join("\n");
}

export function formatRunInfo(sessionDir: string, runId: string): string {
  const { runDir } = requireActiveOrRef(sessionDir, runId);
  const metaPath = join(runDir, "meta.json");
  let meta = "";
  if (existsSync(metaPath)) {
    meta = readFileSync(metaPath, "utf8").trim();
  }
  return [`run: ${runId}`, `dir: ${runDir}`, meta ? `meta:\n${meta}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function nextJobId(runDir: string): string {
  const jobsDir = join(runDir, "jobs");
  const sessionsDir = join(runDir, "sessions");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  let n = 1;
  while (true) {
    const id = `j${String(n).padStart(2, "0")}`;
    const jobClaim = join(jobsDir, id);
    const sessionFile = join(sessionsDir, `${id}.jsonl`);
    // Claim dirs were the original intent but never created — also honor
    // existing session files so we never collide on j01 forever.
    if (!existsSync(jobClaim) && !existsSync(sessionFile)) {
      mkdirSync(jobClaim, { recursive: true });
      return id;
    }
    n += 1;
  }
}
