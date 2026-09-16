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
