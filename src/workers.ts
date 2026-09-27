import type { HerdConfig, WorkerConfig } from "./types.ts";

/** Selection is the parent's job. No local-first routing, overflow, or role ranking. */
export function resolveWorker(config: HerdConfig, opts: {
  worker?: string; model?: string; thinking?: string; private?: boolean;
}): WorkerConfig & { name: string } {
  const name = opts.worker?.trim() || (opts.private ? "local" : undefined);
  const model = opts.model?.trim();
  if (opts.private && !config.private.enabled) throw new Error('private spawn requires "private": { "enabled": true }');
  if (opts.private && !config.local.enabled) throw new Error("private spawn requires a configured local worker");
  if (opts.private && ((name && name !== "local") || (model && model !== config.local.model))) throw new Error("Private tasks must use the local worker; no cloud fallback.");
  if (name && !config.workers[name]) throw new Error(`Unknown worker '${name}'. Use herd models.`);
  if (name && model && config.workers[name]!.model !== model) throw new Error("worker and model select different models; provide only one.");
  const found = name ? [name, config.workers[name]!] as const : Object.entries(config.workers).find(([, w]) => w.model === model);
  if (!found && !model) throw new Error("Choose worker= explicitly (see herd models), or pass model=. No automatic local assignment.");
  if (found) return { ...found[1], name: found[0], thinking: opts.thinking?.trim() || found[1].thinking };
  // Exact-model escape hatch shares the provider's existing subscription group when known.
  const provider = model!.split("/")[0]!;
  const peer = Object.values(config.workers).find((w) => w.model.split("/")[0] === provider);
  return { name: model!, model: model!, thinking: opts.thinking?.trim() || "medium", local: false, maxConcurrent: peer?.maxConcurrent ?? 1, group: peer?.group ?? provider, description: "Explicit model override" };
}

export function formatWorkers(config: HerdConfig): string {
  return ["herd workers — agent chooses; no automatic local default", ...Object.entries(config.workers).map(([name, w]) =>
    `${name}: ${w.model}:${w.thinking} · ${w.maxConcurrent} concurrent · group=${w.group}\n  ${w.description}`),
    `private: ${config.private.enabled ? "on" : "off"} · queued jobs wait for capacity and accepted dependencies`,
  ].join("\n");
}
