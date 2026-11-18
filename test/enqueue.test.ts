import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executeHerd, type HerdRuntime } from "../src/herd/actions.ts";
import { waitForQueuedJob } from "../src/herd/enqueue.ts";
import { parseHerdConfig } from "../src/config.ts";
import { createRun } from "../src/runs.ts";
import { createHerdState } from "../src/state.ts";
import { createLocalStreamLock } from "../src/local-lock.ts";
import { createHerdMonitor } from "../src/herd/monitor.ts";
import { createJobQueue } from "../src/herd/queue.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import { openMailbox, type Mailbox } from "../src/herd/mailbox.ts";

it("waitForQueuedJob reports budget expiry as a state instead of throwing; caller abort stays hard", async () => {
  const pending = new Promise<void>(() => {});
  assert.equal(await waitForQueuedJob(pending, 50), false);
  assert.equal(await waitForQueuedJob(Promise.resolve(), 50), true);
  const esc = new AbortController();
  const p = waitForQueuedJob(pending, 60_000, esc.signal);
  esc.abort();
  await assert.rejects(p, /aborted/i);
});

it("wait returns a still-running pointer on budget expiry instead of a hard abort error", async () => {
  const root = mkdtempSync(join(tmpdir(), "herd-wait-"));
  const config = parseHerdConfig({ sessionDir: root, private: { enabled: false }, workers: {
    local: { model: "local/test", thinking: "low", maxConcurrent: 1, preflight: false },
  } });
  createRun(root, "wait");
  const queue = createJobQueue();
  queue.enqueue({ id: "wait-j01", group: "local", maxConcurrent: 1, cwd: root, owns: [], after: [], run: async (signal) => new Promise<void>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  }) });
  const herdr = { closePane: async () => {} } as unknown as HerdrClient;
  const monitor = createHerdMonitor({ getMaxConcurrent: () => 1, herdr: () => herdr, onComplete: () => {} });
  const state = createHerdState();
  state.jobs["wait-j01"] = { jobId: "wait-j01", label: "stuck", paneId: "w1:p1", workspaceId: "w1", sessionFile: join(root, "s.jsonl"), model: "local/test", thinking: "low", local: false, role: "do", runId: null, owns: [], forbid: [], launchedAt: 0 };
  const runtime: HerdRuntime = { getConfig: () => config, state, localLock: createLocalStreamLock(1), herdr: () => herdr, monitor, queue };
  try {
    const res = await executeHerd(runtime, { action: "wait", jobId: "wait-j01", timeoutMs: 100 });
    assert.match(res.text, /Job wait-j01 still running after 100ms/);
    assert.equal(res.details.timedOut, true);
    assert.equal(queue.get("wait-j01")!.status, "running");
  } finally {
    queue.dispose();
    monitor.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it("public spawn returns before boot; acceptance releases dependent work; abort never boots queued jobs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herd-enqueue-"));
  const config = parseHerdConfig({ sessionDir: root, private: { enabled: true }, workers: {
    local: { model: "local/test", thinking: "low", maxConcurrent: 1, preflight: false },
    codex: { model: "cloud/test", thinking: "max", maxConcurrent: 1 },
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
        assert.ok(command.startsWith("env -u PI_HERD_PRIVATE"));
        assert.match(command, /PI_HERD_WORKER=1 /);
        assert.match(command, /PI_PROGRAM_STATUS=1 /);
        assert.equal(command.match(/PI_CODING_AGENT_SESSION_DIR='([^']+)'/)![1], dirname(p.session));
        assert.equal(command.match(/PI_HERD_ROOT='([^']+)'/)![1], root);
        assert.match(command, /--extension '.*index.ts'/);
        assert.match(command, /PI_HERD_FORBID='\[\]'/);
        assert.ok(!command.includes("--no-tools") && !command.includes("--exclude-tools"));
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
  const statuses: Array<{ jobId: string; paneId: string; status: string }> = [];
  const setPaneStatus = monitor.setPaneStatus;
  monitor.setPaneStatus = (jobId, paneId, status) => {
    statuses.push({ jobId, paneId, status });
    setPaneStatus(jobId, paneId, status);
  };
  const modelRegistry: NonNullable<HerdRuntime["modelRegistry"]> = { find: (provider, id) => ({
    provider, id, name: id, api: "openai-completions", baseUrl: "http://localhost", reasoning: provider !== "local", input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
  }) };
  const runtime: HerdRuntime = { modelRegistry, getConfig: () => config, queue, monitor, herdr: () => herdr, state: createHerdState(), localLock: createLocalStreamLock(1) };
  t.after(() => { queue.dispose(); monitor.dispose(); rmSync(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const first = await executeHerd(runtime, { action: "spawn", worker: "local", task: "edit file", owns: "src/a.ts", output: "a.md", cwd: root }, controller.signal);
  const id = first.details.jobId as string;
  controller.abort(); // admitted jobs outlive the tool signal
  assert.equal(created, 0);
  const second = await executeHerd(runtime, { action: "spawn", worker: "codex", task: "review sanitized code", after: id, output: "review.md", cwd: root });
  assert.match(first.text, /Thinking adjusted: low → off/);
  assert.match(second.text, /Thinking adjusted: max → high/);
  assert.equal(runtime.state.jobs[id]!.thinking, "off");
  assert.equal(runtime.state.jobs[second.details.jobId as string]!.thinking, "high");
  assert.equal(config.workers.codex!.thinking, "max");
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
  const normalCommands = commands.filter(c => c.includes("pi --model"));
  assert.equal(normalCommands.length, 2);
  assert.match(normalCommands[0]!, /--model 'local\/test:off'/);
  assert.match(normalCommands[1]!, /--model 'cloud\/test:high'/);
  assert.ok(normalCommands.every(c => c.includes("PI_HERD_MAILBOX=") && c.includes("PI_HERD_JOB=") && !c.includes("PI_HERD_PRIVATE=1") && !c.includes("--no-mcp")));
  assert.match(normalCommands[0]!, /PI_HERD_OWNS='\["src\/a.ts"\]'/);
  assert.match(normalCommands[1]!, /PI_HERD_OWNS='\[\]'/);
  assert.ok(normalCommands.every(c => /PI_HERD_OUTPUT='[^']+\/(a|review)\.md'/.test(c)));
  assert.ok(statuses.some(s => s.jobId === id && s.paneId === "w1:p1" && s.status === "idle"));
  assert.match(kicks[0]!, /herd peers/);
  assert.equal([...runtime.state.mailboxes.values()][0]!.peer(id).status, "finished");
  assert.equal(runtime.localLock.inUse(), 0);
  assert.equal(monitor.activeCount(), 0);
  const collected = await executeHerd(runtime, { action: "collect", jobId: second.details.jobId as string });
  assert.match(collected.text, /check passed/);
  const privateJob = await executeHerd(runtime, { action: "spawn", private: true, task: "Count records; return no identifiers", output: "private.md", cwd: root, waitForReply: true, timeoutMs: 10_000 });
  assert.equal(privateJob.details.status, "completed");
  assert.match(privateJob.text, /Thinking adjusted: low → off/);
  assert.equal(privateJob.details.thinking, "off");
  assert.equal(created, 3);
  assert.match(kicks[2]!, /PRIVATE LOCAL helper/);
  assert.match(kicks[2]!, /customer information.*PII/);
  const privateCommand = commands.find(c => c.includes("pi --model") && c.includes("PI_HERD_PRIVATE=1"))!;
  assert.ok(privateCommand.includes("--no-mcp"));
  assert.ok(!privateCommand.includes("PI_HERD_MAILBOX=") && !privateCommand.includes("PI_HERD_JOB="));
  assert.match(privateCommand, /PI_HERD_OWNS='\[\]'/);
  assert.match(privateCommand, /PI_HERD_OUTPUT='[^']+\/private\.md'/);
  const privateStatuses = statuses.filter(s => s.jobId === privateJob.details.jobId);
  assert.ok(privateStatuses.some(s => s.status === "working" && s.paneId === "w1:p3"));
  assert.ok(privateStatuses.some(s => s.status === "idle" && s.paneId === "w1:p3"));
  assert.ok(!kicks[2]!.includes("herd peers"));
  await assert.rejects(executeHerd(runtime, { action: "spawn", private: true, worker: "codex", task: "secret", output: "secret.md" }), /local worker/);
  await assert.rejects(executeHerd(runtime, { action: "spawn", worker: "local", task: "x", output: "a.md" }), /unique output/);
});
