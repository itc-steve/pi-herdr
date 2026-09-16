import type { HerdActionParams } from "./actions.ts";

export const HERD_SLASH_HELP = `herd — Pi subagent herd (default-local, optional think)

  /herd help
  /herd models
  /herd status
  /herd run create name=<slug> [goal="…"]
  /herd run list
  /herd run use <id>
  /herd run show <id>
  /herd journal
  /herd spawn task="…" output=file.md [role=think] [model=…] [owns=…] [private=true]

Roles:
  (omit) / do — local implementer (default)
  think       — ranked frontier catalog (review / plan / VERIFY)

Rules:
  - role is optional; missing = local do
  - async spawn requires output=
  - multi-writer needs disjoint owns= (plan Parallel lanes first)
  - private=true forces local do (secret-dependent ops; needs "private": { "enabled": true })
  - use herdr tool to view/focus panes — not to assign jobs
`;

export class HerdSlashHelpError extends Error {}

export function parseHerdSlashArgs(args: string): HerdActionParams {
  const raw = args.trim();
  if (!raw || raw === "help" || raw === "-h" || raw === "--help") {
    throw new HerdSlashHelpError("help");
  }

  const tokens = tokenize(raw);
  const head = tokens.shift()?.toLowerCase();
  if (!head) throw new HerdSlashHelpError("help");

  if (head === "models" || head === "status" || head === "journal") {
    return { action: head };
  }

  if (head === "run") {
    const runAction = (tokens.shift() || "list").toLowerCase();
    const params: HerdActionParams = { action: "run", runAction };
    Object.assign(params, parseKv(tokens));
    if (!params.name && !params.run && tokens[0] && !tokens[0].includes("=")) {
      params.run = tokens[0];
      params.name = tokens[0];
    }
    return params;
  }

  if (head === "spawn") {
    const params: HerdActionParams = { action: "spawn" };
    Object.assign(params, parseKv(tokens));
    if (!params.task) {
      // leftover free text as task
      const free = tokens.filter((t) => !t.includes("=")).join(" ").trim();
      if (free) params.task = free;
    }
    return params;
  }

  if (
    head === "steer" ||
    head === "abort" ||
    head === "wait" ||
    head === "collect" ||
    head === "reset" ||
    head === "close"
  ) {
    const params: HerdActionParams = { action: head };
    Object.assign(params, parseKv(tokens));
    return params;
  }

  throw new Error(`Unknown /herd subcommand '${head}'. Try /herd help`);
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseKv(tokens: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    if (val === "true") out[key] = true;
    else if (val === "false") out[key] = false;
    else out[key] = val;
  }
  return out;
}

/** Pi SelectList requires AutocompleteItem objects — bare strings crash visibleWidth. */
export type HerdSlashCompletion = {
  value: string;
  label: string;
  description?: string;
};

function items(
  entries: Array<string | { value: string; label?: string; description?: string }>,
): HerdSlashCompletion[] {
  return entries.map((e) =>
    typeof e === "string"
      ? { value: e, label: e }
      : { value: e.value, label: e.label ?? e.value, description: e.description },
  );
}

const BASE_SUBCOMMANDS: HerdSlashCompletion[] = items([
  { value: "help", description: "Show usage" },
  { value: "models", description: "Catalog + local stream seats" },
  { value: "status", description: "Active monitors / locks" },
  { value: "run", description: "Handoff folders create|list|use|show" },
  { value: "journal", description: "Completed jobs in active run" },
  { value: "spawn", description: "task= + output= [role=think]" },
  { value: "steer", description: "Nudge a running job" },
  { value: "abort", description: "Cancel job(s)" },
  { value: "wait", description: "Block until job idle" },
  { value: "collect", description: "Read reply/artifact" },
  { value: "reset", description: "Clear tracked job state" },
  { value: "close", description: "Close herd pane(s)" },
]);

/**
 * Argument completions for `/herd …`.
 * Must return `{ value, label }[]` or null — never string[].
 */
export function getHerdSlashCompletions(
  prefix: string,
): HerdSlashCompletion[] | null {
  const p = prefix.trim().toLowerCase();
  if (!p) return BASE_SUBCOMMANDS;

  const parts = p.split(/\s+/);
  const first = parts[0] ?? "";

  if (!p.includes(" ")) {
    const filtered = BASE_SUBCOMMANDS.filter((b) =>
      b.value.startsWith(first),
    );
    return filtered.length > 0 ? filtered : null;
  }

  if (first === "run") {
    const runPrefix = (parts[1] ?? "").toLowerCase();
    const actions = items([
      { value: "create", description: "name=<slug> [goal=…]" },
      { value: "list", description: "List handoff runs" },
      { value: "use", description: "Set active run" },
      { value: "show", description: "Show run paths" },
    ]).filter((a) => !runPrefix || a.value.startsWith(runPrefix));
    return actions.length > 0 ? actions : null;
  }

  if (first === "spawn") {
    return items([
      {
        value: 'task="" output=',
        label: "spawn local do …",
        description: "Default: local implementer",
      },
      {
        value: 'role=think task="" output=',
        label: "spawn think …",
        description: "Ranked frontier review/plan/VERIFY",
      },
      {
        value: 'private=true task="" output=',
        label: "spawn private local …",
        description: "Secret-dependent op; local do only",
      },
    ]);
  }

  return null;
}
