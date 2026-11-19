import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import type { HerdRuntime } from "../src/herd/actions.ts";
import type { CoreClient } from "../src/herdr/core.ts";
import { setImmediate as nextTick } from "node:timers/promises";
import { Type } from "typebox";
import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

it("Pi 1.5 registrations, policy, renderers, registry, progress and cancelled-parent delivery", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "herd-index-integration-"));
  const keys = [...new Set(["HOME", "HERDR_ENV", "HERDR_PANE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "HC_SESSION", ...Object.keys(process.env).filter((key) => /^(HERDR_|HC_)/.test(key)), "PI_HERD_WORKER", "PI_HERD_PRIVATE", "PI_HERD_ROOT", "PI_HERD_OWNS", "PI_HERD_FORBID", "PI_HERD_OUTPUT"])];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  process.env.HOME = home;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  let shutdown = async () => {};
  t.after(async () => {
    await shutdown();
    keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]);
    rmSync(home, { recursive: true, force: true });
  });
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "herd.json"), JSON.stringify({
    sessionDir: join(home, "runs"), private: { enabled: false },
    defaults: { triggerTurnOnResult: true },
    workers: { scout: { model: "test/model", thinking: "off", maxConcurrent: 1 } },
  }));
  const { default: register } = await import("../index.ts");
  const runtime = createExtensionRuntime();
  const sent: Array<{ content: unknown; triggerTurn?: boolean }> = [];
  runtime.sendMessage = (message, options) => { sent.push({ content: message.content, triggerTurn: options?.triggerTurn }); };
  const gates: Array<() => void> = [];
  const extension = await loadExtensionFromFactory((pi) => register({ ...pi, exec: async () => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return { stdout: "", stderr: "synthetic boot failure", code: 1, killed: false, truncated: false };
  } }), home, createEventBus(), runtime);
  const emit = async (name: string, event: unknown, ctx: unknown) => {
    const results = [];
    for (const handler of extension.handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  shutdown = async () => { await emit("session_shutdown", {}, {}); };
  const registryCalls: string[] = [];
  const modelRegistry = { find: (provider: string, id: string) => {
    registryCalls.push(`${provider}/${id}`);
    return { provider, id, name: id, api: "openai-completions", baseUrl: "http://localhost", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
  } };
  const ctx = { sessionManager: { getBranch: () => [] }, cwd: home, hasUI: false, model: { provider: "cloud", id: "parent" }, modelRegistry, isIdle: () => true };
  const tool = extension.tools.get("herd")!.definition;
  const call = (params: object, signal?: AbortSignal, onUpdate?: (result: unknown) => void) =>
    Reflect.apply(tool.execute, undefined, ["call", params, signal, onUpdate, ctx]);
  await emit("session_start", {}, ctx);

  await t.test("native enum schemas retain exact provider JSON semantics and renderers are registered", async () => {
    assert.deepEqual([...extension.messageRenderers.keys()].sort(), ["herd-peer", "herd-result", "herd-slash"]);
    assert.ok(tool.renderCall);
    assert.ok(tool.renderResult);
    assert.ok(Type.IsObject(tool.parameters));
    const herdSchema = tool.parameters.properties;
    assert.partialDeepStrictEqual(herdSchema.action, { type: "string", enum: ["models", "status", "run", "spawn", "accept", "steer", "peers", "message", "messages", "abort", "wait", "collect", "reset", "close", "journal"] });
    assert.partialDeepStrictEqual(herdSchema.runAction, { type: "string", enum: ["create", "list", "use", "show"] });
    const herdr = extension.tools.get("herdr")!.definition;
    assert.ok(Type.IsObject(herdr.parameters));
    const schemas = herdr.parameters.properties;
    const expected = {
      status: ["idle", "working", "blocked", "done", "unknown"],
      source: ["visible", "recent", "recent-unwrapped", "detection"],
      direction: ["right", "down"], zoom: ["toggle", "on", "off"], moveTo: ["tab", "new-tab", "new-workspace"],
      scope: ["current", "workspace", "all"], mode: ["all", "any"], position: ["top-left", "top-right", "bottom-left", "bottom-right"], sound: ["none", "done", "request"],
    };
    for (const [key, values] of Object.entries(expected)) {
      assert.partialDeepStrictEqual(schemas[key], { type: "string", enum: values });
    }
    assert.partialDeepStrictEqual(schemas.statuses, { type: "array", items: { type: "string", enum: expected.status } });
    const hints: unknown[] = [];
    const text = Reflect.apply(herdr.renderResult!, undefined, [
      { content: [{ type: "text", text: "terminal output" }], details: { action: "read", pane: "w1:p1" } },
      { expanded: false, isPartial: false }, { fg: (_: string, text: string) => text },
      { state: {}, keyHint: (...args: unknown[]) => { hints.push(args); return "CUSTOM KEY"; } },
    ]);
    assert.match(text.render(120).join("\n"), /CUSTOM KEY/);
    assert.deepEqual(hints, [["app.tools.expand", "to expand"]]);
  });

  await t.test("both tool and slash receive their current model registry", async () => {
    const result = await call({ action: "models" });
    assert.match(result.content[0].text, /registered/);
    assert.deepEqual(registryCalls.splice(0), ["test/model"]);
    await Reflect.apply(extension.commands.get("herd")!.handler, undefined, ["models", ctx]);
    assert.deepEqual(registryCalls.splice(0), ["test/model"]);
  });

  await t.test("queue-only progress timers stop on success, errors and cancellation", async () => {
    await call({ action: "run", runAction: "create", name: "progress" });
    const spawned = await call({ action: "spawn", worker: "scout", task: "synthetic progress", output: "progress.md", cwd: home });
    gates.shift()!();
    await nextTick();
    const updates: unknown[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    const cleared: ReturnType<typeof setInterval>[] = [];
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const set = t.mock.method(globalThis, "setInterval", (callback: () => void) => {
      const timer = originalSet(() => {}, 60_000).unref();
      timers.push(timer);
      callback();
      return timer;
    });
    const clear = t.mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => {
      cleared.push(timer); originalClear(timer);
    });
    try {
      const waited = await call({ action: "wait", jobId: spawned.details.jobId }, undefined, (value) => updates.push(value));
      assert.equal(waited.details.error, undefined);
      await call({ action: "collect", jobId: "missing" }, undefined, (value) => updates.push(value));
      const controller = new AbortController(); controller.abort();
      await assert.rejects(call({ action: "spawn", worker: "scout", task: "test", waitForReply: true }, controller.signal, (value) => updates.push(value)));
      assert.equal(timers.length, 3);
      assert.deepEqual(cleared, timers);
      assert.equal(updates.length, 3);
      assert.ok(updates.every((value) => JSON.stringify(value).includes("0 running · 0 queued")));
      assert.ok(updates.every((value) => !JSON.stringify(value).includes("task")));
    } finally { for (const timer of timers) originalClear(timer); set.mock.restore(); clear.mock.restore(); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  await t.test("aborted parents keep background work/pointers but never auto-wake; flush cancellation wins", async () => {
    await call({ action: "run", runAction: "create", name: "delivery" });
    const flushes: Array<() => void> = [];
    const originalSet = globalThis.setTimeout;
    const timerMock = t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== 0) return originalSet(callback, delay, ...args);
      const timer = originalSet(() => {}, 60_000).unref();
      flushes.push(() => { clearTimeout(timer); callback(...args); });
      return timer;
    });
    const spawn = () => call({ action: "spawn", worker: "scout", task: "synthetic task", output: `result-${sent.length}.md`, cwd: home });
    const complete = async () => { gates.shift()!(); await nextTick(); assert.equal(flushes.length, 1); };
    try {
      await emit("agent_start", {}, ctx);
      await spawn();
      await emit("agent_settled", { aborted: true }, ctx);
      await complete(); flushes.shift()!();
      assert.equal(sent.at(-1)!.triggerTurn, false);
      assert.match(String(sent.at(-1)!.content), /failed/);
      await spawn(); await complete(); flushes.shift()!();
      assert.equal(sent.at(-1)!.triggerTurn, false);
      await emit("agent_start", {}, ctx);
      await emit("agent_settled", { aborted: false }, ctx);
      await spawn(); await complete(); flushes.shift()!();
      assert.equal(sent.at(-1)!.triggerTurn, true);
      await spawn(); await complete();
      await emit("agent_settled", { aborted: true }, ctx);
      // Even a fresh user run before the flush must not revive the cancelled wake.
      await emit("agent_start", {}, ctx);
      await emit("agent_settled", { aborted: false }, ctx);
      flushes.shift()!();
      assert.equal(sent.at(-1)!.triggerTurn, false);
    } finally { for (const flush of flushes) flush(); timerMock.mock.restore(); }
  });

  await t.test("blocked pane is visible and warned once without terminal queue blocking", async () => {
    const notices: string[] = [];
    const widgets: unknown[] = [];
    let booted = false;
    let closed = false;
    let observed!: () => void;
    const blocked = new Promise<void>((resolve) => { observed = resolve; });
    const blockedCtx = { ...ctx, hasUI: true, ui: {
      setStatus: () => {}, setWidget: (_key: string, value: unknown) => widgets.push(value),
      notify: (message: string) => { notices.push(message); observed(); },
    } };
    const instance = await loadExtensionFromFactory((pi) => register({ ...pi, exec: async (_command, args, options) => {
      let result: unknown = {};
      if (args[0] === "pane" && args[1] === "current") result = { pane: { workspace_id: "w1" } };
      if (args[0] === "tab" && args[1] === "create") result = { tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: { pane_id: "w1:p2" } };
      if (args[0] === "pane" && args[1] === "get") result = { pane: closed ? null : { pane_id: "w1:p2", agent: booted ? "pi" : "", agent_status: booted ? "blocked" : "unknown" } };
      if (args[0] === "pane" && args[1] === "run") booted = true;
      if (args[0] === "pane" && args[1] === "close") closed = true;
      if (args[0] === "agent" && args[1] === "wait") {
        options?.signal?.throwIfAborted();
        await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
      }
      return { stdout: args[0] === "pane" && args[1] === "read" ? "$ " : JSON.stringify({ result }), stderr: "", code: 0, killed: false, truncated: false };
    } }), home, createEventBus(), runtime);
    const execute = (params: object) => Reflect.apply(instance.tools.get("herd")!.definition.execute, undefined, ["blocked", params, undefined, undefined, blockedCtx]);
    try {
      const spawned = await execute({ action: "spawn", worker: "scout", task: "blocked synthetic boot", output: "blocked.md", cwd: home });
      await Promise.race([blocked, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("No blocked transition observed")), 5000).unref();
        blocked.then(() => clearTimeout(timer));
      })]);
      const warning = notices.filter((message) => message.includes("waiting for user input"));
      assert.equal(warning.length, 1);
      assert.match(warning[0]!, /w1:p2/);
      assert.match(warning[0]!, /-j\d+/);
      assert.match(JSON.stringify(widgets.at(-1)), /waiting for user .*w1:p2/);
      const status = await execute({ action: "status" });
      assert.match(status.content[0].text, /running/);
      assert.doesNotMatch(status.content[0].text, /\sblocked/);
      await execute({ action: "abort", all: true });
      const waited = await execute({ action: "wait", jobId: spawned.details.jobId, timeoutMs: 5000 });
      assert.equal(waited.details.error, undefined);
      assert.equal(closed, true);
    } finally {
      for (const handler of instance.handlers.get("session_shutdown") ?? []) await handler({}, blockedCtx);
    }
  });

  await t.test("worker edit/write gate includes private and report-only artifact exception", async () => {
    process.env.PI_HERD_WORKER = "1";
    process.env.PI_HERD_PRIVATE = "1";
    process.env.PI_HERD_ROOT = home;
    process.env.PI_HERD_OWNS = "[]";
    process.env.PI_HERD_FORBID = "[]";
    process.env.PI_HERD_OUTPUT = join(home, "report.md");
    const worker = await loadExtensionFromFactory(register, home, createEventBus(), createExtensionRuntime());
    const gate = async (toolName: string, path: string) => {
      const results = [];
      for (const handler of worker.handlers.get("tool_call") ?? []) results.push(await handler({ toolName, input: { path } }, { cwd: home }));
      return results;
    };
    assert.deepEqual(await gate("write", join(home, "report.md")), [undefined]);
    assert.deepEqual(await gate("edit", join(home, "report.md")), [undefined]);
    assert.match(JSON.stringify(await gate("write", join(home, "src.ts"))), /"block":true/);
    assert.deepEqual(await gate("read", join(home, "src.ts")), [undefined]);
    for (const handler of worker.handlers.get("session_shutdown") ?? []) await handler({}, {});
  });
});

