import { it } from "node:test";
import assert from "node:assert/strict";
import { createHerdMonitor } from "../src/herd/monitor.ts";
import { createCoreClient, type CoreClient } from "../src/herdr/core.ts";
import { createAndBootJob, stopAgentInPane, submitTaskToPane, waitForJobIdle, waitUntilAgentReady, type JobHandle } from "../src/herd/boot.ts";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const failKill of [false, true]) it(`monitor never frees a live unreported core worker; kill failure=${failKill}`, async () => {
  let reads = 0;
  let live = true;
  let cleanupStarted!: () => void;
  const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve; });
  let finishCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { finishCleanup = resolve; });
  let released = 0;
  const herdr = { kind: "core", getPaneInfo: async () => {
    if (++reads === 1) throw new Error("transient IPC error");
    return { pane_id: "t2", state: live ? "live" : "finished", agent_status: "unknown" };
  }, closePane: async () => {
    cleanupStarted();
    await cleanupGate;
    if (failKill) throw new Error("kill failed");
    live = false;
  }, runInPane: async () => { assert.fail("do not send /quit to an unidentified process"); },
  } as unknown as CoreClient;
  const monitor = createHerdMonitor({ getMaxConcurrent: () => 1, herdr: () => herdr, onComplete: () => { released++; } });
  try {
    const ticket = await monitor.reserveSlot(undefined, { jobId: "job", model: "synthetic/test", owns: ["src/file.ts"] });
    const handle = { jobId: "job", paneId: "t2", model: "synthetic/test", owns: ["src/file.ts"], sessionFile: "/nonexistent/synthetic.jsonl", watermark: 0, taskPreview: "fixture" } as JobHandle;
    monitor.attachAndWatch({ ticketId: ticket, handle });
    await Promise.race([cleaning, new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup never attempted")), 500))]);
    assert.equal(monitor.activeCount(), 1);
    assert.equal(released, 0);
    assert.deepEqual(monitor.inFlightLaneClaims(), [{ key: "job", owns: ["src/file.ts"] }]);
    assert.equal(live, true);
    finishCleanup();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(live, failKill);
    assert.equal(monitor.activeCount(), failKill ? 1 : 0);
    assert.equal(released, failKill ? 0 : 1);
    assert.equal(monitor.inFlightLaneClaims().length, failKill ? 1 : 0);
  } finally { finishCleanup(); monitor.dispose(); }
});

for (const state of ["absent", "finished"] as const) it(`core stop accepts confirmed ${state} without OSC inference`, async () => {
  const herdr = { kind: "core", getPaneInfo: async () => state === "absent" ? null : { pane_id: "t2", state: "finished" }, closePane: async () => { assert.fail("already stopped"); } } as unknown as CoreClient;
  await stopAgentInPane({ herdr, paneId: "t2", timeoutMs: 40 });
});

it("core readiness settle cannot report success after its deadline", async () => {
  const herdr = { kind: "core", getPaneInfo: async () => ({ pane_id: "t2", state: "live", agent: "pi", agent_status: "idle" }) } as unknown as CoreClient;
  await assert.rejects(waitUntilAgentReady(herdr, "t2", 40), /abort|timed out/i);
});

it("core idle wait preserves working's sliding stall deadline", async () => {
  const started = Date.now();
  const herdr = { kind: "core", getPaneInfo: async () => ({ pane_id: "t2", state: "live", agent: "pi", agent_status: Date.now() - started < 850 ? "working" : "done" }) } as unknown as CoreClient;
  assert.deepEqual(await waitForJobIdle({ herdr, paneId: "t2", timeoutMs: 600 }), { status: "done", sawBusy: true });
  assert.ok(Date.now() - started > 600, "stall budget is not a job wall-clock cap");
});

for (const phase of ["create", "ready", "idle", "stop", "submit", "submit-ack", "stop-kill"] as const) {
  for (const mode of ["nonresponsive", "late success", "caller cancellation"] as const) it(`core ${phase} deadline interrupts ${mode} real IPC`, async () => {
    const root = mkdtempSync(join(tmpdir(), "core-deadline-"));
    const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-herdr-deadline-${randomUUID()}` : join(root, "ipc.sock");
    const sockets = new Set<import("node:net").Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const terminal = { address: "t2", labels: {}, argv: ["synthetic"], cwd: root, state: "live", created_ms: 1, screen: "", cols: 80, rows: 24, status: { app: "pi", state: phase.startsWith("submit") ? "working" : "idle" } };
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", chunk => {
        const req = JSON.parse(String(chunk));
        const result = req.method === "terminal.send" ? { turn: 1 } : { ...terminal, address: req.params.terminal ?? "t2" };
        // Creation's parent lookup succeeds; the actual mutation hangs.
        if ((phase === "create" && req.method === "terminal.get") ||
            (phase === "submit-ack" && req.method === "terminal.send") ||
            (phase === "stop-kill" && req.method === "terminal.get")) {
          socket.end(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
        } else if (mode === "late success") {
          timers.add(setTimeout(() => socket.end(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n"), phase.startsWith("submit") ? 5_800 : 200));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    const herdr = createCoreClient({ socketPath: path, terminalId: "t1", timeoutMs: 8_000 });
    const started = Date.now();
    const signal = mode === "caller cancellation" ? AbortSignal.timeout(phase.startsWith("submit") ? 800 : 40) : undefined;
    const timeoutMs = mode === "caller cancellation" ? 2_000 : 40;
    try {
      let operation: Promise<unknown>;
      if (phase === "create") operation = createAndBootJob({ herdr, label: "fixture", cwd: root, bootCmd: "unused", coreLaunch: { argv: ["synthetic"], env: {}, jobLabel: "fixture" }, sessionFile: join(root, "session.jsonl"), timeoutMs, signal });
      else if (phase === "ready") operation = waitUntilAgentReady(herdr, "t2", timeoutMs, signal);
      else if (phase === "idle") operation = waitForJobIdle({ herdr, paneId: "t2", timeoutMs, signal, allowIdleWithoutBusy: true });
      else if (phase.startsWith("stop")) operation = stopAgentInPane({ herdr, paneId: "t2", timeoutMs, signal });
      else operation = submitTaskToPane({ herdr, paneId: "t2", task: "fixture", signal });
      await assert.rejects(operation, /abort|deadline|timed out/i);
      const bound = phase.startsWith("submit") ? mode === "caller cancellation" ? 1_200 : 5_700 : 500;
      assert.ok(Date.now() - started < bound, "lifecycle deadline, not transport timeout");
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
