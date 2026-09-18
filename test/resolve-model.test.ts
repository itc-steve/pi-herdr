import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHerdConfig, defaultConfigObject } from "../src/config.ts";
import {
  resolveModel,
  resolveModelClaimingLocal,
  pickThinkEntry,
  pickDoEntry,
  doCatalog,
  formatModelsList,
  THINK_PER_MODEL,
} from "../src/resolve-model.ts";
import { createLocalStreamLock } from "../src/local-lock.ts";
import { createHerdMonitor } from "../src/herd/monitor.ts";

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

describe("do pool (local + do[] extras)", () => {
  const withDo = () =>
    parseHerdConfig({
      ...defaultConfigObject(),
      maxModelConcurrent: 2,
      do: [{ model: "grok-cli/grok-4.6", thinking: "medium" }],
    });

  it("bare do still picks local first", () => {
    const config = withDo();
    const r = resolveModel(config, { localInUse: 0 });
    assert.equal(r.local, true);
    assert.equal(r.role, "do");
    assert.equal(r.model, config.local.model);
  });

  it("local seats full → rotates onto the do extra", () => {
    const r = resolveModel(withDo(), { localInUse: 2, maxModelConcurrent: 2 });
    assert.equal(r.local, false);
    assert.equal(r.role, "do");
    assert.equal(r.model, "grok-cli/grok-4.6");
    assert.equal(r.thinking, "medium");
  });

  it("do extra at cap + local full → queues local", () => {
    const r = resolveModel(withDo(), {
      localInUse: 2,
      maxModelConcurrent: 2,
      modelInUse: (m) => (m === "grok-cli/grok-4.6" ? 1 : 0),
    });
    assert.equal(r.local, true);
    assert.match(r.reason, /queue/);
  });

  it("do extras share the per-model cap with think", () => {
    const r = resolveModel(withDo(), {
      localInUse: 0,
      modelInUse: (m) => (m === "grok-cli/grok-4.6" ? 1 : 0),
    });
    // grok busy → rotation skips it back to local
    assert.equal(r.local, true);
  });

  it("pickDoEntry stays local while a local seat remains (even at an extra cursor)", () => {
    const config = withDo();
    const idle = () => 0;
    const caps = { localModel: config.local.model, localInUse: 0, localMax: 2, localEnabled: true, load: idle };
    const a = pickDoEntry(doCatalog(config), caps, 0);
    // Second do: a local seat is still free → local again, even though the
    // cursor points at the extra (old think-style rotation would have taken it).
    const b = pickDoEntry(doCatalog(config), { ...caps, localInUse: 1 }, 1);
    // Third do: local at cap → the extra.
    const c = pickDoEntry(doCatalog(config), { ...caps, localInUse: 2 }, 1);
    assert.equal(a.entry.model, config.local.model);
    assert.equal(b.entry.model, config.local.model);
    assert.equal(c.entry.model, "grok-cli/grok-4.6");
    assert.equal(a.queued, false);
    assert.equal(b.queued, false);
    assert.equal(c.queued, false);
  });

  it("claim path: two do jobs take local seats; third rotates to extra", async () => {
    const config = withDo();
    const lock = createLocalStreamLock(2);
    const claimed: string[] = [];
    const claimDoPick = (
      catalog: { model: string; thinking: string }[],
      localModel: string,
      localInUse: number,
      localMax: number,
      _localEnabled: boolean,
      jobId: string,
    ) => {
      const picked = pickDoEntry(
        catalog,
        { localModel, localInUse, localMax, localEnabled: true, load: (m) => claimed.includes(m) ? 1 : 0 },
      );
      if (!picked.queued) claimed.push(picked.entry.model);
      return picked;
    };
    const opts = { jobId: "", claimDoPick };
    const a = await resolveModelClaimingLocal(
      config,
      { ...opts, jobId: "j01" },
      lock,
    );
    const b = await resolveModelClaimingLocal(
      config,
      { ...opts, jobId: "j02" },
      lock,
    );
    const c = await resolveModelClaimingLocal(
      config,
      { ...opts, jobId: "j03" },
      lock,
    );
    assert.equal(a.resolved.model, config.local.model);
    assert.equal(a.localHeld, true);
    assert.equal(b.resolved.model, config.local.model);
    assert.equal(b.localHeld, true);
    assert.equal(c.resolved.model, "grok-cli/grok-4.6");
    assert.equal(c.resolved.role, "do");
    assert.equal(c.localHeld, false);
    assert.equal(lock.inUse(), 2);
  });

  it("local disabled + do[] → do resolves to the extra", () => {
    const config = parseHerdConfig({
      local: { enabled: false, model: "vllm/x", thinking: "low" },
      do: [{ model: "grok-cli/grok-4.6", thinking: "medium" }],
    });
    const r = resolveModel(config, {});
    assert.equal(r.role, "do");
    assert.equal(r.local, false);
    assert.equal(r.model, "grok-cli/grok-4.6");
  });

  it("production claimDoPick: two do jobs stay local, third takes the extra", async () => {
    const config = withDo();
    const monitor = createHerdMonitor({
      getMaxConcurrent: () => 2,
      herdr: () => null,
      onComplete: () => {},
    });
    const lock = createLocalStreamLock(2);
    const pick = (jobId: string) => ({
      jobId,
      modelInUse: (m: string) => monitor.thinkLoad(m),
      claimDoPick: (
        catalog: { model: string; thinking: string }[],
        localModel: string,
        localInUse: number,
        localMax: number,
        localEnabled: boolean,
        id: string,
      ) =>
        monitor.claimDoPick(catalog, localModel, localInUse, localMax, localEnabled, id),
    });
    const a = await resolveModelClaimingLocal(config, pick("j01"), lock);
    const b = await resolveModelClaimingLocal(config, pick("j02"), lock);
    const c = await resolveModelClaimingLocal(config, pick("j03"), lock);
    assert.equal(a.resolved.local, true);
    assert.equal(a.localHeld, true);
    assert.equal(b.resolved.local, true);
    assert.equal(b.localHeld, true);
    assert.equal(c.resolved.model, "grok-cli/grok-4.6");
    assert.equal(c.resolved.local, false);
    assert.equal(c.localHeld, false);
    assert.equal(lock.inUse(), 2);
  });

  it("think hold on B + do claims A → next do queues/acquires local, not B", async () => {
    const config = parseHerdConfig({
      ...defaultConfigObject(),
      maxModelConcurrent: 2,
      do: [
        { model: "cloud/a", thinking: "medium" },
        { model: "cloud/b", thinking: "high" },
      ],
      think: [{ model: "cloud/b", thinking: "high" }],
    });
    const monitor = createHerdMonitor({
      getMaxConcurrent: () => 2,
      herdr: () => null,
      onComplete: () => {},
    });
    const lock = createLocalStreamLock(2);
    const think = monitor.claimThinkPick(config.think, THINK_PER_MODEL, "think-b");
    assert.equal(think.entry.model, "cloud/b");
    assert.equal(think.queued, false);
    const pick = (jobId: string) => ({
      jobId,
      modelInUse: (m: string) => monitor.thinkLoad(m),
      claimDoPick: (
        catalog: { model: string; thinking: string }[],
        localModel: string,
        localInUse: number,
        localMax: number,
        localEnabled: boolean,
        id: string,
      ) =>
        monitor.claimDoPick(catalog, localModel, localInUse, localMax, localEnabled, id),
    });
    const j1 = await resolveModelClaimingLocal(config, pick("j01"), lock);
    const j2 = await resolveModelClaimingLocal(config, pick("j02"), lock);
    const j3 = await resolveModelClaimingLocal(config, pick("j03"), lock);
    assert.equal(j1.resolved.local, true);
    assert.equal(j1.localHeld, true);
    assert.equal(j2.resolved.local, true);
    assert.equal(j2.localHeld, true);
    assert.equal(j3.resolved.model, "cloud/a");
    assert.equal(j3.resolved.local, false);
    assert.equal(j3.localHeld, false);
    // catalog [local, A, B]; A at idx 1 → nextStart=(1+1)%3=2, cursor on B.
    // all full (local 2/2, A held, B think-held) → queue/acquire LOCAL, not B.
    let done = false;
    const p = resolveModelClaimingLocal(config, pick("j04"), lock).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(done, false);
    assert.equal(lock.queued(), 1);
    lock.release("j01");
    const j4 = await p;
    assert.equal(j4.resolved.local, true);
    assert.equal(j4.localHeld, true);
    assert.notEqual(j4.resolved.model, "cloud/b");
    assert.match(j4.resolved.reason, /queue local/);
  });

  it("disabled local + extra sharing the local model id caps at 1 like other extras", () => {
    const config = parseHerdConfig({
      local: { enabled: false, model: "vllm/x", thinking: "low" },
      do: [
        { model: "vllm/x", thinking: "low" },
        { model: "cloud/b", thinking: "medium" },
      ],
    });
    const r1 = resolveModel(config, {});
    assert.equal(r1.model, "vllm/x");
    assert.equal(r1.local, false);
    // The colliding extra is a cloud model: in-flight 1/1 → the sibling extra wins.
    const r2 = resolveModel(config, {
      modelInUse: (m) => (m === "vllm/x" ? 1 : 0),
    });
    assert.equal(r2.model, "cloud/b");
  });

  it("disabled local + all extras at cap queues the origin extra (no local claim)", () => {
    const config = parseHerdConfig({
      local: { enabled: false, model: "vllm/x", thinking: "low" },
      do: [{ model: "cloud/a", thinking: "medium" }],
    });
    const r = resolveModel(config, { modelInUse: () => 1 });
    assert.equal(r.model, "cloud/a");
    assert.equal(r.local, false);
    assert.match(r.reason, /queue/);
  });

  it("snapshot: modelInUse on a shared extra queues local", () => {
    const config = parseHerdConfig({
      ...defaultConfigObject(),
      maxModelConcurrent: 2,
      do: [{ model: "claude-code/claude-opus-4-8", thinking: "high" }],
      think: [{ model: "claude-code/claude-opus-4-8", thinking: "high" }],
    });
    const r = resolveModel(config, {
      localInUse: 2,
      maxModelConcurrent: 2,
      modelInUse: (m) => (m === "claude-code/claude-opus-4-8" ? 1 : 0),
    });
    assert.equal(r.local, true);
    assert.match(r.reason, /queue local/);
  });

  it("exact model= for a do-only extra uses the do[] thinking", () => {
    const config = parseHerdConfig({
      ...defaultConfigObject(),
      do: [{ model: "grok-cli/grok-build", thinking: "low" }],
    });
    const r = resolveModel(config, { model: "grok-cli/grok-build" });
    assert.equal(r.local, false);
    assert.equal(r.thinking, "low");
  });

  it("do[] containing only the local model empties to classic local-only", () => {
    const def = defaultConfigObject();
    const config = parseHerdConfig({
      ...def,
      do: [{ model: (def.local as { model: string }).model, thinking: "low" }],
    });
    assert.equal(config.do.length, 0);
    assert.throws(
      () => resolveModel(config, { localInUse: 2, maxModelConcurrent: 2 }),
      /Local streams full/,
    );
  });
});

describe("formatModelsList", () => {
  const cfg = parseHerdConfig(defaultConfigObject());

  it("reports private off on defaults", () => {
    assert.match(formatModelsList(cfg, 0), /^private: off$/m);
  });

  it("reports private on when enabled", () => {
    const on = parseHerdConfig({
      ...defaultConfigObject(),
      private: { enabled: true },
    });
    assert.match(formatModelsList(on, 0), /^private: on$/m);
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
