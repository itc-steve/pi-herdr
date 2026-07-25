import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHerdConfig, defaultConfigObject } from "../src/config.ts";
import {
  resolveModel,
  resolveModelClaimingLocal,
} from "../src/resolve-model.ts";
import { createLocalStreamLock } from "../src/local-lock.ts";

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

  it("prefers local on medium when free (preferOn)", () => {
    const r = resolveModel(config, { difficulty: "medium", localInUse: 0 });
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

  it("picks from hard bucket without local (preferOn default)", () => {
    const r = resolveModel(config, { difficulty: "hard", localInUse: 0 });
    assert.equal(r.difficulty, "hard");
    assert.equal(r.local, false);
    assert.equal(r.model, "grok-cli/grok-4.5");
    assert.equal(r.thinking, "high");
  });

  it("medium falls through to remote when local busy", () => {
    const r = resolveModel(config, { difficulty: "medium", localInUse: 1 });
    assert.equal(r.local, false);
    assert.equal(r.model, "grok-cli/grok-build");
    assert.equal(r.thinking, "medium");
  });
});

describe("resolveModelClaimingLocal", () => {
  it("whenFull=overflow: first easy claim gets local; second overflows", async () => {
    const config = parseHerdConfig({
      ...defaultConfigObject(),
      local: {
        ...(defaultConfigObject().local as object),
        whenFull: "overflow",
      },
    });
    const lock = createLocalStreamLock(1);
    const a = await resolveModelClaimingLocal(
      config,
      { difficulty: "easy", jobId: "j01" },
      lock,
    );
    assert.equal(a.localHeld, true);
    assert.equal(a.resolved.local, true);
    assert.equal(a.resolved.model, config.local.model);

    const b = await resolveModelClaimingLocal(
      config,
      { difficulty: "easy", jobId: "j02" },
      lock,
    );
    assert.equal(b.localHeld, false);
    assert.equal(b.resolved.local, false);
    assert.equal(b.resolved.model, "claude-code/claude-sonnet-5");
    assert.match(b.resolved.reason, /local busy|bucket/);
    assert.equal(lock.inUse(), 1);
  });

  it("whenFull=overflow parallel race: only maxStreams local holders", async () => {
    const config = parseHerdConfig({
      ...defaultConfigObject(),
      local: {
        ...(defaultConfigObject().local as object),
        whenFull: "overflow",
      },
    });
    const lock = createLocalStreamLock(1);
    const results = await Promise.all(
      ["j01", "j02", "j03", "j04", "j05"].map((jobId) =>
        resolveModelClaimingLocal(
          config,
          { difficulty: "easy", jobId },
          lock,
        ),
      ),
    );
    const locals = results.filter((r) => r.localHeld);
    const remotes = results.filter((r) => !r.localHeld);
    assert.equal(locals.length, 1);
    assert.equal(remotes.length, 4);
    assert.ok(remotes.every((r) => r.resolved.local === false));
    assert.equal(lock.inUse(), 1);
  });

  it("whenFull=queue: second job waits then gets local", async () => {
    const config = parseHerdConfig(defaultConfigObject());
    assert.equal(config.local.whenFull, "queue");
    const lock = createLocalStreamLock(1);
    const a = await resolveModelClaimingLocal(
      config,
      { difficulty: "easy", jobId: "j01" },
      lock,
    );
    assert.equal(a.localHeld, true);

    let secondDone = false;
    const bPromise = resolveModelClaimingLocal(
      config,
      { difficulty: "medium", jobId: "j02" },
      lock,
    ).then((r) => {
      secondDone = true;
      return r;
    });

    // Still queued while j01 holds the seat.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(secondDone, false);
    assert.equal(lock.queued(), 1);

    lock.release("j01");
    const b = await bPromise;
    assert.equal(b.localHeld, true);
    assert.equal(b.resolved.local, true);
    assert.equal(lock.inUse(), 1);
  });

  it("forced model=local queues when seat taken (whenFull=queue)", async () => {
    const config = parseHerdConfig(defaultConfigObject());
    const lock = createLocalStreamLock(1);
    await resolveModelClaimingLocal(
      config,
      { difficulty: "easy", jobId: "j01" },
      lock,
    );

    const p = resolveModelClaimingLocal(
      config,
      {
        difficulty: "easy",
        model: config.local.model,
        jobId: "j02",
      },
      lock,
    );
    await new Promise((r) => setTimeout(r, 20));
    lock.release("j01");
    const r = await p;
    assert.equal(r.localHeld, true);
    assert.equal(r.resolved.model, config.local.model);
  });
});
