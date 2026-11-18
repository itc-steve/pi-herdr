import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHerdMonitor } from "../src/herd/monitor.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import type { JobHandle } from "../src/herd/boot.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("live blocked state", () => {
  it("notifies once per transition and clears on resume, release and cancellation", async () => {
    const notified: string[] = [];
    let changes = 0;
    const m = createHerdMonitor({
      getMaxConcurrent: () => 1, herdr: () => null, onComplete: () => {},
      onChange: () => { changes++; },
      onBlocked: (job, pane) => notified.push(`${job}/${pane}`),
    });
    const ticket = await m.reserveSlot(undefined, { model: "test/model", jobId: "j1" });
    const before = changes;
    m.setPaneStatus("j1", "p1", "blocked");
    m.setPaneStatus("j1", "p1", "blocked");
    assert.deepEqual(m.blockedJobs(), [{ jobId: "j1", paneId: "p1" }]);
    assert.equal(changes, before + 1);
    assert.equal(m.listJobs()[0]!.status, "running");
    m.setPaneStatus("j1", "p1", "working");
    assert.deepEqual(m.blockedJobs(), []);
    m.setPaneStatus("j1", "p1", "blocked");
    m.abort({ jobId: "j1" });
    assert.deepEqual(m.blockedJobs(), []);
    assert.equal(m.modelInUse("test/model"), 1);
    m.setPaneStatus("j1", "p1", "blocked");
    m.releaseTicket(ticket);
    assert.deepEqual(m.blockedJobs(), []);
    assert.deepEqual(notified, ["j1/p1", "j1/p1", "j1/p1"]);
  });

  it("clears blocked state before completion and releases only after mailbox/output readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-monitor-"));
    const sessionFile = join(dir, "session.jsonl");
    const outputPath = join(dir, "result.md");
    writeFileSync(sessionFile, JSON.stringify({ type: "message", message: {
      role: "assistant", content: [{ type: "text", text: "complete" }], stopReason: "stop",
    } }) + "\n");
    writeFileSync(outputPath, "complete");
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let reads = 0;
    const client = {
      getPaneInfo: async () => ({ agent: "pi", agent_status: ++reads === 1 ? "blocked" : "done" }),
      waitAgentStatus: async () => {},
    } as unknown as HerdrClient;
    const m = createHerdMonitor({ getMaxConcurrent: () => 1, herdr: () => client,
      onComplete: event => {
        assert.equal(event.status, "done");
        assert.deepEqual(m.blockedJobs(), []);
        finish();
      } });
    try {
      const ticket = await m.reserveSlot(undefined, { model: "test/model", jobId: "j1" });
      m.attachAndWatch({ ticketId: ticket, handle: { jobId: "j1", paneId: "p1", model: "test/model",
        taskPreview: "test", sessionFile, watermark: 0, outputPath } as JobHandle,
        mailboxFinished: () => true });
      await finished;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(m.modelInUse("test/model"), 0);
    } finally { m.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  for (const cleanupFails of [false, true]) {
    it(`holds reservations until timeout cleanup succeeds (cleanupFails=${cleanupFails})`, async () => {
      let monitoring = true;
      let closeStarted!: () => void;
      const closing = new Promise<void>(resolve => { closeStarted = resolve; });
      let allowClose!: () => void;
      const closeGate = new Promise<void>(resolve => { allowClose = resolve; });
      let completed = false;
      const client = {
        getPaneInfo: async () => {
          if (!monitoring) throw new Error("stop unavailable");
          return { agent: "pi", agent_status: "blocked" };
        },
        waitAgentStatus: async () => {
          monitoring = false;
          throw new Error("connection lost");
        },
        closePane: async () => {
          closeStarted();
          await closeGate;
          if (cleanupFails) throw new Error("close unavailable");
        },
      } as unknown as HerdrClient;
      const m = createHerdMonitor({ getMaxConcurrent: () => 1, herdr: () => client,
        onComplete: () => { completed = true; } });
      const ticket = await m.reserveSlot(undefined, { model: "test/model", jobId: "j1", owns: ["src/a.ts"] });
      m.attachAndWatch({ ticketId: ticket, handle: {
        jobId: "j1", paneId: "p1", model: "test/model", taskPreview: "test", owns: ["src/a.ts"],
      } as JobHandle, timeoutMs: 10 });
      await closing;
      assert.equal(m.modelInUse("test/model"), 1);
      assert.equal(m.inFlightLaneClaims().length, 1);
      assert.equal(completed, false);
      allowClose();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(m.modelInUse("test/model"), cleanupFails ? 1 : 0);
      assert.equal(m.inFlightLaneClaims().length, cleanupFails ? 1 : 0);
      assert.equal(completed, !cleanupFails);
      assert.deepEqual(m.blockedJobs(), []);
      m.releaseTicket(ticket);
      m.dispose();
    });
  }
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
