import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHerd, type HerdRuntime } from "../src/herd/actions.ts";
import { parseHerdConfig } from "../src/config.ts";
import { createRun } from "../src/runs.ts";
import { createHerdState } from "../src/state.ts";
import { createLocalStreamLock } from "../src/local-lock.ts";
import { createHerdMonitor } from "../src/herd/monitor.ts";
import { createJobQueue } from "../src/herd/queue.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import { openMailbox, type Mailbox } from "../src/herd/mailbox.ts";

it("public spawn returns before boot; acceptance releases dependent work; abort never boots queued jobs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herd-enqueue-"));
  const config = parseHerdConfig({ sessionDir: root, private: { enabled: true }, workers: {
    local: { model: "local/test", thinking: "low", maxConcurrent: 1, preflight: false },
    codex: { model: "cloud/test", thinking: "medium", maxConcurrent: 1 },
  } });
  createRun(root, "queue");
  let created = 0;
  let releaseBoot!: () => void;
  const bootGate = new Promise<void>((r) => { releaseBoot = r; });
  const panes = new Map<string, { session: string; busy: number; agent: string; mailbox?: Mailbox; jobId?: string; started?: boolean }>();
  const kicks: string[] = [];
  const commands: string[] = [];
  const herdr = {
    getCurrentPaneInfo: async () => { await bootGate; return { workspace_id: "w1" }; },
    getTabList: async () => [],
    createTab: async () => {
      const id = `w1:p${++created}`; panes.set(id, { session: "", busy: 0, agent: "pi" });
      return { tab: { tab_id: id, workspace_id: "w1" }, paneId: id };
    },
    renamePane: async () => {},
    readPane: async () => "$ ",
    getPaneInfo: async (id: string) => {
      const p = panes.get(id)!;
      const status = p.busy-- > 0 ? "working" : "idle";
      if (status === "idle" && p.started && p.mailbox) p.mailbox.finish(p.jobId!);
      return { pane_id: id, workspace_id: "w1", agent: p.agent, agent_status: status };
    },
    waitAgentStatus: async () => {},
    runInPane: async (id: string, command: string) => {
      commands.push(command);
      const p = panes.get(id)!;
      if (command.includes("pi --model")) {
        p.session = command.match(/--session '([^']+)'/)![1]!;
        const dir = command.match(/PI_HERD_MAILBOX='([^']+)'/)?.[1];
        if (dir) {
          p.mailbox = openMailbox(dir);
          p.jobId = command.match(/PI_HERD_JOB='([^']+)'/)![1]!;
          assert.match(command, /--extension '.*index.ts'/);
        }
        return;
      }
      if (command === "/quit") { p.agent = ""; return; }
      kicks.push(command);
      p.started = true;
      p.mailbox?.activate(p.jobId!);
      const output = command.match(/Write your final deliverable to: (.+)/)![1]!;
      writeFileSync(output, "Safe result: check passed.");
      appendFileSync(p.session, ["user", "assistant"].map((role) => JSON.stringify({ type: "message", id: role, message: { role, content: [{ type: "text", text: "Safe result: check passed." }] } })).join("\n") + "\n");
      p.busy = 3;
    },
    sendKeys: async () => {}, closePane: async (id: string) => { panes.delete(id); },
  } as unknown as HerdrClient;
  const queue = createJobQueue();
  const monitor = createHerdMonitor({ getMaxConcurrent: () => 1, herdr: () => herdr, onComplete: () => {} });
  const runtime: HerdRuntime = { getConfig: () => config, queue, monitor, herdr: () => herdr, state: createHerdState(), localLock: createLocalStreamLock(1) };
  t.after(() => { queue.dispose(); monitor.dispose(); rmSync(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const first = await executeHerd(runtime, { action: "spawn", worker: "local", task: "edit file", owns: "src/a.ts", output: "a.md", cwd: root }, controller.signal);
  const id = first.details.jobId as string;
  controller.abort(); // admitted jobs outlive the tool signal
  assert.equal(created, 0);
  const second = await executeHerd(runtime, { action: "spawn", worker: "codex", task: "review sanitized code", after: id, output: "review.md", cwd: root });
  const cancelled = await executeHerd(runtime, { action: "spawn", worker: "local", task: "unused", output: "unused.md", cwd: root });
  await executeHerd(runtime, { action: "abort", jobId: cancelled.details.jobId as string });
  releaseBoot();
  await executeHerd(runtime, { action: "wait", jobId: id, timeoutMs: 10_000 });
  assert.equal(queue.get(id)!.status, "completed");
  assert.equal(created, 1);
  assert.equal(queue.get(second.details.jobId as string)!.status, "queued");
  await executeHerd(runtime, { action: "accept", jobId: id });
  await executeHerd(runtime, { action: "wait", jobId: second.details.jobId as string, timeoutMs: 10_000 });
  assert.equal(created, 2);
  assert.match(kicks[0]!, /Edit only owns=/);
  assert.match(kicks[1]!, /Report-only/);
  assert.ok(commands.some((c) => c.startsWith("env PI_HERD_WORKER=1 PI_HERD_MAILBOX=")));
  assert.match(kicks[0]!, /herd peers/);
  assert.equal([...runtime.state.mailboxes.values()][0]!.peer(id).status, "finished");
  assert.equal(runtime.localLock.inUse(), 0);
  assert.equal(monitor.activeCount(), 0);
  const collected = await executeHerd(runtime, { action: "collect", jobId: second.details.jobId as string });
  assert.match(collected.text, /check passed/);
  const privateJob = await executeHerd(runtime, { action: "spawn", private: true, task: "Count records; return no identifiers", output: "private.md", cwd: root, waitForReply: true, timeoutMs: 10_000 });
  assert.equal(privateJob.details.status, "completed");
  assert.equal(created, 3);
  assert.match(kicks[2]!, /PRIVATE LOCAL helper/);
  assert.match(kicks[2]!, /customer information.*PII/);
  assert.ok(commands.some((c) => c.startsWith("env PI_HERD_PRIVATE=1 pi --model") && !c.includes("PI_HERD_MAILBOX")));
  assert.ok(!kicks[2]!.includes("herd peers"));
  await assert.rejects(executeHerd(runtime, { action: "spawn", private: true, worker: "codex", task: "secret", output: "secret.md" }), /local worker/);
  await assert.rejects(executeHerd(runtime, { action: "spawn", worker: "local", task: "x", output: "a.md" }), /unique output/);
});
