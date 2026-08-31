import type { CatalogEntry, HerdConfig, ResolvedModel, Role } from "./types.ts";
import { resolveRole } from "./config.ts";
import type { LocalStreamLock } from "./local-lock.ts";

export type ResolveModelOpts = {
  role?: string;
  /** One-release shim for easy|medium|hard. */
  difficulty?: string;
  /** Exact provider/model id — always allowed. */
  model?: string;
  thinking?: string;
  /** How many local streams are currently held. */
  localInUse?: number;
  /** In-flight count per exact model string (think ranking). */
  modelInUse?: (model: string) => number;
  maxModelConcurrent?: number;
  /** Atomic least-loaded think pick (parallel spawns). */
  claimThinkPick?: (
    catalog: CatalogEntry[],
    max: number,
    jobId: string,
  ) => { entry: CatalogEntry; queued: boolean };
};

function isLocalModel(config: HerdConfig, model: string): boolean {
  return config.local.enabled && model === config.local.model;
}

function localResolved(
  config: HerdConfig,
  thinking: string | undefined,
  reason: string,
): ResolvedModel {
  return {
    model: config.local.model,
    thinking: thinking?.trim() || config.local.thinking,
    local: true,
    role: "do",
    reason,
  };
}

/** One in-flight job per think model — don't double a cloud subscription. */
export const THINK_PER_MODEL = 1;

/**
 * Rotate through think[] from startIndex. Skip models at `max` (default 1).
 * All full → queue the startIndex entry. nextStart advances on a real pick
 * so a later think (second opinion) gets the other model even if the first is idle.
 */
