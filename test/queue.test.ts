import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJobQueue, JobCleanupError } from "../src/herd/queue.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
  const finish = new Map<string, () => void>();
  const started: string[] = [];
  const queue = createJobQueue();
  function add(id: string, extra = {}) {
    return queue.enqueue({
      id, group: "local", maxConcurrent: 2, cwd: "/repo", owns: [`${id}.ts`], after: [],
      run: async () => { started.push(id); await new Promise<void>((r) => finish.set(id, r)); return id; },
      ...extra,
    });
  }
  return { queue, add, finish, started };
}

describe("agent-chosen job queue", () => {
  it("admits ten jobs immediately, runs two, drains without parent intervention", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.add(String(i));
    assert.equal(h.queue.list().length, 10);
    assert.equal(h.started.length, 2);
    for (let i = 0; i < 10; i++) { h.finish.get(String(i))!(); await tick(); }
    assert.equal(h.started.length, 10);
    assert.ok(h.queue.list().every((j) => j.status === "completed"));
  });

  it("serializes overlapping writers and whole-project reviews, including queued readers", async () => {
    const h = harness();
    h.add("a", { owns: ["src"] });
    h.add("review", { group: "codex", owns: [] });
    h.add("b", { owns: ["src/b.ts"] });
    assert.deepEqual(h.started, ["a"]);
    h.finish.get("a")!(); await tick();
    assert.deepEqual(h.started, ["a", "review"]);
    h.finish.get("review")!(); await tick();
    assert.deepEqual(h.started, ["a", "review", "b"]);
    h.finish.get("b")!(); await tick();
  });

  it("waits for parent acceptance, not completion, and rejects unknown dependencies", async () => {
    const h = harness();
    h.add("a"); h.add("b", { after: ["a"] });
    assert.throws(() => h.add("bad", { after: ["missing"] }), /Unknown dependency/);
    assert.throws(() => h.queue.accept("a"), /completed/);
    h.finish.get("a")!(); await tick();
    assert.deepEqual(h.started, ["a"]);
    h.queue.accept("a");
    assert.deepEqual(h.started, ["a", "b"]);
    h.finish.get("b")!(); await tick();
  });

  it("cancels queued jobs without executing and blocks their dependents", async () => {
    const h = harness();
    h.add("a", { maxConcurrent: 1 });
    h.add("b", { maxConcurrent: 1 });
    h.add("c", { after: ["b"] });
    h.queue.abort("b"); await tick();
    assert.equal(h.queue.get("b")!.status, "aborted");
    assert.equal(h.queue.get("c")!.status, "blocked");
    h.finish.get("a")!(); await tick();
    assert.deepEqual(h.started, ["a"]);
  });

  it("running cancellation retains capacity and lanes until cleanup finishes", async () => {
    const h = harness();
    h.add("a", { maxConcurrent: 1 });
    h.add("b", { maxConcurrent: 1, owns: ["a.ts"] });
    h.queue.abort("a");
    assert.deepEqual(h.started, ["a"]);
    assert.equal(h.queue.get("a")!.held, true);
    h.finish.get("a")!(); await tick();
    assert.equal(h.queue.get("a")!.status, "aborted");
    assert.deepEqual(h.started, ["a", "b"]);
    h.finish.get("b")!(); await tick();
  });

  it("holds reservations after unsafe stop and releases only on explicit confirmed close", async () => {
    const h = harness();
    h.add("a", { run: async () => { throw new JobCleanupError("pane still alive"); } });
    h.add("b", { owns: ["a.ts"] });
    h.add("c", { after: ["a"] });
    await tick();
    assert.equal(h.queue.get("a")!.status, "blocked");
    assert.equal(h.queue.get("a")!.held, true);
    assert.equal(h.queue.get("b")!.status, "queued");
    assert.equal(h.queue.get("c")!.status, "blocked");
    h.queue.releaseBlocked("a");
    assert.equal(h.queue.get("b")!.status, "running");
    h.finish.get("b")!(); await tick();
  });

  it("shares a subscription cap while allowing unrelated groups and projects", async () => {
    const h = harness();
    h.add("a", { group: "codex", maxConcurrent: 1, owns: ["src"] });
    h.add("b", { group: "codex", maxConcurrent: 1, cwd: "/other", owns: ["src"] });
    h.add("c", { group: "grok", cwd: "/other", owns: ["different"] });
    assert.deepEqual(h.started, ["a", "c"]);
    h.finish.get("a")!(); await tick();
    assert.deepEqual(h.started, ["a", "c", "b"]);
    h.finish.get("c")!(); h.finish.get("b")!(); await tick();
  });

  it("dispose cancels queued jobs without starting them", async () => {
    const h = harness();
    h.add("a", { maxConcurrent: 1 }); h.add("b", { maxConcurrent: 1 });
    h.queue.dispose();
    h.finish.get("a")!(); await tick();
    assert.deepEqual(h.started, ["a"]);
    assert.equal(h.queue.get("b")!.status, "aborted");
    assert.throws(() => h.add("c"), /disposed/);
  });

  it("failure blocks dependents but lets independent work proceed", async () => {
    const h = harness();
    h.add("a", { run: async () => { throw new Error("bad check"); } });
    h.add("b", { after: ["a"] });
    await tick();
    assert.equal(h.queue.get("a")!.status, "failed");
    assert.equal(h.queue.get("b")!.status, "blocked");
    h.add("c"); h.finish.get("c")!(); await tick();
  });
});
