import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHerdMonitor } from "../src/herd/monitor.ts";

describe("createHerdMonitor abort", () => {
  it("rejects a queued slot reservation instead of starting it later", async () => {
    const monitor = createHerdMonitor({
      getMaxConcurrent: () => 1,
      herdr: () => null,
      onComplete: () => {},
    });
    const first = await monitor.reserveSlot(undefined, {
      model: "test/model",
      jobId: "j1",
    });
    const queued = monitor.reserveSlot(undefined, {
      model: "test/model",
      jobId: "j2",
    });

    assert.equal(monitor.abort({ jobId: "j2" }).length, 1);
    const outcome = await Promise.race([
      queued.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    monitor.releaseTicket(first);
    await queued.catch(() => {});
    assert.equal(outcome, "rejected");
    assert.equal(monitor.modelInUse("test/model"), 0);
  });
});

describe("claimDoPick", () => {
  const catalog = [
    { model: "vllm/local", thinking: "low" },
    { model: "cloud/a", thinking: "medium" },
  ];

  function fresh() {
    return createHerdMonitor({
      getMaxConcurrent: () => 2,
      herdr: () => null,
      onComplete: () => {},
    });
  }

  it("two do jobs stay local while seats remain; third takes the extra", () => {
    const m = fresh();
    const pick = (inUse: number, id: string) =>
      m.claimDoPick(catalog, "vllm/local", inUse, 2, true, id);
    const a = pick(0, "j1");
    const b = pick(1, "j2");
    const c = pick(2, "j3");
    assert.equal(a.entry.model, "vllm/local");
    assert.equal(b.entry.model, "vllm/local");
    assert.equal(c.entry.model, "cloud/a");
    assert.equal(a.queued, false);
    assert.equal(b.queued, false);
    assert.equal(c.queued, false);
  });

  it("all at cap queues the local seat even when the cursor is on an extra", () => {
    // n=3 so one extra pick leaves the cursor on a different extra:
    // pick A at idx 1 → nextStart = (1+1)%3 = 2 (B), not wrap to local.
    const catalog3 = [
      { model: "vllm/local", thinking: "low" },
      { model: "cloud/a", thinking: "medium" },
      { model: "cloud/b", thinking: "high" },
    ];
    const m = fresh();
    m.claimThinkPick([{ model: "cloud/b", thinking: "high" }], 1, "think-b");
    const pick = (inUse: number, id: string) =>
      m.claimDoPick(catalog3, "vllm/local", inUse, 2, true, id);
    assert.equal(pick(0, "j1").entry.model, "vllm/local");
    assert.equal(pick(1, "j2").entry.model, "vllm/local");
    const extra = pick(2, "j3");
    assert.equal(extra.entry.model, "cloud/a");
    assert.equal(extra.queued, false);
    // origin=2 is B (think-held); A held; local full → queue LOCAL, not B.
    const q = pick(2, "j4");
    assert.equal(q.entry.model, "vllm/local");
    assert.equal(q.queued, true);
  });

  it("local disabled: extras rotate at cap 1; all full queues the origin extra", () => {
    const m = fresh();
    const extras = catalog.slice(1);
    const a = m.claimDoPick(extras, "vllm/local", 0, 2, false, "j1");
    assert.equal(a.entry.model, "cloud/a");
    assert.equal(a.queued, false);
    const q = m.claimDoPick(extras, "vllm/local", 0, 2, false, "j2");
    assert.equal(q.entry.model, "cloud/a");
    assert.equal(q.queued, true);
  });
});
