import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalEntry } from "./types.ts";

export function journalPath(runDir: string): string {
  return join(runDir, "journal.jsonl");
}

export function readJournal(runDir: string): JournalEntry[] {
  const path = journalPath(runDir);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as JournalEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

export function appendJournal(runDir: string, entry: Omit<JournalEntry, "idx">): JournalEntry {
  const existing = readJournal(runDir);
  const full: JournalEntry = { ...entry, idx: existing.length };
  appendFileSync(journalPath(runDir), `${JSON.stringify(full)}\n`);
  return full;
}

/** Soft resume helper — list completed ok job ids for the parent to skip. */
export function completedJobIds(runDir: string): string[] {
  return readJournal(runDir)
    .filter((e) => e.status === "ok")
    .map((e) => e.jobId);
}
