import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHerdConfig, defaultConfigObject } from "../src/config.ts";
import {
  resolveModel,
  resolveModelClaimingLocal,
  pickThinkEntry,
  THINK_PER_MODEL,
} from "../src/resolve-model.ts";
import { createLocalStreamLock } from "../src/local-lock.ts";

describe("resolveModel", () => {
  const config = parseHerdConfig(defaultConfigObject());

  it("defaults to local do", () => {
    const r = resolveModel(config, { localInUse: 0 });
    assert.equal(r.local, true);
    assert.equal(r.role, "do");
    assert.equal(r.model, config.local.model);
  });

  it("role=think picks think[0]", () => {
    const r = resolveModel(config, { role: "think" });
    assert.equal(r.local, false);
    assert.equal(r.role, "think");
    assert.equal(r.model, "grok-cli/grok-4.6");
  });

  it("one think: idle catalog → think[0]", () => {
    const r = resolveModel(config, { role: "think" });
    assert.equal(r.model, "grok-cli/grok-4.6");
  });

  it("second think while [0] busy → the other model", () => {
    const r = resolveModel(config, {
      role: "think",
      modelInUse: (m) => (m === "grok-cli/grok-4.6" ? 1 : 0),
    });
    assert.equal(r.model, config.think[1]!.model);
  });

  it("second opinion: rotate even when first model is idle", () => {
    const idle = () => 0;
    const a = pickThinkEntry(config.think, idle, THINK_PER_MODEL, 0);
    const b = pickThinkEntry(config.think, idle, THINK_PER_MODEL, a.nextStart);
    assert.equal(a.entry.model, config.think[0]!.model);
    assert.equal(b.entry.model, config.think[1]!.model);
    assert.equal(a.queued, false);
    assert.equal(b.queued, false);
  });

  it("two hard tasks: 1 of each, never 2 of the same", () => {
    const load: Record<string, number> = {};
    const inUse = (m: string) => load[m] ?? 0;
    const a = pickThinkEntry(config.think, inUse, THINK_PER_MODEL, 0);
    load[a.entry.model] = 1;
    const b = pickThinkEntry(config.think, inUse, THINK_PER_MODEL, a.nextStart);
    assert.equal(a.entry.model, config.think[0]!.model);
    assert.equal(b.entry.model, config.think[1]!.model);
    assert.notEqual(a.entry.model, b.entry.model);
  });

  it("both think models busy → queue think[0]", () => {
    const r = resolveModel(config, {
      role: "think",
      modelInUse: () => 1,
    });
    assert.equal(r.model, "grok-cli/grok-4.6");
    assert.match(r.reason, /queue/);
  });

  it("do does not overflow when local full", () => {
    assert.throws(
      () => resolveModel(config, { localInUse: 2, maxModelConcurrent: 2 }),
      /Local streams full/,
    );
  });

  it("exact local model throws in snapshot when full", () => {
    assert.throws(
      () =>
        resolveModel(config, {
          model: config.local.model,
          localInUse: 2,
          maxModelConcurrent: 2,
        }),
      /streams full/,
    );
  });

  it("exact non-local model works without role", () => {
    const r = resolveModel(config, {
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
    });
    assert.equal(r.local, false);
    assert.equal(r.thinking, "high");
    assert.equal(r.model, "openai-codex/gpt-5.6-sol");
  });

  it("difficulty=hard shims to think", () => {
    const r = resolveModel(config, { difficulty: "hard" });
    assert.equal(r.role, "think");
    assert.equal(r.model, "grok-cli/grok-4.6");
    assert.match(r.reason, /shim|hard|think/i);
  });

  it("difficulty=easy shims to do", () => {
    const r = resolveModel(config, { difficulty: "easy", localInUse: 0 });
    assert.equal(r.role, "do");
    assert.equal(r.local, true);
  });
});

describe("resolveModelClaimingLocal", () => {
  it("two do jobs take two local seats; third queues", async () => {
    const config = parseHerdConfig({
      ...defaultConfigObject(),
      maxModelConcurrent: 2,
    });
    const lock = createLocalStreamLock(2);
    const a = await resolveModelClaimingLocal(
      config,
      { jobId: "j01" },
      lock,
    );
    const b = await resolveModelClaimingLocal(
      config,
      { jobId: "j02" },
      lock,
    );
    assert.equal(a.localHeld, true);
    assert.equal(b.localHeld, true);
    assert.equal(lock.inUse(), 2);

    let thirdDone = false;
    const p = resolveModelClaimingLocal(
      config,
      { jobId: "j03" },
      lock,
    ).then((r) => {
      thirdDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(thirdDone, false);
    assert.equal(lock.queued(), 1);
    lock.release("j01");
    const c = await p;
    assert.equal(c.localHeld, true);
    assert.equal(c.resolved.local, true);
    assert.equal(c.resolved.role, "do");
  });

  it("claimThinkPick spreads two think jobs", async () => {
    const config = parseHerdConfig(defaultConfigObject());
    const lock = createLocalStreamLock(2);
    const load: Record<string, number> = {};
    const claimThinkPick = (
      catalog: { model: string; thinking: string }[],
      max: number,
      _jobId: string,
    ) => {
      const picked = pickThinkEntry(catalog, (m) => load[m] ?? 0, max);
      if (!picked.queued) {
        load[picked.entry.model] = (load[picked.entry.model] ?? 0) + 1;
      }
      return picked;
    };
    const a = await resolveModelClaimingLocal(
      config,
      { role: "think", jobId: "j01", claimThinkPick },
      lock,
    );
    const b = await resolveModelClaimingLocal(
      config,
      { role: "think", jobId: "j02", claimThinkPick },
      lock,
    );
    assert.equal(a.resolved.model, config.think[0]!.model);
    assert.equal(b.resolved.model, config.think[1]!.model);
    assert.equal(a.localHeld, false);
    assert.equal(b.localHeld, false);
  });

  it("think never holds a local seat", async () => {
    const config = parseHerdConfig(defaultConfigObject());
    const lock = createLocalStreamLock(2);
    await resolveModelClaimingLocal(config, { jobId: "j01" }, lock);
    const t = await resolveModelClaimingLocal(
      config,
      { role: "think", jobId: "j02" },
      lock,
    );
    assert.equal(t.localHeld, false);
    assert.equal(t.resolved.role, "think");
    assert.equal(lock.inUse(), 1);
  });

  it("forced model=local queues when seats taken", async () => {
    const config = parseHerdConfig({
      ...defaultConfigObject(),
      maxModelConcurrent: 1,
    });
    const lock = createLocalStreamLock(1);
    await resolveModelClaimingLocal(config, { jobId: "j01" }, lock);
    const p = resolveModelClaimingLocal(
      config,
      { model: config.local.model, jobId: "j02" },
      lock,
    );
    await new Promise((r) => setTimeout(r, 20));
    lock.release("j01");
    const r = await p;
    assert.equal(r.localHeld, true);
    assert.equal(r.resolved.model, config.local.model);
  });
});
