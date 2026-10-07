import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLocalStreamLock, createMonitorSlots } from "../src/local-lock.ts";

describe("createLocalStreamLock", () => {
  it("enforces maxStreams", () => {
    const lock = createLocalStreamLock(1);
    assert.equal(lock.tryAcquire("j01"), true);
    assert.equal(lock.tryAcquire("j02"), false);
    lock.release("j01");
    assert.equal(lock.tryAcquire("j02"), true);
  });

  it("allows multiple when maxStreams>1", () => {
    const lock = createLocalStreamLock(2);
    assert.equal(lock.tryAcquire("a"), true);
    assert.equal(lock.tryAcquire("b"), true);
    assert.equal(lock.tryAcquire("c"), false);
  });

  it("acquire queues until release", async () => {
    const lock = createLocalStreamLock(1);
    assert.equal(lock.tryAcquire("a"), true);
    let got = false;
    const p = lock.acquire("b").then(() => {
      got = true;
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(got, false);
    assert.equal(lock.queued(), 1);
    lock.release("a");
    await p;
    assert.equal(got, true);
    assert.equal(lock.inUse(), 1);
  });
});

describe("createMonitorSlots (per model)", () => {
  it("caps per model, not globally", () => {
    const slots = createMonitorSlots(2);
    assert.equal(slots.tryAcquire("1", "grok"), true);
    assert.equal(slots.tryAcquire("2", "grok"), true);
    assert.equal(slots.tryAcquire("3", "grok"), false);
    // Different model still has capacity
    assert.equal(slots.tryAcquire("4", "opus"), true);
    assert.equal(slots.tryAcquire("5", "opus"), true);
    assert.equal(slots.tryAcquire("6", "opus"), false);
    slots.release("1");
    assert.equal(slots.tryAcquire("3", "grok"), true);
  });

  it("queues acquire for the same model", async () => {
    const slots = createMonitorSlots(1);
    assert.equal(slots.tryAcquire("a", "m"), true);
    let released = false;
    const p = slots.acquire("b", "m").then(() => {
      released = true;
    });
    assert.equal(released, false);
    // Other model can still start without unblocking b
    assert.equal(slots.tryAcquire("c", "other"), true);
    assert.equal(released, false);
    slots.release("a");
    await p;
    assert.equal(released, true);
  });
});
