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
  });

  it("promotes local model to front of easy", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low", maxStreams: 1 },
      easy: [{ model: "claude-code/claude-sonnet-5", thinking: "medium" }],
      medium: [],
      hard: [],
    });
    assert.equal(cfg.easy[0]!.model, "Vllm/X");
    assert.equal(cfg.easy[0]!.local, true);
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