export function pickThinkEntry(
  catalog: CatalogEntry[],
  load: (model: string) => number,
  max = THINK_PER_MODEL,
  startIndex = 0,
): { entry: CatalogEntry; queued: boolean; nextStart: number } {
  if (catalog.length === 0) {
    throw new Error(
      "No think models configured. Add think[] in ~/.pi/agent/herd.json.",
    );
  }
  const n = catalog.length;
  const origin = ((startIndex % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const idx = (origin + i) % n;
    const e = catalog[idx]!;
    if (load(e.model) < max) {
      return { entry: e, queued: false, nextStart: (idx + 1) % n };
    }
  }
  return { entry: catalog[origin]!, queued: true, nextStart: origin };
}

function thinkResolved(
  entry: CatalogEntry,
  thinking: string | undefined,
  queued: boolean,
  extraReason?: string,
): ResolvedModel {
  const reason = queued
    ? `think catalog full → queue ${entry.model}`
    : `think ${entry.model}`;
  return {
    model: entry.model,
    thinking: thinking?.trim() || entry.thinking,
    local: false,
    role: "think",
    reason: extraReason ? `${extraReason}; ${reason}` : reason,
  };
}

function pickThink(
  config: HerdConfig,
  thinking: string | undefined,
  modelInUse: ((model: string) => number) | undefined,
  max: number,
  extraReason?: string,
): ResolvedModel {
  const picked = pickThinkEntry(
    config.think,
    modelInUse ?? (() => 0),
    THINK_PER_MODEL,
  );
  return thinkResolved(picked.entry, thinking, picked.queued, extraReason);
}

/**
 * Snapshot resolve (no lock). Local-full + exact local model throws.
 * Parallel spawns must call {@link resolveModelClaimingLocal}.
 */
export function resolveModel(
  config: HerdConfig,
  opts: ResolveModelOpts,
): ResolvedModel {
  const { role, shim } = resolveRole({
    role: opts.role,
    difficulty: opts.difficulty,
  });
  const localInUse = opts.localInUse ?? 0;
  const max = opts.maxModelConcurrent ?? config.maxModelConcurrent;
  const shimNote = shim ? `${shim}; ` : "";

  if (opts.model?.trim()) {
    const model = opts.model.trim();
    const local = isLocalModel(config, model);
    const fromThink = config.think.find((e) => e.model === model);
    const thinking =
      opts.thinking?.trim() ||
      (local ? config.local.thinking : fromThink?.thinking) ||
      "medium";
    if (local && localInUse >= max) {
      throw new Error(
        `Local model '${model}' requested but local streams full ` +
          `(${localInUse}/${max}). Wait, or omit model= for role=think.`,
      );
    }
    return {
      model,
      thinking,
      local,
      role: local ? "do" : role,
      reason: local
        ? `${shimNote}exact model= (local)`
        : `${shimNote}exact model=`,
    };
  }

  if (role === "do") {
    if (!config.local.enabled) {
      throw new Error(
        "Local is disabled. Pass role=think or enable local in ~/.pi/agent/herd.json.",
      );
    }
    if (localInUse >= max) {
      throw new Error(
        `Local streams full (${localInUse}/${max}). Spawn queues a seat; ` +
          `do not overflow onto think.`,
      );
    }
    return localResolved(
      config,
      opts.thinking,
      `${shimNote}role=do local (streams ${localInUse}/${max})`,
    );
  }

  return pickThink(config, opts.thinking, opts.modelInUse, max, shim);
}

async function claimLocalSeat(
  config: HerdConfig,
  jobId: string,
  thinking: string | undefined,
  localLock: LocalStreamLock,
  signal: AbortSignal | undefined,
  reason: string,
): Promise<{ resolved: ResolvedModel; localHeld: boolean }> {
  if (!config.local.enabled) {
    throw new Error(
      "Local is disabled. Pass role=think or enable local in ~/.pi/agent/herd.json.",
    );
  }
  if (localLock.tryAcquire(jobId)) {
    return {
      resolved: localResolved(config, thinking, reason),
      localHeld: true,
    };
  }
  await localLock.acquire(jobId, signal);
  return {
    resolved: localResolved(config, thinking, `${reason} (queued seat)`),
    localHeld: true,
  };
}

/**
 * Resolve a model and atomically claim a local stream when needed.
 *
 * do → always local, queue if full (never overflow onto think).
 * think → one per catalog model; rotate so a second think is the other model.
 */
export async function resolveModelClaimingLocal(
  config: HerdConfig,
  opts: ResolveModelOpts & { jobId: string },
  localLock: LocalStreamLock,
  signal?: AbortSignal,
): Promise<{ resolved: ResolvedModel; localHeld: boolean }> {
  const { role, shim } = resolveRole({
    role: opts.role,
    difficulty: opts.difficulty,
  });
  const shimNote = shim ? `${shim}; ` : "";
  const modelForced = opts.model?.trim();
  const max = opts.maxModelConcurrent ?? config.maxModelConcurrent;

  if (modelForced) {
    if (isLocalModel(config, modelForced)) {
      return claimLocalSeat(
        config,
        opts.jobId,
        opts.thinking,
        localLock,
        signal,
        `${shimNote}exact model= (local)`,
      );
    }
    const resolved = resolveModel(config, {
      role,
      difficulty: opts.difficulty,
      model: modelForced,
      thinking: opts.thinking,
      localInUse: localLock.inUse(),
      modelInUse: opts.modelInUse,
      maxModelConcurrent: max,
    });
    return { resolved, localHeld: false };
  }

  if (role === "think") {
    if (opts.claimThinkPick) {
      const picked = opts.claimThinkPick(
        config.think,
        THINK_PER_MODEL,
        opts.jobId,
      );
      return {
        resolved: thinkResolved(picked.entry, opts.thinking, picked.queued, shim),
        localHeld: false,
      };
    }
    const resolved = pickThink(
      config,
      opts.thinking,
      opts.modelInUse,
      max,
      shim,
    );
    return { resolved, localHeld: false };
  }

  return claimLocalSeat(
    config,
    opts.jobId,
    opts.thinking,
    localLock,
    signal,
    `${shimNote}role=do local`,
  );
}

export function formatModelsList(
  config: HerdConfig,
  localInUse: number,
  localQueued = 0,
): string {
  const lines: string[] = [
    "herd models",
    `local: ${config.local.enabled ? "enabled" : "disabled"} ` +
      `${config.local.model}:${config.local.thinking} ` +
      `seats ${localInUse}/${config.maxModelConcurrent}` +
      (localQueued ? ` queued ${localQueued}` : "") +
      " [local]",
    `maxModelConcurrent: ${config.maxModelConcurrent} (local seats + per provider/model)`,
    `resultDelivery: ${config.defaults.resultDelivery} ` +
      `triggerTurnOnResult: ${config.defaults.triggerTurnOnResult}`,
    "",
    "think (1 at a time per model; next think rotates):",
  ];
  if (!config.think.length) {
    lines.push("  (empty)");
  } else {
    for (const e of config.think) {
      lines.push(`  ${e.model}:${e.thinking}`);
    }
  }
  return lines.join("\n");
}

export type { Role };
