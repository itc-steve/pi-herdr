import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CatalogEntry,
  Difficulty,
  HerdConfig,
  HerdDefaults,
  IsolationMode,
  LocalConfig,
  LocalWhenFull,
  ResultDelivery,
} from "./types.ts";

const DEFAULT_SESSION_DIR = "~/.pi/agent/herd";
const DEFAULT_HERD_PATH = join(homedir(), ".pi", "agent", "herd.json");
const DEFAULT_MAX_MODEL_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 600_000;

/** Competing herdr extensions — refuse to load if found in Pi settings. */
export const COMPETING_PACKAGE_NAMES = [
  "@ogulcancelik/pi-herdr",
  "@weshipwork/pi-herdr",
  "@andrewjacop/pi-herdr",
  "pi-custom-herdr",
  "github0004/pi-custom-herdr",
] as const;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function defaultHerdPath(): string {
  return DEFAULT_HERD_PATH;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isDifficulty(value: string): value is Difficulty {
  return value === "easy" || value === "medium" || value === "hard";
}

function isIsolation(value: unknown): value is IsolationMode {
  return value === "none" || value === "worktree";
}

function normalizeEntry(raw: unknown, index: number, bucket: string): CatalogEntry {
  if (!raw || typeof raw !== "object") {
    throw new Error(`herd.json ${bucket}[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  const thinking = typeof obj.thinking === "string" ? obj.thinking.trim() : "";
  if (!model || !thinking) {
    throw new Error(
      `herd.json ${bucket}[${index}] requires non-empty model and thinking`,
    );
  }
  const entry: CatalogEntry = { model, thinking };
  if (typeof obj.local === "boolean") entry.local = obj.local;
  return entry;
}

function normalizeBucket(raw: unknown, bucket: Difficulty): CatalogEntry[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`herd.json "${bucket}" must be an array`);
  }
  return raw.map((item, i) => normalizeEntry(item, i, bucket));
}

function normalizePreferOn(raw: unknown): Difficulty[] {
  if (!Array.isArray(raw)) return ["easy", "medium"];
  const out: Difficulty[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const d = item.trim().toLowerCase();
    if (isDifficulty(d) && !out.includes(d)) out.push(d);
  }
  return out.length ? out : ["easy", "medium"];
}

function normalizeWhenFull(raw: unknown): LocalWhenFull {
  // Default queue: burn free private local serially; set "overflow" for paid parallel.
  if (raw === "overflow") return "overflow";
  return "queue";
}

function normalizeResultDelivery(raw: unknown): ResultDelivery {
  return raw === "full" ? "full" : "pointer";
}

function normalizeLocal(raw: unknown): LocalConfig {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const model =
    typeof obj.model === "string" && obj.model.trim()
      ? obj.model.trim()
      : "vllm/Qwen/Qwen3.6-27B-FP8";
  const thinking =
    typeof obj.thinking === "string" && obj.thinking.trim()
      ? obj.thinking.trim()
      : "medium";
  let maxStreams = 1;
  if (typeof obj.maxStreams === "number" && obj.maxStreams >= 1) {
    maxStreams = Math.floor(obj.maxStreams);
  }
  return {
    enabled: obj.enabled !== false,
    model,
    thinking,
    maxStreams,
    preflight: obj.preflight !== false,
    preferOn: normalizePreferOn(obj.preferOn),
    whenFull: normalizeWhenFull(obj.whenFull),
  };
}

function normalizeDefaults(raw: unknown): HerdDefaults {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    isolation: isIsolation(obj.isolation) ? obj.isolation : "none",
    timeoutMs:
      typeof obj.timeoutMs === "number" && obj.timeoutMs > 0
        ? Math.floor(obj.timeoutMs)
        : DEFAULT_TIMEOUT_MS,
    waitForReply: obj.waitForReply === true,
    requireOutput: obj.requireOutput !== false,
    resultDelivery: normalizeResultDelivery(obj.resultDelivery),
    // Last-job batch in index triggers one parent turn when true (default).
    triggerTurnOnResult: obj.triggerTurnOnResult !== false,
  };
}

/** Ensure local-tagged entry is first in a bucket (preferOn routing). */
function promoteLocalInBucket(
  bucket: CatalogEntry[],
  local: LocalConfig,
): CatalogEntry[] {
  const localEntry: CatalogEntry = {
    model: local.model,
    thinking: local.thinking,
    local: true,
  };
  const withoutDup = bucket.filter(
    (e) => !(e.local === true && e.model === local.model),
  );
  const idx = withoutDup.findIndex(
    (e) => e.local === true || e.model === local.model,
  );
  if (idx >= 0) {
    const promoted = { ...withoutDup[idx]!, local: true as const };
    return [promoted, ...withoutDup.filter((_, i) => i !== idx)];
  }
  return [localEntry, ...withoutDup];
}

/** Parse a herd.json object into a validated HerdConfig. */
export function parseHerdConfig(raw: unknown): HerdConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("herd.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const sessionDir =
    typeof obj.sessionDir === "string" && obj.sessionDir.trim()
      ? obj.sessionDir.trim()
      : DEFAULT_SESSION_DIR;

  let maxModelConcurrent = DEFAULT_MAX_MODEL_CONCURRENT;
  if (
    typeof obj.maxModelConcurrent === "number" &&
    obj.maxModelConcurrent >= 1
  ) {
    maxModelConcurrent = Math.floor(obj.maxModelConcurrent);
  }

  const local = normalizeLocal(obj.local);
  let easy = normalizeBucket(obj.easy, "easy");
  let medium = normalizeBucket(obj.medium, "medium");
  let hard = normalizeBucket(obj.hard, "hard");

  // Prefer local first on configured difficulties (default easy+medium).
  // hard stays frontier-only unless preferOn explicitly includes it.
  if (local.enabled) {
    if (local.preferOn.includes("easy")) easy = promoteLocalInBucket(easy, local);
    if (local.preferOn.includes("medium")) {
      medium = promoteLocalInBucket(medium, local);
    }
    if (local.preferOn.includes("hard")) hard = promoteLocalInBucket(hard, local);
  }

  if (easy.length === 0 && medium.length === 0 && hard.length === 0) {
    throw new Error(
      "herd.json must define at least one model in easy, medium, or hard",
    );
  }

  return {
    sessionDir,
    sessionPolicy: "per-job",
    maxModelConcurrent,
    local,
    easy,
    medium,
    hard,
    defaults: normalizeDefaults(obj.defaults),
  };
}

export function bucketFor(config: HerdConfig, difficulty: Difficulty): CatalogEntry[] {
  return config[difficulty];
}

export function assertDifficulty(value: string): Difficulty {
  const v = value.trim().toLowerCase();
  if (!isDifficulty(v)) {
    throw new Error(`difficulty must be easy|medium|hard (got '${value}')`);
  }
  return v;
}

export function loadHerdConfig(path = defaultHerdPath()): HerdConfig {
  const abs = expandHome(path);
  if (!existsSync(abs)) {
    return parseHerdConfig(defaultConfigObject());
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${abs}: ${msg}`);
  }
  return parseHerdConfig(raw);
}

/** Ensure config exists on disk (call from models/run/list — not on import). */
export function ensureHerdConfigFile(path = defaultHerdPath()): HerdConfig {
  const abs = expandHome(path);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(defaultConfigObject(), null, 2)}\n`);
  }
  return loadHerdConfig(abs);
}

export function defaultConfigObject(): Record<string, unknown> {
  return {
    sessionDir: DEFAULT_SESSION_DIR,
    maxModelConcurrent: DEFAULT_MAX_MODEL_CONCURRENT,
    local: {
      enabled: true,
      model: "vllm/Qwen/Qwen3.6-27B-FP8",
      thinking: "medium",
      maxStreams: 1,
      preflight: true,
      preferOn: ["easy", "medium"],
      // queue = burn free local GPU serially; overflow = paid remote when local busy
      whenFull: "queue",
    },
    easy: [
      {
        model: "vllm/Qwen/Qwen3.6-27B-FP8",
        thinking: "medium",
        local: true,
      },
      {
        model: "claude-code/claude-sonnet-5",
        thinking: "medium",
      },
    ],
    medium: [
      {
        model: "grok-cli/grok-build",
        thinking: "medium",
      },
    ],
    hard: [
      {
        model: "grok-cli/grok-4.5",
        thinking: "high",
      },
      {
        model: "claude-code/claude-opus-4-8",
        thinking: "high",
      },
    ],
    defaults: {
      isolation: "none",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      waitForReply: false,
      requireOutput: true,
      resultDelivery: "pointer",
      triggerTurnOnResult: true,
    },
  };
}

export function bootCommand(model: string, thinking: string, sessionFile: string): string {
  return `pi --model ${shellQuote(`${model}:${thinking}`)} --session ${shellQuote(sessionFile)}`;
}

export function sessionDirAbs(config: HerdConfig): string {
  return expandHome(config.sessionDir);
}
