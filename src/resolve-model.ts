import type { Difficulty, HerdConfig, ResolvedModel } from "./types.ts";
import { assertDifficulty, bucketFor } from "./config.ts";
import type { LocalStreamLock } from "./local-lock.ts";

export type ResolveModelOpts = {
  difficulty: string;
  /** Exact provider/model id — always allowed; still requires difficulty. */
  model?: string;
  thinking?: string;
  /** How many local streams are currently held. */
  localInUse?: number;
};

/**
 * Resolve which model/thinking to boot for a spawn.
 *
 * Rules:
 * - difficulty required
 * - model= always allowed (override)
 * - walk bucket; skip local entries when streams exhausted
 * - local busy + whenFull=overflow → next non-local in same bucket
 * - local is promoted into preferOn difficulties by parseHerdConfig
 *
 * NOTE: localInUse is a snapshot. Parallel spawns must call
 * {@link resolveModelClaimingLocal} so only maxStreams jobs actually take the GPU.
 */
export function resolveModel(
  config: HerdConfig,
  opts: ResolveModelOpts,
): ResolvedModel {
  const difficulty = assertDifficulty(opts.difficulty);
  const localInUse = opts.localInUse ?? 0;
  const maxStreams = config.local.maxStreams;

  if (opts.model?.trim()) {
    const model = opts.model.trim();
    const fromBucket = findInBuckets(config, model);
    const local =
      fromBucket?.local === true ||
      (config.local.enabled && model === config.local.model);
    const thinking =
      opts.thinking?.trim() ||
      fromBucket?.thinking ||
      (local ? config.local.thinking : "medium");

    if (local && localInUse >= maxStreams) {
      throw new Error(
        `Local model '${model}' requested but local streams full ` +
          `(${localInUse}/${maxStreams}). Pick a non-local model, wait, or omit model= ` +
          `so difficulty=${difficulty} can fall through the bucket.`,
      );
    }

    return {
      model,
      thinking,
      local,
      difficulty,
      reason: local
        ? `exact model= (local) with difficulty=${difficulty}`
        : `exact model= with difficulty=${difficulty}`,
    };
  }

  const bucket = bucketFor(config, difficulty);
  if (bucket.length === 0) {
    throw new Error(
      `No models configured for difficulty=${difficulty}. Edit ~/.pi/agent/herd.json.`,
    );
  }

  for (const entry of bucket) {
    const isLocal =
      entry.local === true ||
      (config.local.enabled && entry.model === config.local.model);
    if (isLocal) {
      if (!config.local.enabled) continue;
      if (localInUse >= maxStreams) continue;
      return {
        model: entry.model,
        thinking: opts.thinking?.trim() || entry.thinking,
        local: true,
        difficulty,
        reason: `difficulty=${difficulty} preferred local (streams ${localInUse}/${maxStreams})`,
      };
    }
    return {
      model: entry.model,
      thinking: opts.thinking?.trim() || entry.thinking,
      local: false,
      difficulty,
      reason:
        localInUse >= maxStreams
          ? `difficulty=${difficulty}; local busy → next catalog model`
          : `difficulty=${difficulty} bucket order`,
    };
  }

  throw new Error(
    `No available model for difficulty=${difficulty} ` +
      `(local streams ${localInUse}/${maxStreams}).`,
  );
}

function isLocalModel(config: HerdConfig, model: string): boolean {
  if (config.local.enabled && model === config.local.model) return true;
  return findInBuckets(config, model)?.local === true;
}

function localResolved(
  config: HerdConfig,
  difficulty: Difficulty,
  thinking: string | undefined,
  reason: string,
): ResolvedModel {
  return {
    model: config.local.model,
    thinking: thinking?.trim() || config.local.thinking,
    local: true,
    difficulty,
    reason,
  };
}

async function claimLocalSeat(
  config: HerdConfig,
  difficulty: Difficulty,
  jobId: string,
  thinking: string | undefined,
  localLock: LocalStreamLock,
  signal: AbortSignal | undefined,
  reason: string,
): Promise<{ resolved: ResolvedModel; localHeld: boolean }> {
  if (localLock.tryAcquire(jobId)) {
    return {
      resolved: localResolved(config, difficulty, thinking, reason),
      localHeld: true,
    };
  }
  await localLock.acquire(jobId, signal);
  return {
    resolved: localResolved(
      config,
      difficulty,
      thinking,
      `difficulty=${difficulty} preferred local (queued seat)`,
    ),
    localHeld: true,
  };
}

/**
 * Resolve a model and atomically claim a local stream when needed.
 *
 * Order matters for whenFull=queue: we must claim/wait the local seat
 * *before* resolveModel walks past local because streams look full.
 *
 * 1. model= non-local → resolve, no seat
 * 2. model= local → claim or queue for seat
 * 3. preferOn difficulty + local enabled → claim local if free;
 *    whenFull=queue → wait; whenFull=overflow → remote catalog
 * 4. else → normal bucket resolve (local only if free in snapshot)
 */
