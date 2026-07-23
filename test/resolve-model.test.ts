import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHerdConfig, defaultConfigObject } from "../src/config.ts";
import { resolveModel } from "../src/resolve-model.ts";

describe("resolveModel", () => {
  const config = parseHerdConfig(defaultConfigObject());

  it("requires difficulty", () => {
    assert.throws(() => resolveModel(config, { difficulty: "" }), /difficulty/);
  });

  it("prefers local on easy when free", () => {
    const r = resolveModel(config, { difficulty: "easy", localInUse: 0 });
    assert.equal(r.local, true);
    assert.equal(r.model, config.local.model);
  });

  it("falls through to next easy when local busy", () => {
    const r = resolveModel(config, { difficulty: "easy", localInUse: 1 });
    assert.equal(r.local, false);
    assert.equal(r.model, "claude-code/claude-sonnet-5");
    assert.match(r.reason, /local busy|bucket/);
  });

  it("exact model= still requires local mutex", () => {
    assert.throws(
      () =>
        resolveModel(config, {
          difficulty: "easy",
          model: config.local.model,
          localInUse: 1,
        }),
      /streams full/,
    );
  });

  it("exact non-local model works with difficulty", () => {
    const r = resolveModel(config, {
      difficulty: "hard",
      model: "claude-code/claude-opus-4-8",
      thinking: "high",
      localInUse: 0,
    });
    assert.equal(r.local, false);
    assert.equal(r.thinking, "high");
  });

  it("picks from hard bucket", () => {
    const r = resolveModel(config, { difficulty: "hard", localInUse: 0 });
    assert.equal(r.difficulty, "hard");
    assert.equal(r.local, false);
    assert.equal(r.model, "grok-cli/grok-4.5");
    assert.equal(r.thinking, "high");
  });

  it("medium is grok-build only", () => {
    const r = resolveModel(config, { difficulty: "medium", localInUse: 0 });
    assert.equal(r.model, "grok-cli/grok-build");
    assert.equal(r.thinking, "medium");
  });
});
