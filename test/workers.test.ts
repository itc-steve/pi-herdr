import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHerdConfig } from "../src/config.ts";
import { resolveWorker } from "../src/workers.ts";
import { buildHandoffKick } from "../src/handoff.ts";

const raw = {
  workers: {
    local: { model: "local/test", thinking: "low", maxConcurrent: 2 },
    grok: { model: "xai/test", thinking: "medium", group: "grok" },
    codex: { model: "openai-codex/test", thinking: "medium" },
  },
  private: { enabled: true },
};

describe("named workers", () => {
  it("requires explicit selection; local availability never decides", () => {
    const config = parseHerdConfig(raw);
    assert.throws(() => resolveWorker(config, {}), /Choose worker=/);
    assert.equal(resolveWorker(config, { worker: "codex" }).model, "openai-codex/test");
    assert.equal(resolveWorker(config, { worker: "local" }).maxConcurrent, 2);
    assert.equal(config.local.model, "local/test");
  });
  it("private forces local and rejects cloud or disabled private mode", () => {
    const config = parseHerdConfig(raw);
    assert.equal(resolveWorker(config, { private: true }).name, "local");
    assert.throws(() => resolveWorker(config, { private: true, worker: "grok" }), /local worker/);
    assert.throws(() => resolveWorker(config, { private: true, model: "xai/test" }), /local worker/);
    config.private.enabled = false;
    assert.throws(() => resolveWorker(config, { private: true }), /enabled/);
  });
  it("legacy catalogs migrate with do reasoning first, not think xhigh", () => {
    const config = parseHerdConfig({ local: { model: "local/test" },
      do: [{ model: "xai/test", thinking: "medium" }],
      think: [{ model: "xai/test", thinking: "xhigh" }],
    });
    assert.equal(resolveWorker(config, { worker: "grok" }).thinking, "medium");
    assert.equal(resolveWorker(config, { model: "xai/test" }).thinking, "medium");
  });
  it("validates worker names, capacity, and contradictory selection", () => {
    const config = parseHerdConfig(raw);
    assert.throws(() => resolveWorker(config, { worker: "missing" }), /Unknown worker/);
    assert.throws(() => resolveWorker(config, { worker: "codex", model: "xai/test" }), /different models/);
    for (const cap of [0, -1, 1.5, Infinity, "2"]) assert.throws(() => parseHerdConfig({ workers: { local: { model: "l/x", thinking: "low", maxConcurrent: cap } } }), /positive integer/);
    assert.throws(() => parseHerdConfig({ workers: { cloud: { model: "x/y", thinking: "low", local: true } } }), /Only worker/);
  });
  it("exact overrides reuse known subscription groups", () => {
    const config = parseHerdConfig(raw);
    assert.equal(resolveWorker(config, { model: "xai/other" }).group, "grok");
  });
  it("prompts separate read-only work from worker capability and broaden private guidance", () => {
    const base = { task: "review", runDir: "/run", reads: [], output: "out.md" };
    assert.match(buildHandoffKick({ ...base, readOnly: true }), /Report-only: do not edit project files/);
    assert.match(buildHandoffKick({ ...base, readOnly: false }), /Edit only owns=/);
    const privateKick = buildHandoffKick({ ...base, private: true, readOnly: true });
    assert.match(privateKick, /customer information.*PII/);
    assert.match(privateKick, /safe aggregates/);
    assert.match(privateKick, /Report-only/);
  });
});
