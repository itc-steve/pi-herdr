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
  /** Atomic do-pool pick (parallel spawns). */
  claimDoPick?: (
    catalog: CatalogEntry[],
    localModel: string,
    localInUse: number,
    localMax: number,
    localEnabled: boolean,
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

/** do pool = local model (head, when enabled) + extra do[] models. */
export function doCatalog(config: HerdConfig): CatalogEntry[] {
  const pool: CatalogEntry[] = [];
  if (config.local.enabled) {
    pool.push({ model: config.local.model, thinking: config.local.thinking });
  }
  for (const e of config.do) pool.push(e);
  return pool;
}

export type DoPickCaps = {
  localModel: string;
  localInUse: number;
  localMax: number;
  /** Local seat accounting only applies when local is actually enabled. */
  localEnabled: boolean;
  load: (model: string) => number;
};

/**
 * Local-first do pool pick. While a local seat remains (local enabled and
 * localInUse < localMax) the local head is always taken, no matter where the
 * cursor points. Only when local is at cap (or disabled) does the cursor
 * rotate through the entries; extras cap at THINK_PER_MODEL (shared with
 * think, never double a cloud subscription). All at cap with local enabled →
 * queue a local seat; otherwise queue the origin entry.
 */
export function pickDoEntry(
  catalog: CatalogEntry[],
  caps: DoPickCaps,
  startIndex = 0,
): { entry: CatalogEntry; queued: boolean; nextStart: number } {
  if (catalog.length === 0) {
    throw new Error(
      "No do models available. Enable local or add do[] in ~/.pi/agent/herd.json.",
    );
  }
  const atCap = (m: string) =>
    caps.localEnabled && m === caps.localModel
      ? caps.localInUse >= caps.localMax
      : caps.load(m) >= THINK_PER_MODEL;

  // Local-first: a free local seat beats any free extra (cursor ignored).
  if (
    caps.localEnabled &&
    catalog[0]!.model === caps.localModel &&
    caps.localInUse < caps.localMax
  ) {
    return { entry: catalog[0]!, queued: false, nextStart: startIndex };
  }

  // Local at cap (or disabled): rotate from the cursor; the local entry is
  // skipped via atCap when it is at cap.
  const n = catalog.length;
  const origin = ((startIndex % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const idx = (origin + i) % n;
    const e = catalog[idx]!;
    if (!atCap(e.model)) {
      return { entry: e, queued: false, nextStart: (idx + 1) % n };
    }
  }
  // All at cap: queue a local seat (never a cloud extra — the job would wait
  // on the wrong queue even after a local seat frees). Else queue the origin.
  if (caps.localEnabled) {
    return { entry: catalog[0]!, queued: true, nextStart: startIndex };
  }
  return { entry: catalog[origin]!, queued: true, nextStart: origin };
}

function doResolved(
  entry: CatalogEntry,
  thinking: string | undefined,
  queued: boolean,
  extraReason?: string,
): ResolvedModel {
  const reason = queued
    ? `do pool full → queue ${entry.model}`
    : `do ${entry.model}`;
  return {
    model: entry.model,
    thinking: thinking?.trim() || entry.thinking,
    local: false,
    role: "do",
    reason: extraReason ? `${extraReason}; ${reason}` : reason,
  };
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
    const fromDo = config.do.find((e) => e.model === model);
    const thinking =
      opts.thinking?.trim() ||
      (local
        ? config.local.thinking
        : fromThink?.thinking ?? fromDo?.thinking) ||
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
    if (config.do.length === 0) {
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
    const picked = pickDoEntry(doCatalog(config), {
      localModel: config.local.model,
      localInUse,
      localMax: max,
      localEnabled: config.local.enabled,
      load: opts.modelInUse ?? (() => 0),
    });
    if (picked.entry.model === config.local.model && config.local.enabled) {
      return localResolved(
        config,
        opts.thinking,
        `${shimNote}${
          picked.queued
            ? "do pool full → queue local"
            : `do ${picked.entry.model}`
        } (streams ${localInUse}/${max})`,
      );
    }
    return doResolved(picked.entry, opts.thinking, picked.queued, shim);
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
 * do → local head; overflow to do[] extras when local seats are full; queue a
 *      local seat when everything is full (never onto think[]).
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

  // role === "do" (think returned above).
  if (config.do.length === 0) {
      return claimLocalSeat(
        config,
        opts.jobId,
        opts.thinking,
        localLock,
        signal,
        `${shimNote}role=do local`,
      );
    }
    const pool = doCatalog(config);
    const picked = opts.claimDoPick
      ? opts.claimDoPick(
          pool,
          config.local.model,
          localLock.inUse(),
          max,
          config.local.enabled,
          opts.jobId,
        )
      : pickDoEntry(pool, {
          localModel: config.local.model,
          localInUse: localLock.inUse(),
          localMax: max,
          localEnabled: config.local.enabled,
          load: opts.modelInUse ?? (() => 0),
        });
    // Queued + local enabled always means pickDoEntry returned the local entry
    // (all pools at cap) → take the local seat queue, never a cloud extra.
    const isLocalPick =
      config.local.enabled &&
      (picked.entry.model === config.local.model || picked.queued);
    if (isLocalPick) {
      return claimLocalSeat(
        config,
        opts.jobId,
        opts.thinking,
        localLock,
        signal,
        `${shimNote}${
          picked.queued ? "do pool full → queue local" : "do pool local"
        }`,
      );
    }
    return {
      resolved: doResolved(picked.entry, opts.thinking, picked.queued, shim),
      localHeld: false,
    };
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
    `private: ${config.private.enabled ? "on" : "off"}`,
  ];
  if (config.do.length) {
    lines.push(
      "", "do extras (1 at a time per model; bare role=do prefers local and takes these only when local seats are full):",
    );
    for (const e of config.do) lines.push(`  ${e.model}:${e.thinking}`);
  }
  lines.push("", "think (1 at a time per model; next think rotates):");
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