export async function resolveModelClaimingLocal(
  config: HerdConfig,
  opts: ResolveModelOpts & { jobId: string },
  localLock: LocalStreamLock,
  signal?: AbortSignal,
): Promise<{ resolved: ResolvedModel; localHeld: boolean }> {
  const difficulty = assertDifficulty(opts.difficulty);
  const modelForced = opts.model?.trim();

  if (modelForced) {
    if (isLocalModel(config, modelForced)) {
      return claimLocalSeat(
        config,
        difficulty,
        opts.jobId,
        opts.thinking,
        localLock,
        signal,
        `exact model= (local) with difficulty=${difficulty}`,
      );
    }
    const resolved = resolveModel(config, {
      difficulty,
      model: modelForced,
      thinking: opts.thinking,
      localInUse: localLock.inUse(),
    });
    return { resolved, localHeld: false };
  }

  const preferLocal =
    config.local.enabled && config.local.preferOn.includes(difficulty);

  if (preferLocal) {
    if (localLock.tryAcquire(opts.jobId)) {
      return {
        resolved: localResolved(
          config,
          difficulty,
          opts.thinking,
          `difficulty=${difficulty} preferred local (streams ${localLock.inUse() - 1}/${localLock.maxStreamsCount()})`,
        ),
        localHeld: true,
      };
    }

    if (config.local.whenFull === "queue") {
      await localLock.acquire(opts.jobId, signal);
      return {
        resolved: localResolved(
          config,
          difficulty,
          opts.thinking,
          `difficulty=${difficulty} preferred local (queued seat)`,
        ),
        localHeld: true,
      };
    }

    // overflow: remote catalog with local treated as full
    const resolved = resolveModel(config, {
      difficulty,
      thinking: opts.thinking,
      localInUse: localLock.maxStreamsCount(),
    });
    if (resolved.local) {
      throw new Error(
        `Local streams full (${localLock.inUse()}/${localLock.maxStreamsCount()}) ` +
          `and no non-local model for difficulty=${difficulty}. ` +
          `Add a remote model in ~/.pi/agent/herd.json, set local.whenFull=queue, or wait.`,
      );
    }
    return { resolved, localHeld: false };
  }

  // Difficulty not in preferOn — normal bucket walk (may still hit a local tag).
  let resolved = resolveModel(config, {
    difficulty,
    thinking: opts.thinking,
    localInUse: localLock.inUse(),
  });
  if (!resolved.local) {
    return { resolved, localHeld: false };
  }
  if (localLock.tryAcquire(opts.jobId)) {
    return { resolved, localHeld: true };
  }
  if (config.local.whenFull === "queue") {
    await localLock.acquire(opts.jobId, signal);
    return {
      resolved: localResolved(
        config,
        difficulty,
        opts.thinking,
        `difficulty=${difficulty} preferred local (queued seat)`,
      ),
      localHeld: true,
    };
  }
  resolved = resolveModel(config, {
    difficulty,
    thinking: opts.thinking,
    localInUse: localLock.maxStreamsCount(),
  });
  if (resolved.local) {
    throw new Error(
      `Local streams full (${localLock.inUse()}/${localLock.maxStreamsCount()}) ` +
        `and no non-local model for difficulty=${difficulty}.`,
    );
  }
  return { resolved, localHeld: false };
}

function findInBuckets(
  config: HerdConfig,
  model: string,
): { model: string; thinking: string; local?: boolean } | undefined {
  for (const d of ["easy", "medium", "hard"] as Difficulty[]) {
    const hit = config[d].find((e) => e.model === model);
    if (hit) return hit;
  }
  return undefined;
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
      `streams ${localInUse}/${config.local.maxStreams}` +
      (localQueued ? ` queued ${localQueued}` : "") +
      ` whenFull=${config.local.whenFull} ` +
      `preferOn=${config.local.preferOn.join(",") || "(none)"}`,
    `maxModelConcurrent: ${config.maxModelConcurrent} (per provider/model)`,
    `resultDelivery: ${config.defaults.resultDelivery} ` +
      `triggerTurnOnResult: ${config.defaults.triggerTurnOnResult}`,
  ];
  for (const d of ["easy", "medium", "hard"] as Difficulty[]) {
    // Blank line before each bucket so markdown UIs don't nest medium/hard
    // under the last easy list item.
    lines.push("", `${d}:`);
    const bucket = config[d];
    if (!bucket.length) {
      lines.push("  (empty)");
      continue;
    }
    for (const e of bucket) {
      const tag = e.local ? " [local]" : "";
      // Avoid leading-space "-" (markdown nested lists). Use plain indent.
      lines.push(`  ${e.model}:${e.thinking}${tag}`);
    }
  }
  return lines.join("\n");
}
