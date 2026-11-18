import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLanePath } from "../lanes.ts";

function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve new files through their nearest existing ancestor; dangling links fail closed. */
function canonical(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonical(dirname(path)), basename(path));
  }
  return realpathSync(path);
}

// Match Pi's built-in write/edit path normalization (without importing internal APIs).
function toolPath(path: string, cwd: string): string {
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return resolve(cwd, normalized);
}

/**
 * Create once when the extension loads, then return this check's result from tool_call.
 * This is an edit/write accident guard, not isolation from bash, extensions or TOCTOU.
 */
export function createWorkerPolicyCheck(env: NodeJS.ProcessEnv = process.env) {
  const worker = env.PI_HERD_WORKER !== undefined || env.PI_HERD_PRIVATE === "1";
  let policy: {
    root: string;
    owns: { path: string; real: string }[];
    forbid: { path: string; real: string }[];
    output?: { path: string; real: string };
  } | undefined;
  try {
    if (worker) {
      if (env.PI_HERD_WORKER !== "1") throw new Error("Missing worker marker");
      const rootPath = env.PI_HERD_ROOT;
      if (!rootPath || !isAbsolute(rootPath)) throw new Error("Missing absolute root");
      const root = realpathSync(rootPath);
      const lanes = (raw: string | undefined) => {
        const values: unknown = JSON.parse(raw ?? "");
        if (!Array.isArray(values)) throw new Error("Expected lane array");
        return values.map((value: unknown) => {
          if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid lane");
          const path = resolve(rootPath, normalizeLanePath(value));
          const real = canonical(path);
          if (!within(root, real)) throw new Error("Lane escapes root");
          return { path, real };
        });
      };
      const owns = lanes(env.PI_HERD_OWNS);
      const forbid = lanes(env.PI_HERD_FORBID);
      const outputPath = env.PI_HERD_OUTPUT;
      if (outputPath !== undefined && (!outputPath || !isAbsolute(outputPath))) throw new Error("Invalid output");
      const output = outputPath ? { path: resolve(outputPath), real: canonical(resolve(outputPath)) } : undefined;
      policy = { root, owns, forbid, output };
    }
  } catch {
    // Invalid worker configuration must never silently become an unrestricted worker.
  }

  return (event: { toolName: string; input: { path?: unknown } }, ctx: { cwd: string }):
    { block: true; reason: string } | undefined => {
    if (!worker || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const blocked = { block: true as const, reason: "Worker edit/write blocked: path is outside its write policy or policy is invalid." };
    if (!policy || typeof event.input.path !== "string" || !event.input.path || event.input.path.includes("\0")) return blocked;
    try {
      const path = toolPath(event.input.path, ctx.cwd);
      const real = canonical(path);
      if (policy.forbid.some((lane) => within(lane.path, path) || within(lane.real, real) || within(canonical(lane.path), real))) return blocked;
      // Pin the output target at initialization, not on each call (symlink retargeting).
      if (policy.output?.path === path && policy.output.real === real) return;
      if (!within(policy.root, real)) return blocked;
      if (policy.owns.some((lane) => within(lane.path, path) && within(lane.real, real))) return;
    } catch {
      // Unresolvable paths (permissions, dangling/cyclic symlinks) are not authorized.
    }
    return blocked;
  };
}
