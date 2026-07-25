import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHerdConfig, assertDifficulty, defaultConfigObject } from "../src/config.ts";

describe("parseHerdConfig", () => {
  it("parses example-shaped config", () => {
    const cfg = parseHerdConfig(defaultConfigObject());
    assert.equal(cfg.sessionPolicy, "per-job");
    assert.equal(cfg.local.maxStreams, 1);
    assert.ok(cfg.easy.length >= 1);
    assert.equal(cfg.easy[0]!.local, true);
    assert.equal(cfg.defaults.requireOutput, true);
    assert.equal(cfg.local.whenFull, "queue");
    assert.deepEqual(cfg.local.preferOn, ["easy", "medium"]);
    assert.equal(cfg.defaults.resultDelivery, "pointer");
    assert.equal(cfg.defaults.triggerTurnOnResult, true);
  });

  it("promotes local model to front of easy and medium", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low", maxStreams: 1 },
      easy: [{ model: "claude-code/claude-sonnet-5", thinking: "medium" }],
      medium: [{ model: "grok-cli/grok-build", thinking: "medium" }],
      hard: [{ model: "claude-code/claude-opus-4-8", thinking: "high" }],
    });
    assert.equal(cfg.easy[0]!.model, "Vllm/X");
    assert.equal(cfg.easy[0]!.local, true);
    assert.equal(cfg.medium[0]!.model, "Vllm/X");
    assert.equal(cfg.medium[0]!.local, true);
    assert.equal(cfg.hard[0]!.model, "claude-code/claude-opus-4-8");
    assert.notEqual(cfg.hard[0]!.local, true);
  });

  it("respects preferOn and whenFull overrides", () => {
    const cfg = parseHerdConfig({
      local: {
        model: "Vllm/X",
        thinking: "low",
        preferOn: ["easy"],
        whenFull: "overflow",
      },
      easy: [{ model: "claude-code/claude-sonnet-5", thinking: "medium" }],
      medium: [{ model: "grok-cli/grok-build", thinking: "medium" }],
      hard: [],
      defaults: { resultDelivery: "full", triggerTurnOnResult: false },
    });
    assert.deepEqual(cfg.local.preferOn, ["easy"]);
    assert.equal(cfg.local.whenFull, "overflow");
    assert.equal(cfg.easy[0]!.model, "Vllm/X");
    assert.equal(cfg.medium[0]!.model, "grok-cli/grok-build");
    assert.equal(cfg.defaults.resultDelivery, "full");
    assert.equal(cfg.defaults.triggerTurnOnResult, false);
  });

  it("rejects empty buckets when local disabled", () => {
    assert.throws(
      () =>
        parseHerdConfig({
          local: { enabled: false },
          easy: [],
          medium: [],
          hard: [],
        }),
      /at least one/,
    );
  });
});

describe("assertDifficulty", () => {
  it("accepts easy medium hard", () => {
    assert.equal(assertDifficulty("Easy"), "easy");
    assert.equal(assertDifficulty("HARD"), "hard");
  });
  it("rejects junk", () => {
    assert.throws(() => assertDifficulty("ultra"), /easy\|medium\|hard/);
  });
});
