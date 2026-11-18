import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { HerdRuntime } from "../src/herd/actions.ts";

// Isolate HOME before src modules load, so config.ts's module-level default path
// points into a temp dir; tests must never touch the real user's ~/.pi config.
const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "herd-models-"));
process.env.HOME = home;
const { parseHerdConfig } = await import("../src/config.ts");
const { executeHerd } = await import("../src/herd/actions.ts");
const { preflightModel } = await import("../src/workers.ts");

const model: Model<Api> = {
  provider: "test", id: "org/nested/model", name: "Test", api: "openai-completions",
  baseUrl: "http://localhost", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
};
const registry = { find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined };

it("preflight uses exact nested IDs and the host clamp, without mutating models", () => {
  const before = structuredClone(model);
  assert.equal(preflightModel("test/org/nested/model", "max", registry), "high");
  assert.equal(preflightModel("test/org/nested/model", "xhigh", registry), "high");
  for (const level of ["off", "minimal", "low", "medium", "high"]) assert.equal(preflightModel("test/org/nested/model", level, registry), level);
  assert.equal(preflightModel("test/org/nested/model", "medium", { find: () => ({ ...model, thinkingLevelMap: { medium: null } }) }), "high");
  assert.deepEqual(model, before);
  assert.equal(preflightModel("test/org/nested/model", "max", { find: () => ({ ...model, reasoning: false }) }), "off");
  assert.equal(preflightModel("test/org/nested/model", "max", { find: () => ({ ...model, thinkingLevelMap: { max: "max" } }) }), "max");
  for (const level of ["", "HIGH", "bogus", " high "]) assert.throws(() => preflightModel("test/org/nested/model", level, registry), /Invalid thinking/);
  for (const id of ["test/org/nested", "test/org/nested/model-extra", "test", "/model", "test/"]) assert.throws(() => preflightModel(id, "low", registry), /Unknown model|provider\/model/);
});

it("spawn rejects unknown models, missing registry and invalid overrides before any allocation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herd-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = parseHerdConfig({ sessionDir: root, workers: { test: { model: "test/org/nested/model", thinking: "medium" } } });
  const before = structuredClone(config);
  let sideEffects = 0;
  const unexpected = () => { sideEffects++; throw new Error("Unexpected allocation"); };
  const runtime = { getConfig: () => config, modelRegistry: registry, herdr: () => ({}),
    queue: { enqueue: unexpected }, state: { jobs: {}, order: [], mailboxes: new Map() },
  } as unknown as HerdRuntime;
  for (const thinking of ["", "invalid", " high "]) {
    await assert.rejects(executeHerd(runtime, { action: "spawn", worker: "test", thinking, task: "test", output: "out.md" }), /Invalid thinking/);
  }
  await assert.rejects(executeHerd(runtime, { action: "spawn", model: "test/missing", task: "test", output: "out.md" }), /Unknown model/);
  const invalidConfig = parseHerdConfig({ sessionDir: root, workers: { test: { model: "test/org/nested/model", thinking: "bogus" } } });
  await assert.rejects(executeHerd({ ...runtime, getConfig: () => invalidConfig }, { action: "spawn", worker: "test", task: "test", output: "out.md" }), /Invalid thinking/);
  await assert.rejects(executeHerd({ ...runtime, modelRegistry: undefined }, { action: "spawn", worker: "test", task: "test", output: "out.md" }), /model registry/i);
  assert.equal(sideEffects, 0);
  assert.deepEqual(readdirSync(root), []);
  assert.deepEqual(runtime.state.jobs, {});
  assert.deepEqual(runtime.state.order, []);
  assert.equal(runtime.state.mailboxes.size, 0);
  assert.deepEqual(structuredClone(config), before);
});

it("models diagnostics show unknown IDs, effective thinking and explicit unchecked registry status", async (t) => {
  t.after(() => {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });
  assert.ok(!existsSync(join(home, ".pi", "agent", "herd.json")));
  const config = parseHerdConfig({ workers: {
    capped: { model: "test/org/nested/model", thinking: "max" },
    missing: { model: "test/missing", thinking: "low" },
    invalid: { model: "test/org/nested/model", thinking: "bogus" },
  } });
  const before = structuredClone(config);
  const runtime = { getConfig: () => config, modelRegistry: registry } as HerdRuntime;
  const result = await executeHerd(runtime, { action: "models" });
  // action=models lazily creates the missing config file under the isolated HOME
  assert.ok(existsSync(join(home, ".pi", "agent", "herd.json")));
  const created = JSON.parse(readFileSync(join(home, ".pi", "agent", "herd.json"), "utf8"));
  assert.ok(created.workers?.local);
  assert.match(result.text, /effective thinking=high/);
  assert.match(result.text, /Unknown model/);
  assert.match(result.text, /Invalid thinking/);
  assert.match(result.text, /not.*(health|auth)|(?:health|auth).*not/i);
  const unchecked = await executeHerd({ ...runtime, modelRegistry: undefined }, { action: "models" });
  assert.match(unchecked.text, /registry.*not checked/i);
  assert.deepEqual(structuredClone(config), before);
});
