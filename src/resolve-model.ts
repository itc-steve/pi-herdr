import type { Difficulty, HerdConfig, ResolvedModel } from "./types.ts";
import { assertDifficulty, bucketFor } from "./config.ts";

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
 * - within easy (no override): walk bucket; skip local entries when streams exhausted
 * - local busy on easy → next non-local (or next free) entry in easy list
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
        localInUse >= maxStreams && difficulty === "easy"
          ? `difficulty=easy; local busy → next easy model`
          : `difficulty=${difficulty} bucket order`,
    };
  }

  throw new Error(
    `No available model for difficulty=${difficulty} ` +
      `(local streams ${localInUse}/${maxStreams}).`,
  );
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
): string {
  const lines: string[] = [
    "herd models",
    `local: ${config.local.enabled ? "enabled" : "disabled"} ` +
      `${config.local.model}:${config.local.thinking} ` +
      `streams ${localInUse}/${config.local.maxStreams}`,
    `maxModelConcurrent: ${config.maxModelConcurrent} (per provider/model)`,
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
