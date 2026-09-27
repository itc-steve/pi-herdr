import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHerdConfig,
  resolveRole,
  defaultConfigObject,
} from "../src/config.ts";

describe("parseHerdConfig", () => {
  it("parses do[] bucket; drops local model duplicate", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low" },
      do: [
        { model: "Vllm/X", thinking: "low" },
        { model: "grok-cli/grok-4.6", thinking: "medium" },
      ],
    });
    assert.deepEqual(
      cfg.do.map((e) => e.model),
      ["grok-cli/grok-4.6"],
    );
  });

  it("do[] must be an array of entries", () => {
    assert.throws(
      () => parseHerdConfig({ do: "grok-cli/grok-4.6" }),
      /\"do\" must be an array/,
    );
    assert.throws(
      () => parseHerdConfig({ do: [{ model: "x" }] }),
      /requires non-empty model and thinking/,
    );
  });

  it("local disabled + do[] passes validation", () => {
    const cfg = parseHerdConfig({
      local: { enabled: false, model: "vllm/x", thinking: "low" },
      do: [{ model: "grok-cli/grok-4.6", thinking: "medium" }],
    });
    assert.equal(cfg.do.length, 1);
  });

  it("local disabled + no think + no do[] fails validation", () => {
    assert.throws(
      () =>
        parseHerdConfig({
          local: { enabled: false, model: "vllm/x", thinking: "low" },
        }),
      /must enable local or define at least one think or do model/,
    );
  });

  it("parses named worker defaults", () => {
    const cfg = parseHerdConfig(defaultConfigObject());
    assert.equal(cfg.sessionPolicy, "per-job");
    assert.equal(cfg.maxModelConcurrent, 2);
    assert.equal(cfg.local.enabled, true);
    assert.equal(cfg.workers.grok!.model, "grok-cli/grok-4.6");
    assert.equal(cfg.workers.local!.maxConcurrent, 2);
    assert.equal(cfg.defaults.requireOutput, true);
    assert.equal(cfg.defaults.resultDelivery, "pointer");
    assert.equal(cfg.defaults.triggerTurnOnResult, true);
  });

  it("folds old easy/medium/hard into think rank (hard first)", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low" },
      easy: [
        { model: "Vllm/X", thinking: "low", local: true },
        { model: "claude-code/claude-sonnet-5", thinking: "medium" },
      ],
      medium: [{ model: "grok-cli/grok-build", thinking: "medium" }],
      hard: [{ model: "claude-code/claude-opus-4-8", thinking: "high" }],
    });
    assert.equal(cfg.local.model, "Vllm/X");
    assert.deepEqual(
      cfg.think.map((e) => e.model),
      [
        "claude-code/claude-opus-4-8",
        "grok-cli/grok-build",
        "claude-code/claude-sonnet-5",
      ],
    );
  });

  it("think[] wins over leftover buckets", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low" },
      think: [{ model: "grok-cli/grok-4.6", thinking: "high" }],
      hard: [{ model: "claude-code/claude-opus-4-8", thinking: "high" }],
      defaults: { resultDelivery: "full", triggerTurnOnResult: false },
    });
    assert.equal(cfg.think.length, 1);
    assert.equal(cfg.think[0]!.model, "grok-cli/grok-4.6");
    assert.equal(cfg.defaults.resultDelivery, "full");
    assert.equal(cfg.defaults.triggerTurnOnResult, false);
  });

  it("ignores maxStreams / preferOn / whenFull leftovers", () => {
    const cfg = parseHerdConfig({
      maxModelConcurrent: 2,
      local: {
        model: "Vllm/X",
        thinking: "low",
        maxStreams: 1,
        preferOn: ["easy"],
        whenFull: "overflow",
      },
      think: [{ model: "grok-cli/grok-4.6", thinking: "high" }],
    });
    assert.equal(cfg.maxModelConcurrent, 2);
    assert.equal("maxStreams" in cfg.local, false);
    assert.equal("preferOn" in cfg.local, false);
    assert.equal("whenFull" in cfg.local, false);
  });

  it("rejects empty think when local disabled", () => {
    assert.throws(
      () =>
        parseHerdConfig({
          local: { enabled: false },
          think: [],
        }),
      /enable local or define at least one think/,
    );
  });
});

describe("private config", () => {
  it("default object has private.enabled false", () => {
    const obj = defaultConfigObject();
    assert.deepEqual(obj.private, { enabled: false });
    assert.equal(parseHerdConfig(obj).private.enabled, false);
  });

  it("omitted private key defaults to disabled", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low" },
    });
    assert.equal(cfg.private.enabled, false);
  });

  it("private: {} leaves enabled false", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low" },
      private: {},
    });
    assert.equal(cfg.private.enabled, false);
  });

  it("explicit false keeps private disabled", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low" },
      private: { enabled: false },
    });
    assert.equal(cfg.private.enabled, false);
  });

  it("explicit true enables private mode", () => {
    const cfg = parseHerdConfig({
      local: { model: "Vllm/X", thinking: "low" },
      private: { enabled: true },
    });
    assert.equal(cfg.private.enabled, true);
  });

  it("non-boolean enabled throws", () => {
    assert.throws(
      () =>
        parseHerdConfig({
          local: { model: "Vllm/X", thinking: "low" },
          private: { enabled: "yes" },
        }),
      /boolean/,
    );
    assert.throws(
      () =>
        parseHerdConfig({
          local: { model: "Vllm/X", thinking: "low" },
          private: { enabled: 1 },
        }),
      /boolean/,
    );
  });

  it("non-object private throws", () => {
    assert.throws(
      () =>
        parseHerdConfig({
          local: { model: "Vllm/X", thinking: "low" },
          private: "on",
        }),
      /object/,
    );
  });
});

describe("resolveRole", () => {
  it("defaults to do", () => {
    assert.equal(resolveRole({}).role, "do");
  });
  it("accepts think aliases", () => {
    assert.equal(resolveRole({ role: "THINK" }).role, "think");
    assert.equal(resolveRole({ role: "review" }).role, "think");
    assert.equal(resolveRole({ role: "plan" }).role, "think");
    assert.equal(resolveRole({ role: "architect" }).role, "think");
    assert.equal(resolveRole({ role: "verify" }).role, "think");
  });
  it("shims difficulty", () => {
    assert.equal(resolveRole({ difficulty: "easy" }).role, "do");
    assert.equal(resolveRole({ difficulty: "medium" }).role, "do");
    const hard = resolveRole({ difficulty: "hard" });
    assert.equal(hard.role, "think");
    assert.match(hard.shim ?? "", /hard/);
  });
  it("role wins over difficulty", () => {
    assert.equal(resolveRole({ role: "do", difficulty: "hard" }).role, "do");
  });
  it("rejects junk", () => {
    assert.throws(() => resolveRole({ role: "hard" }), /do\|think/);
    assert.throws(() => resolveRole({ difficulty: "ultra" }), /easy\|medium\|hard/);
  });
});
