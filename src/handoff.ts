import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

export class HandoffError extends Error {}

const FORBIDDEN_OUTPUT_NAMES = new Set(["meta.json", "journal.jsonl", ".active"]);

/**
 * Sandbox a relative handoff path under runDir. Rejects absolute, ~, and ..
 */
export function resolveHandoffPath(runDir: string, relative: string): string {
  const rel = relative.trim().replace(/\\/g, "/");
  if (!rel) throw new HandoffError("Handoff path is empty");
  if (rel.startsWith("/") || rel.startsWith("~/") || rel === "~") {
    throw new HandoffError(
      `Handoff path '${relative}' must be relative to the run directory`,
    );
  }
  if (rel.split("/").includes("..")) {
    throw new HandoffError(`Handoff path '${relative}' must not contain '..'`);
  }
  const abs = resolve(runDir, rel);
  const root = resolve(runDir) + sep;
  const norm = normalize(abs);
  if (norm !== resolve(runDir) && !norm.startsWith(root)) {
    throw new HandoffError(`Handoff path escapes run directory: ${relative}`);
  }
  return abs;
}

export function assertOutputName(name: string): string {
  const n = name.trim().replace(/\\/g, "/");
  if (!n) throw new HandoffError("output= is required for async spawn");
  const base = n.split("/").pop() ?? n;
  if (FORBIDDEN_OUTPUT_NAMES.has(base)) {
    throw new HandoffError(`output= cannot be reserved name '${base}'`);
  }
  return n;
}

export function parseReadsList(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ensureOutputFile(absPath: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  if (!existsSync(absPath)) {
    writeFileSync(absPath, "");
  }
}

export function expandHandoffTemplates(
  task: string,
  outputs: Record<string, string>,
  previous?: string,
): string {
  let out = task;
  if (previous != null) {
    out = out.replaceAll("{previous}", previous);
  }
  for (const [name, text] of Object.entries(outputs)) {
    out = out.replaceAll(`{outputs.${name}}`, text);
  }
  return out;
}

export function buildHandoffKick(opts: {
  task: string;
  runDir: string;
  reads: string[];
  output?: string;
  laneBlock?: string;
}): string {
  const lines = [
    opts.task.trim(),
    "",
    "## Handoff",
    `Run directory: ${opts.runDir}`,
  ];
  if (opts.reads.length) {
    lines.push("", "Read these files first (relative to the run directory):");
    for (const r of opts.reads) lines.push(`- ${r}`);
  }
  if (opts.output) {
    lines.push(
      "",
      `Write your final deliverable to: ${opts.output}`,
      "(Create/overwrite that file; keep the chat reply short.)",
    );
  }
  if (opts.laneBlock) lines.push(opts.laneBlock);
  return lines.join("\n");
}

export function jobSessionPath(runDir: string, jobId: string): string {
  return join(runDir, "sessions", `${jobId}.jsonl`);
}

export function ensureJobSessionFile(runDir: string, jobId: string): string {
  const path = jobSessionPath(runDir, jobId);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");
  return path;
}
