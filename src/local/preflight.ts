/**
 * Local model preflight — probe via injectable model-id checker
 * (Pi model registry when wired; tests inject a fake).
 */

export type ModelProbeFn = (modelId: string) => Promise<boolean> | boolean;

export class PreflightError extends Error {}

export async function preflightLocalModel(opts: {
  model: string;
  enabled: boolean;
  probe?: ModelProbeFn;
}): Promise<void> {
  if (!opts.enabled) return;
  if (!opts.probe) {
    // No probe wired yet — skip (spawn path will still detect early pane death).
    return;
  }
  const ok = await opts.probe(opts.model);
  if (!ok) {
    throw new PreflightError(
      `Local model '${opts.model}' is not available in the Pi model registry. ` +
        `Start vLLM / fix the model id in ~/.pi/agent/herd.json, or spawn with a non-local easy model.`,
    );
  }
}
