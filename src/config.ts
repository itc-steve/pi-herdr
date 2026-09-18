import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CatalogEntry,
  HerdConfig,
  HerdDefaults,
  IsolationMode,
  LocalConfig,
  PrivateConfig,
  ResultDelivery,
  Role,
} from "./types.ts";

const DEFAULT_SESSION_DIR = "~/.pi/agent/herd";
const DEFAULT_HERD_PATH = join(homedir(), ".pi", "agent", "herd.json");
const DEFAULT_MAX_MODEL_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_LOCAL_MODEL = "vllm/Qwen/Qwen3.6-27B-FP8";

const DO_ALIASES = new Set(["do"]);
const THINK_ALIASES = new Set([
  "think",
  "review",
  "plan",
  "architect",
  "verify",
]);

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

function normalizeBucket(raw: unknown, bucket: string): CatalogEntry[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`herd.json "${bucket}" must be an array`);
  }
  return raw.map((item, i) => normalizeEntry(item, i, bucket));
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
      : DEFAULT_LOCAL_MODEL;
  const thinking =
    typeof obj.thinking === "string" && obj.thinking.trim()
      ? obj.thinking.trim()
      : "medium";
  return {
    enabled: obj.enabled !== false,
    model,
    thinking,
    preflight: obj.preflight !== false,
  };
}

function normalizePrivate(raw: unknown): PrivateConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
  if (raw != null && obj === undefined) {
    throw new Error('herd.json "private" must be an object');
  }
  const enabled = obj?.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("herd.json private.enabled must be a boolean");
  }
  return { enabled: enabled === true };
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
    triggerTurnOnResult: obj.triggerTurnOnResult !== false,
  };
}

/** Old easy/medium/hard catalogs → think rank (hard, then remote medium, then remote easy). */
function foldThink(
  obj: Record<string, unknown>,
  localModel: string,
): CatalogEntry[] {
  if (obj.think != null) return normalizeBucket(obj.think, "think");
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const name of ["hard", "medium", "easy"] as const) {
    for (const e of normalizeBucket(obj[name], name)) {
      if (e.local === true || e.model === localModel) continue;
      if (seen.has(e.model)) continue;
      seen.add(e.model);
      out.push({ model: e.model, thinking: e.thinking });
    }
  }
  return out;
}

/**
 * Resolve spawn role. Default do (local).
 * One-release shim: difficulty=easy|medium → do, hard → think.
 */
export function resolveRole(opts: {
  role?: string;
  difficulty?: string;
}): { role: Role; shim?: string } {
  const roleRaw = opts.role?.trim().toLowerCase();
  if (roleRaw) {
    if (DO_ALIASES.has(roleRaw)) return { role: "do" };
    if (THINK_ALIASES.has(roleRaw)) return { role: "think" };
    throw new Error(
      `role must be do|think (aliases: review, plan, architect, verify); got '${opts.role}'`,
    );
  }
  const d = opts.difficulty?.trim().toLowerCase();
  if (!d) return { role: "do" };
  if (d === "easy" || d === "medium") {
    return { role: "do", shim: `difficulty=${d} → do` };
  }
  if (d === "hard") return { role: "think", shim: "difficulty=hard → think" };
  throw new Error(
    `difficulty shim accepts easy|medium|hard (got '${opts.difficulty}'). Prefer role=do|think.`,
  );
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
  /** Local model is the implicit do head — drop duplicates from do[]. */
  const doModels = normalizeBucket(obj.do, "do").filter(
    (e) => !(local.enabled && e.model === local.model),
  );
  const think = foldThink(obj, local.model);
  const privateConfig = normalizePrivate(obj.private);

  if (!local.enabled && think.length === 0 && doModels.length === 0) {
    throw new Error(
      "herd.json must enable local or define at least one think or do model",
    );
  }

  return {
    sessionDir,
    sessionPolicy: "per-job",
    maxModelConcurrent,
    local,
    do: doModels,
    think,
    private: privateConfig,
    defaults: normalizeDefaults(obj.defaults),
  };
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
      model: DEFAULT_LOCAL_MODEL,
      thinking: "medium",
      preflight: true,
    },
    think: [
      {
        model: "grok-cli/grok-4.6",
        thinking: "high",
      },
      {
        model: "openai-codex/gpt-5.6-sol",
        thinking: "high",
      },
    ],
    private: { enabled: false },
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