it("runtime selection registers/activates only real capabilities and keeps nonterminal herd usable", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "herd-runtime-index-"));
  const keys = [...new Set(["HOME", "HERDR_ENV", "HERDR_PANE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "HC_SESSION", ...Object.keys(process.env).filter((key) => /^(HERDR_|HC_)/.test(key)), "PI_HERD_WORKER", "PI_HERD_PRIVATE"])];
  const previous = keys.map((key) => process.env[key]);
  const clear = () => { for (const key of keys) delete process.env[key]; process.env.HOME = home; };
  t.after(() => {
    keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]);
    rmSync(home, { recursive: true, force: true });
  });
  clear();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "herd.json"), JSON.stringify({ private: { enabled: false }, sessionDir: join(home, "runs") }));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\herd-index-${randomUUID()}` : join(home, "core.sock");
  const methods: string[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!);
      methods.push(request.method);
      assert.equal(request.method, "terminal.get");
      socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { address: "t1", labels: {}, argv: [], cwd: home, state: "live", created_ms: 1, screen: "", cols: 80, rows: 24 } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { default: register } = await import("../index.ts");
  for (const [name, env] of Object.entries({
    core: { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: socketPath },
    tui: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    absent: {}, incompleteTui: { HERDR_ENV: "1" }, incompleteCore: { HC_TERMINAL_ID: "t1", HC_SESSION: "no-default-socket" },
  })) await t.test(name, async () => {
    clear(); Object.assign(process.env, env);
    let active = ["read"];
    const statuses: unknown[] = [];
    const ctx = { sessionManager: { getBranch: () => [] }, hasUI: true, ui: { setStatus: (_key: string, value: unknown) => statuses.push(value), setWidget: () => {}, notify: () => {} }, isIdle: () => true };
    const extension = await loadExtensionFromFactory((pi) => register({ ...pi,
      getActiveTools: () => active, setActiveTools: (tools) => { active = tools; },
      exec: async () => { throw new Error("Core must not dispatch TUI exec"); },
    }), home, createEventBus(), createExtensionRuntime());
    try {
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
      const terminal = name === "core" || name === "tui";
      assert.deepEqual(active, terminal ? ["read", "herd", "herdr"] : ["read", "herd"]);
      assert.equal(extension.tools.has("herdr"), terminal);
      const herd = extension.tools.get("herd")!.definition;
      const call = (params: object) => Reflect.apply(herd.execute, undefined, ["runtime", params, undefined, undefined, ctx]);
      assert.match((await call({ action: "status" })).content[0].text, /herd status/);
      assert.equal((await call({ action: "reset" })).details.error, undefined);
      if (terminal) {
        const herdr = extension.tools.get("herdr")!.definition;
        const schema = herdr.parameters as { properties: Record<string, { enum?: string[] }> };
        if (name === "core") {
          assert.deepEqual(schema.properties.action!.enum, ["list", "current", "pane_get", "agent_list", "agent_get", "read", "run", "send", "stop", "watch", "wait_agent"]);
          const result = await Reflect.apply(herdr.execute, undefined, ["current", { action: "current" }]);
          assert.equal(result.details.pane_id, "t1");
          assert.deepEqual(methods, ["terminal.get"]);
          assert.doesNotMatch(JSON.stringify(herd.parameters), /Herdr tab/);
          assert.doesNotMatch(herd.promptGuidelines!.join("\n"), /view\/focus/);
          assert.match(herd.promptGuidelines!.join("\n"), /no.*focus/i);
          // Guidance, activation and surfaces follow the selected client, not later ambient flags.
          delete process.env.HC_TERMINAL_ID; process.env.HERDR_ENV = "1";
          const options = { promptGuidelines: [], toolGuidelines: { herd: [...herd.promptGuidelines!] } };
          for (const handler of extension.handlers.get("before_agent_start") ?? []) await handler({ systemPromptOptions: options }, ctx);
          assert.doesNotMatch(options.toolGuidelines.herd.join("\n"), /view\/focus/);
          for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
          assert.deepEqual(active, ["read", "herd", "herdr"]);
        } else assert.ok(schema.properties.action!.enum!.includes("workspace_create"));
      } else {
        const result = await call({ action: "spawn", task: "not launched" });
        assert.match(result.content[0].text, /HERDR_PANE_ID/);
        assert.match(result.content[0].text, /HC_TERMINAL_ID.*HC_TERMINAL_SOCKET/);
        assert.match(result.content[0].text, /do not spoof/);
      }
      assert.equal(statuses.some((value) => typeof value === "string" && value.includes("herd ●")), false);
    } finally { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx); }
  });
});

it("core close recovers all exact-label terminals before freeing held capacity", async (t) => {
  const { executeHerd } = await import("../src/herd/actions.ts");
  const { createHerdState } = await import("../src/state.ts");
  const { createLocalStreamLock } = await import("../src/local-lock.ts");
  const { createJobQueue, JobCleanupError } = await import("../src/herd/queue.ts");
  const { createHerdMonitor } = await import("../src/herd/monitor.ts");
  const { loadHerdConfig } = await import("../src/config.ts");
  for (const scenario of ["unknown", "multiple", "multiple-hidden", "lost-remove", "list-failure", "close-failure", "get-failure", "settling", "timeout"] as const) await t.test(scenario, async () => {
    const events: string[] = [];
    const state = createHerdState();
    const queue = createJobQueue();
    const localLock = createLocalStreamLock(1);
    const live = new Set(scenario.startsWith("multiple") ? ["t2", "t3"] : ["close-failure", "get-failure", "settling", "timeout"].includes(scenario) ? ["t2"] : []);
    let failing = scenario === "close-failure" || scenario === "multiple-hidden";
    let hideMatches = false;
    const core = { kind: "core", findWorkerTerminals: async (label: string) => {
      assert.equal(label, "pi-herdr:unique"); events.push("list");
      if (scenario === "list-failure") throw new Error("transport failure");
      return (hideMatches ? [] : [...live]).map((address) => ({ address }));
    }, getPaneInfo: async (id: string) => {
      events.push(`get:${id}`);
      if (scenario === "get-failure") throw new Error("get transport failure");
      return live.has(id) ? { pane_id: id } : null;
    },
    closePane: async (id: string) => {
      assert.equal(state.jobs.job!.paneId, id, "register identity before closing");
      events.push(`close:${id}`); live.delete(id);
      if (failing) { hideMatches = true; throw new Error("lost rm reply"); }
    } } as unknown as CoreClient;
    const monitor = createHerdMonitor({ getMaxConcurrent: () => 1, herdr: () => core, onComplete: () => {} });
    const config = loadHerdConfig(join(tmpdir(), `nonexistent-herd-fixture-${randomUUID()}.json`));
    const runtime: HerdRuntime = { getConfig: () => config, state, localLock, queue, monitor, herdr: () => core };
    state.jobs.job = { jobId: "job", label: "fixture", paneId: scenario === "lost-remove" ? "t2" : "", coreJobLabel: "pi-herdr:unique", sessionFile: "unused", model: "test/model", thinking: "off", local: true, role: "do", runId: null, owns: ["src/x.ts"], forbid: [], launchedAt: 0 };
    await localLock.acquire("job");
    const initialJob = state.jobs.job;
    if (scenario === "settling") delete initialJob.coreJobLabel;
    let settle!: () => void;
    const job = queue.enqueue({ id: "job", group: "fixture", maxConcurrent: 1, cwd: process.cwd(), owns: ["src/x.ts"], after: [], run: async (signal) => {
      if (scenario === "settling" || scenario === "timeout") {
        await new Promise<void>((resolve) => {
          settle = resolve;
          if (scenario === "settling") signal.addEventListener("abort", () => resolve(), { once: true });
        });
        state.jobs.job = { ...initialJob, coreJobLabel: "pi-herdr:unique", paneId: "t2" };
      }
      throw new JobCleanupError("synthetic uncertain create");
    } });
    if (scenario !== "settling" && scenario !== "timeout") await job.finished;
    assert.equal(job.held, true);
    try {
      const close = () => executeHerd(runtime, { action: "close", jobId: "job", timeoutMs: 10 });
      if (scenario === "timeout") {
        await assert.rejects(close(), /still stopping/);
        assert.equal(job.held, true); assert.equal(localLock.inUse(), 1); assert.deepEqual(events, []);
        settle(); await job.finished;
        return;
      }
      if (["unknown", "list-failure", "close-failure", "multiple-hidden", "get-failure"].includes(scenario)) {
        await assert.rejects(close(), /pending|transport|lost rm/);
        assert.equal(job.held, true); assert.equal(localLock.inUse(), 1);
        if (scenario !== "close-failure" && scenario !== "multiple-hidden") return;
        failing = false;
        assert.equal(state.jobs.job.paneId, "t2");
        await close(); // terminal.rm succeeded but its reply was lost; known absence is sufficient.
      } else await close();
      assert.equal(job.held, false); assert.equal(localLock.inUse(), 0); assert.equal(live.size, 0);
      if (scenario.startsWith("multiple")) assert.deepEqual(events.filter((value) => value.startsWith("close:")), ["close:t2", "close:t3"]);
      if (scenario === "lost-remove") assert.ok(events.includes("get:t2"));
    } finally { queue.dispose(); monitor.dispose(); }
  });
});
