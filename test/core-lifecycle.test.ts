import { it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupCoreWorkers, createAndBootJob, submitTaskToPane, waitForJobIdle, waitUntilAgentReady } from "../src/herd/boot.ts";
import { piWorkerArgv } from "../src/herd/spawn.ts";
import { executeHerd, type HerdRuntime } from "../src/herd/actions.ts";
import { parseHerdConfig } from "../src/config.ts";
import { createRun } from "../src/runs.ts";
import { createHerdState } from "../src/state.ts";
import { createLocalStreamLock } from "../src/local-lock.ts";
import { createHerdMonitor } from "../src/herd/monitor.ts";
import { createJobQueue, JobCleanupError } from "../src/herd/queue.ts";
import { openMailbox } from "../src/herd/mailbox.ts";
import { createHerdrClient, type HerdrClient } from "../src/herdr/client.ts";
import { createCoreClient, type CoreClient } from "../src/herdr/core.ts";

it("TUI client exposes a literal backend discriminator", () => {
  assert.equal(createHerdrClient(async () => ({ stdout: "", stderr: "", code: 0 })).kind, "herdr");
});

it("core boot creates a structured terminal, registers identity, and never waits for a shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-boot-"));
  const launch = { argv: [process.execPath, "/synthetic/cli.js"], env: { PI_HERD_WORKER: "1" }, jobLabel: "unique-job" };
  let created: unknown;
  let registered = "";
  const herdr = {
    kind: "core",
    createWorkerTerminal: async (value: unknown) => { created = value; return { address: "t2" }; },
    getPaneInfo: async () => ({ pane_id: "t2", agent: "pi", agent_status: "idle", state: "live", cwd: root }),
  } as unknown as CoreClient;
  try {
    const result = await createAndBootJob({ herdr, label: "worker test", cwd: root, bootCmd: "must not execute shell", coreLaunch: launch, sessionFile: join(root, "s.jsonl"), onPaneCreated: id => { registered = id; } });
    assert.deepEqual(created, { ...launch, cwd: root, label: "worker test" });
    assert.deepEqual(result, { paneId: "t2" });
    assert.equal(registered, "t2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("Pi argv uses installed package bin with current Node, not the host test entry or PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bin-"));
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "cli.js"), "// inert fixture");
    writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { pi: "dist/cli.js" } }));
    const runtime = { execPath: "/current/node", argv: ["node", "/host/test-harness.ts"], versions: { node: "22.19" } };
    assert.deepEqual(piWorkerArgv(["--session", "space 'quoted'.jsonl"], root, runtime), ["/current/node", join(root, "dist", "cli.js"), "--session", "space 'quoted'.jsonl"]);
    assert.deepEqual(piWorkerArgv(["--model", "x"], root, { execPath: "/bin/pi", argv: ["pi", "/$bunfs/root/pi.ts"], versions: { bun: "1" } }), ["/bin/pi", "--model", "x"]);
    assert.throws(() => piWorkerArgv([], root, { execPath: "/bin/bun", argv: ["bun", "/host/test.ts"], versions: { bun: "1" } }), /unsupported/);
    assert.throws(() => piWorkerArgv([], root, { ...runtime, versions: { electron: "1", node: "22.19" } }), /Node runtime/);
    assert.throws(() => piWorkerArgv([], root, { ...runtime, versions: {} }), /Node runtime/);
    writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { pi: "../outside.js" } }));
    assert.throws(() => piWorkerArgv([], root, runtime), /outside/);
    writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { pi: "pi.cmd" } }));
    assert.throws(() => piWorkerArgv([], root, runtime), /JavaScript bin/);
    writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { pi: "missing.js" } }));
    assert.throws(() => piWorkerArgv([], root, runtime), /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("core submit waits for real ACK without either TUI Enter nudge", async () => {
  let submitted = 0;
  let sends = 0;
  const herdr = { kind: "core", runInPane: async () => { sends++; submitted = Date.now(); },
    getPaneInfo: async () => ({ pane_id: "t2", state: "live", agent: "pi", agent_status: Date.now() - submitted > 1_800 ? "working" : "idle" }),
    sendKeys: async () => { assert.fail("terminal.send already enters"); },
  } as unknown as CoreClient;
  assert.deepEqual(await submitTaskToPane({ herdr, paneId: "t2", task: "work" }), { nudgedEnter: false });
  assert.equal(sends, 1);
  assert.ok(Date.now() - submitted > 1_800, "send response alone is not ACK");
});

it("core submit fails without real status/session ACK and never sends another Enter", async () => {
  let sends = 0;
  const herdr = { kind: "core", runInPane: async () => { sends++; },
    getPaneInfo: async () => ({ pane_id: "t2", state: "live", agent: "pi", agent_status: "idle" }),
    sendKeys: async () => { assert.fail("must not duplicate terminal.send submission"); },
  } as unknown as CoreClient;
  await assert.rejects(submitTaskToPane({ herdr, paneId: "t2", task: "unacknowledged" }), /was not confirmed|Aborted/);
  assert.equal(sends, 1);
});

it("uncertain core recovery registers every identity before cleanup and fails closed on absence or failed cleanup", async () => {
  const events: string[] = [];
  const herdr = { findWorkerTerminals: async () => [{ address: "t2" }, { address: "t3" }], closePane: async (id: string) => { events.push(`close:${id}`); } } as unknown as CoreClient;
  await cleanupCoreWorkers({ herdr, jobLabel: "unique", onRecovered: id => events.push(`register:${id}`) });
  assert.deepEqual(events, ["register:t2", "register:t3", "close:t2", "close:t3"]);
  herdr.findWorkerTerminals = async () => [];
  await assert.rejects(cleanupCoreWorkers({ herdr, jobLabel: "unique", onRecovered: () => {} }), JobCleanupError);
  herdr.findWorkerTerminals = async () => { throw new Error("list unavailable"); };
  await assert.rejects(cleanupCoreWorkers({ herdr, jobLabel: "unique", onRecovered: () => {} }), JobCleanupError);
  herdr.findWorkerTerminals = async () => [{ address: "t2" }] as never;
  herdr.closePane = async () => { throw new Error("kill unavailable"); };
  await assert.rejects(cleanupCoreWorkers({ herdr, jobLabel: "unique", onRecovered: () => {} }), JobCleanupError);
});

for (const phase of ["boot", "wait"] as const) for (const state of ["finished", "error"] as const) {
  it(`core ${phase} rejects ${state} promptly rather than success/unknown timeout`, async () => {
    const herdr = { kind: "core", getPaneInfo: async () => ({ pane_id: "t2", agent: "pi", agent_status: "idle", state: state === "finished" ? "finished" : "live", reported_status: state === "error" ? "error" : undefined }) } as unknown as CoreClient;
    const promise = phase === "boot" ? waitUntilAgentReady(herdr, "t2", 30_000) : waitForJobIdle({ herdr, paneId: "t2", timeoutMs: 30_000 });
    await assert.rejects(promise, new RegExp(state));
  });
}

type Fault = "blocked" | "error" | "finished" | "uncertain" | "missing" | "cancel" | "rejected";

async function lifecycleFixture(backend: "core" | "herdr", fault?: Fault, failCleanup = false) {
  const root = mkdtempSync(join(tmpdir(), "core-lifecycle-"));
  const config = parseHerdConfig({ sessionDir: root, private: { enabled: true }, local: { preflight: false }, workers: {
    local: { model: "local/test", thinking: "off", maxConcurrent: 1, preflight: false },
  } });
  createRun(root, "contract");
  const workers = new Map<string, { session: string; env: Record<string, string>; argv: string[]; labels: Record<string, string>; busy: number; started: boolean; agent: boolean; state: "live" | "finished" }>();
  const requests: Array<{ method: string; params: Record<string, any> }> = [];
  const launches: Array<{ env: Record<string, string>; argv: string[] }> = [];
  let created = 0;
  let enters = 0;
  let createAttempted!: () => void;
  const attempted = new Promise<void>(r => { createAttempted = r; });
  const parent = { address: "t1", labels: { "herdr.space": "actual-space", "herdr.tab": "actual-tab" } as Record<string, string>, argv: ["parent"], cwd: root, state: "live", created_ms: 1, screen: "", cols: 80, rows: 24, status: { state: "idle", app: "pi" } };
  function terminal(id: string) {
    if (id === "t1") return parent;
    const worker = workers.get(id)!;
    let status = worker.busy-- > 0 ? "working" : "idle";
    if (fault === "cancel" && !worker.started) status = "working";
    if (worker.started && fault === "blocked") status = "blocked";
    if (fault === "error") status = "error";
    if (fault === "finished") worker.state = "finished";
    if (status === "idle" && worker.started && worker.env.PI_HERD_MAILBOX) openMailbox(worker.env.PI_HERD_MAILBOX).finish(worker.env.PI_HERD_JOB!);
    return { ...parent, address: id, labels: worker.labels, argv: worker.argv, state: worker.state, status: worker.state === "finished" ? null : { state: status, app: worker.agent ? "pi" : undefined } };
  }
  function addWorker(id: string, env: Record<string, string>, argv: string[], labels: Record<string, string> = {}) {
    const session = argv[argv.indexOf("--session") + 1]!;
    launches.push({ env, argv });
    workers.set(id, { session, env, argv, labels, busy: 0, started: false, agent: true, state: "live" });
  }
  function input(id: string, text: string) {
    const worker = workers.get(id)!;
    if (text === "/quit") { worker.agent = false; if (backend === "core") worker.state = "finished"; return; }
    worker.started = true;
    if (worker.env.PI_HERD_MAILBOX) openMailbox(worker.env.PI_HERD_MAILBOX).activate(worker.env.PI_HERD_JOB!);
    const report = text.match(/Write your final deliverable to: (.+)/)?.[1];
    if (report) writeFileSync(report, "Synthetic report: verified.");
    appendFileSync(worker.session, ["user", "assistant"].map(role => JSON.stringify({ type: "message", id: role, message: { role, stopReason: "stop", content: [{ type: "text", text: "Synthetic report: verified." }] } })).join("\n") + "\n");
    worker.busy = 3;
  }
  let herdr: HerdrClient;
  const server = createServer(socket => {
    socket.on("error", () => {}); // Cancellation deliberately disconnects an in-flight fake request.
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { id: number; method: string; params: Record<string, any> };
      requests.push(request);
      const p = request.params;
      let result: unknown;
      try {
        switch (request.method) {
          case "terminal.get":
            if (p.terminal !== "t1" && !workers.has(p.terminal)) throw new Error("not_found");
            result = terminal(p.terminal); break;
          case "terminal.run": {
            created++;
            if (fault === "rejected") { createAttempted(); throw new Error("invalid_params"); }
            if (fault !== "missing") addWorker(`t${created + 1}`, p.env, p.argv, p.labels);
            createAttempted();
            if (fault === "uncertain" || fault === "missing") throw new Error("run_failed_after_creation");
            result = terminal(`t${created + 1}`); break;
          }
          case "terminal.list": result = { terminals: [...workers.keys()].map(terminal).filter(t => t.labels["pi-herdr.job"] === p.labels?.["pi-herdr.job"]), hidden_finished: 0, machines: [] }; break;
          case "terminal.send": input(p.terminal, p.text); result = { turn: 1 }; break;
          case "terminal.keys": if (p.keys.includes("enter")) enters++; result = { turn: 1 }; break;
          case "terminal.read": result = { text: "Synthetic report: verified.", complete: true, how: "screen" }; break;
          case "terminal.kill":
            if (failCleanup) throw new Error("kill_failed");
            workers.get(p.terminal)!.state = "finished"; result = terminal(p.terminal); break;
          case "terminal.rm":
            if (failCleanup) throw new Error("rm_failed");
            workers.delete(p.terminal); result = { removed: p.terminal }; break;
          default: throw new Error(`unexpected:${request.method}`);
        }
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: error instanceof Error && error.message === "invalid_params" ? -32602 : -1, message: String(error), data: { kind: error instanceof Error ? error.message : "error" } } }) + "\n");
      }
    });
  });
  if (backend === "core") {
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-herdr-lifecycle-${randomUUID()}` : join(root, "ipc.sock");
    await new Promise<void>(r => server.listen(socketPath, r));
    herdr = createCoreClient({ socketPath, terminalId: "t1", timeoutMs: 2_000 });
  } else {
    herdr = createHerdrClient(async (_command, args) => {
      const [area, action, id, value] = args;
      let result: unknown = {};
      if (area === "pane" && action === "current") result = { pane: { workspace_id: "w1", pane_id: "w1:p0" } };
      else if (area === "tab" && action === "create") {
        const paneId = `w1:p${++created}`;
        addWorker(paneId, {}, []);
        result = { tab: { tab_id: "w1:t1", workspace_id: "w1" }, root_pane: { pane_id: paneId } };
      } else if (area === "pane" && action === "get") {
        const t = terminal(id!);
        result = { pane: { pane_id: id, workspace_id: "w1", agent: t.status?.app, agent_status: t.status?.state } };
      } else if (area === "pane" && action === "read") return { stdout: "$ ", stderr: "", code: 0 };
      else if (area === "pane" && action === "run") {
        if (value!.includes("pi --model")) {
          const env: Record<string, string> = {};
          for (const match of value!.matchAll(/\b(PI_[A-Z_]+)=(?:'([^']*)'|(1))(?= |$)/g)) env[match[1]!] = match[2] ?? match[3]!;
          const argv = ["pi", "--session", value!.match(/--session '([^']+)'/)![1]!];
          addWorker(id!, env, argv);
        } else input(id!, value!);
      } else if (area === "pane" && action === "close") workers.delete(id!);
      else if (area === "pane" && action === "send-keys") enters++;
      else if (!(area === "pane" && action === "rename") && !(area === "agent" && action === "wait")) throw new Error(`Unexpected TUI request: ${args.join(" ")}`);
      return { stdout: JSON.stringify({ result }), stderr: "", code: 0 };
    });
  }
  const queue = createJobQueue();
  const monitor = createHerdMonitor({ getMaxConcurrent: () => 1, herdr: () => herdr, onComplete: () => {} });
  const runtime: HerdRuntime = { getConfig: () => config, herdr: () => herdr, state: createHerdState(), localLock: createLocalStreamLock(1), queue, monitor,
    modelRegistry: { find: (provider, id) => ({ provider, id, name: id, api: "openai-completions", baseUrl: "http://localhost", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 }) },
  };
  return { root, runtime, launches, workers, requests, attempted, get created() { return created; }, get enters() { return enters; },
    async dispose() { queue.dispose(); monitor.dispose(); if (server.listening) await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const backend of ["herdr", "core"] as const) {
  it(`${backend}: executeHerd spawn → report → accept → close contract; public/private env and policy preserved`, async () => {
    const f = await lifecycleFixture(backend);
    try {
      for (const privateJob of [false, true]) {
        const result = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Synthetic fixture only", owns: "src/file.ts", forbid: "src/forbidden.ts", output: privateJob ? "private.md" : "public.md", private: privateJob, cwd: f.root });
        const id = result.details.jobId as string;
        await executeHerd(f.runtime, { action: "wait", jobId: id, timeoutMs: 10_000 });
        assert.equal(f.runtime.queue.get(id)!.status, "completed", f.runtime.queue.get(id)!.error ?? "");
        const job = f.runtime.state.jobs[id]!;
        assert.match(readFileSync(job.outputPath!, "utf8"), /verified/);
        assert.match((await executeHerd(f.runtime, { action: "collect", jobId: id })).text, /verified/);
        assert.equal(f.runtime.queue.get(id)!.status, "completed", "collection must not accept");
        await executeHerd(f.runtime, { action: "accept", jobId: id });
        assert.equal(f.runtime.queue.get(id)!.status, "accepted");
        const launch = f.launches.at(-1)!;
        assert.equal(launch.env.PI_HERD_WORKER, "1");
        assert.equal(launch.env.PI_PROGRAM_STATUS, "1");
        assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, dirname(job.sessionFile));
        assert.equal(launch.env.PI_HERD_ROOT, f.root);
        assert.equal(launch.env.PI_HERD_OWNS, '["src/file.ts"]');
        assert.equal(launch.env.PI_HERD_FORBID, '["src/forbidden.ts"]');
        assert.equal(launch.env.PI_HERD_OUTPUT, job.outputPath);
        assert.equal(launch.env.PI_HERD_PRIVATE === "1", privateJob);
        assert.equal(Boolean(launch.env.PI_HERD_MAILBOX), !privateJob);
        assert.equal(Boolean(launch.env.PI_HERD_JOB), !privateJob);
        if (backend === "core") {
          assert.equal(job.workspaceId, undefined);
          assert.ok(job.coreJobLabel);
          assert.equal(launch.argv[0], process.execPath);
          assert.match(launch.argv[1]!, /cli\.js$/);
          assert.ok(launch.argv.includes("--extension"));
          assert.equal(launch.argv.includes("--no-mcp"), privateJob);
          for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) assert.equal(launch.env[key], "");
          assert.equal(Object.hasOwn(launch.env, "PATH"), false);
          if (privateJob) for (const key of ["PI_HERD_MAILBOX", "PI_HERD_JOB"]) assert.equal(launch.env[key], "");
          assert.ok(!((f.runtime.queue.get(id)!.result as { text: string }).text.includes("workspace")));
        } else assert.equal(job.workspaceId, "w1");
        await executeHerd(f.runtime, { action: "close", jobId: id });
        assert.equal(f.workers.has(job.paneId), false);
        assert.equal(f.runtime.localLock.inUse(), 0);
        assert.equal(f.runtime.monitor.activeCount(), 0);
      }
      assert.equal(f.created, 2);
      assert.equal(f.enters, 0);
    } finally { await f.dispose(); }
  });
}

it("core report-only without output explicitly clears inherited optional output and ownership", async () => {
  const f = await lifecycleFixture("core");
  try {
    const result = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Synthetic report only", cwd: f.root, waitForReply: true, timeoutMs: 10_000 });
    assert.equal(result.details.status, "completed");
    assert.match(result.text, /verified/);
    assert.equal(f.launches[0]!.env.PI_HERD_OUTPUT, "");
    assert.equal(f.launches[0]!.env.PI_HERD_OWNS, "[]");
    assert.equal(f.launches[0]!.env.PI_HERD_FORBID, "[]");
    assert.equal(f.launches[0]!.env.PI_HERD_PRIVATE, "");
    assert.ok(f.launches[0]!.env.PI_HERD_MAILBOX);
    await executeHerd(f.runtime, { action: "close", jobId: result.details.jobId as string });
  } finally { await f.dispose(); }
});

for (const fault of ["blocked", "error", "finished", "uncertain", "missing", "cancel"] as const) {
  it(`core ${fault}: bounded failure/cancellation, cleanup before release, uncertain-create lane retention`, async () => {
    const f = await lifecycleFixture("core", fault);
    try {
      const result = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Synthetic failure", owns: "src/file.ts", output: "result.md", cwd: f.root, timeoutMs: fault === "blocked" ? 2_000 : 10_000 });
      const id = result.details.jobId as string;
      if (fault === "cancel") { await f.attempted; await executeHerd(f.runtime, { action: "abort", jobId: id }); }
      await executeHerd(f.runtime, { action: "wait", jobId: id, timeoutMs: 10_000 });
      const queued = f.runtime.queue.get(id)!;
      assert.equal(f.created, 1, "never retry a failed create");
      assert.equal(queued.status, fault === "missing" ? "blocked" : fault === "cancel" ? "aborted" : "failed", queued.error ?? "");
      assert.equal(queued.held, fault === "missing");
      assert.equal(f.runtime.localLock.inUse(), fault === "missing" ? 1 : 0);
      if (fault === "missing") {
        assert.ok(f.runtime.state.jobs[id]!.coreJobLabel);
        assert.match(queued.error!, /No matching terminal/);
        const second = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Must stay queued", owns: "src/file.ts", output: "second.md", cwd: f.root });
        assert.equal(f.runtime.queue.get(second.details.jobId as string)!.status, "queued");
        assert.equal(f.created, 1);
      } else {
        assert.equal(f.workers.size, 0, "cleanup confirmed before reservation release");
        if (fault === "uncertain") assert.equal(f.runtime.state.jobs[id]!.paneId, "t2", "recovered identity registered");
      }
    } finally { await f.dispose(); }
  });
}

it("core definitive terminal.run rejection releases seats/lanes and close has no pending creation", async () => {
  const f = await lifecycleFixture("core", "rejected");
  try {
    const first = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Synthetic rejected create", owns: "src/file.ts", output: "rejected.md", cwd: f.root });
    const id = first.details.jobId as string;
    await executeHerd(f.runtime, { action: "wait", jobId: id, timeoutMs: 10_000 });
    assert.equal(f.runtime.queue.get(id)!.status, "failed");
    assert.equal(f.runtime.queue.get(id)!.held, false);
    assert.equal(f.runtime.localLock.inUse(), 0);
    assert.equal(f.workers.size, 0);
    assert.equal(f.runtime.state.jobs[id]!.coreJobLabel, undefined, "certain rejection must clear pending-create metadata");
    const close = await executeHerd(f.runtime, { action: "close", jobId: id });
    assert.doesNotMatch(close.text, /unconfirmed|pending|remain held/i);
    assert.equal(f.requests.some(r => r.method === "terminal.list"), false, "no nonexistent worker to reconcile");
    const second = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Same lane is available", owns: "src/file.ts", output: "second.md", cwd: f.root });
    await executeHerd(f.runtime, { action: "wait", jobId: second.details.jobId as string, timeoutMs: 10_000 });
    assert.equal(f.created, 2, "released seat and ownership allow next launch");
  } finally { await f.dispose(); }
});

it("core uncertain-create cleanup failure retains worker identity, seat and ownership lanes", async () => {
  const f = await lifecycleFixture("core", "uncertain", true);
  try {
    const result = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Synthetic uncertain failure", owns: "src/file.ts", output: "result.md", cwd: f.root });
    const id = result.details.jobId as string;
    await executeHerd(f.runtime, { action: "wait", jobId: id, timeoutMs: 10_000 });
    assert.equal(f.runtime.queue.get(id)!.status, "blocked");
    assert.equal(f.runtime.queue.get(id)!.held, true);
    assert.equal(f.runtime.state.jobs[id]!.paneId, "t2");
    assert.equal(f.runtime.localLock.inUse(), 1);
    assert.equal(f.workers.size, 1);
    assert.equal(f.created, 1);
    const second = await executeHerd(f.runtime, { action: "spawn", worker: "local", task: "Cannot take held lane", owns: "src/file.ts", output: "second.md", cwd: f.root });
    assert.equal(f.runtime.queue.get(second.details.jobId as string)!.status, "queued");
  } finally { await f.dispose(); }
});
