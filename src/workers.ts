import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { HerdConfig, WorkerConfig } from "./types.ts";

type ModelRegistry = Pick<ExtensionContext["modelRegistry"], "find">;
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Registry lookup only: no authentication resolution or server health request. */
export function preflightModel(model: string, thinking: string, registry: ModelRegistry | undefined): ModelThinkingLevel {
  if (!THINKING_LEVELS.includes(thinking)) throw new Error(`Invalid thinking '${thinking}'. Use ${THINKING_LEVELS.join("|")}.`);
  if (!registry) throw new Error("herd spawn requires the Pi model registry; pass ctx.modelRegistry to executeHerd.");
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) throw new Error(`Model '${model}' must be an exact provider/model ID.`);
  const found = registry.find(model.slice(0, slash), model.slice(slash + 1));
  if (!found) throw new Error(`Unknown model '${model}' in the Pi model registry. Check herd models and the Pi model configuration.`);
  return clampThinkingLevel(found, thinking as ModelThinkingLevel);
}

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
  if (found) return { ...found[1], name: found[0], thinking: opts.thinking ?? found[1].thinking };
  // Exact-model escape hatch shares the provider's existing subscription group when known.
  const provider = model!.split("/")[0]!;
  const peer = Object.values(config.workers).find((w) => w.model.split("/")[0] === provider);
  return { name: model!, model: model!, thinking: opts.thinking ?? "medium", local: false, maxConcurrent: peer?.maxConcurrent ?? 1, group: peer?.group ?? provider, description: "Explicit model override" };
}

export function formatWorkers(config: HerdConfig, registry?: ModelRegistry): string {
  return ["herd workers — agent chooses; no automatic local default", ...Object.entries(config.workers).map(([name, w]) => {
    let diagnostic = "";
    if (registry) {
      try { diagnostic = ` · registered; effective thinking=${preflightModel(w.model, w.thinking, registry)}`; }
      catch (error) { diagnostic = ` · ${error instanceof Error ? error.message : String(error)}`; }
    }
    return `${name}: ${w.model}:${w.thinking} · ${w.maxConcurrent} concurrent · group=${w.group}${diagnostic}\n  ${w.description}`;
  }),
    registry ? "Model registry checked; authentication and server health not checked." : "Model registry not checked (no registry supplied); effective thinking, authentication and server health not checked.",
    `private: ${config.private.enabled ? "on" : "off"} · queued jobs wait for capacity and accepted dependencies`,
  ].join("\n");
}
