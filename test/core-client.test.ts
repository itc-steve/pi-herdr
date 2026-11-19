import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCoreClient, CoreClientError } from "../src/herdr/core.ts";

const terminal = (extra = {}) => ({ address: "t2", labels: {}, argv: ["pi"], cwd: "/project", state: "live", created_ms: 1, screen: "exact", cols: 80, rows: 24, status: null, ...extra });
type Request = { jsonrpc: string; id: number; method: string; params: Record<string, any> };
async function fake(t: any, handler: (request: Request, socket: Socket) => void, timeoutMs = 1000) {
  const dir = await mkdtemp(join(tmpdir(), "core-client-"));
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-herdr-test-${randomUUID()}` : join(dir, "ipc");
  const sockets = new Set<Socket>();
  const requests: Request[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", chunk => {
      text += chunk;
      if (!text.includes("\n")) return;
      assert.equal(text.split("\n").length, 2);
      const request = JSON.parse(text.trim());
      requests.push(request);
      handler(request, socket);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { client: createCoreClient({ socketPath: path, terminalId: "t1", timeoutMs }), requests };
}
function reply(socket: Socket, result: unknown) { socket.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }) + "\n"); }
function rpcError(socket: Socket, kind: string) { socket.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: kind, data: { kind } } }) + "\n"); }

test("newline request, caller identity, fragmented messages and UTF-8", async t => {
  const { client, requests } = await fake(t, (_, socket) => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: terminal({ address: "t1", cwd: "/é" }) }) + "\n");
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    socket.write(bytes.subarray(0, split));
    setImmediate(() => socket.end(bytes.subarray(split)));
  });
  assert.equal(client.kind, "core");
  assert.equal((await client.getCurrentTerminal()).cwd, "/é");
  assert.deepEqual(requests, [{ jsonrpc: "2.0", id: 1, method: "terminal.get", params: { terminal: "t1", caller: "t1" } }]);
});

test("only explicit not_found becomes null; malformed and transport errors throw", async t => {
  for (const kind of ["not_found", "unavailable", "finished"]) {
    const { client } = await fake(t, (_, s) => rpcError(s, kind));
    if (kind === "not_found") assert.equal(await client.getPaneInfo("t2"), null);
    else await assert.rejects(client.getPaneInfo("t2"), (e: unknown) => e instanceof CoreClientError && e.kind === kind);
  }
  for (const response of ["garbage\n", '{"jsonrpc":"2.0","id":2,"result":{}}\n', '{"jsonrpc":"2.0","id":1}\n', '{"jsonrpc":"2.0","id":1,"result":{},"error":{}}\n']) {
    const { client } = await fake(t, (_, s) => s.end(response));
    await assert.rejects(client.getPaneInfo("t2"), /response|JSON/i);
  }
  const { client } = await fake(t, (_, s) => s.end());
  await assert.rejects(client.getPaneInfo("t2"), /EOF/);
});

test("oversized responses fail before an unterminated stream can grow unbounded", async t => {
  const { client } = await fake(t, (_, socket) => socket.write("x".repeat(8 * 1024 * 1024 + 1)), 1000);
  await assert.rejects(client.getTerminal("t2"), /response exceeds/i);
});

test("deadlines, abort and connection failure reject rather than fabricate absence", async t => {
  const { client } = await fake(t, () => {}, 30);
  await assert.rejects(client.getTerminal("t2"), /deadline/);
  const controller = new AbortController();
  const pending = client.getTerminal("t2", controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await assert.rejects(client.getTerminal("t2", AbortSignal.abort()), /abort/i);
  const absent = createCoreClient({ socketPath: join(tmpdir(), `no-core-${process.pid}`), terminalId: "t1" });
  await assert.rejects(absent.getPaneInfo("t2"), CoreClientError);
});

test("validates terminals and maps only live reported program status", async t => {
  for (const [status, state, expected] of [[null, "live", "unknown"], [{ state: "idle", app: "pi" }, "live", "idle"], [{ state: "done", app: "pi" }, "live", "done"], [{ state: "error", app: "pi" }, "live", "unknown"], [{ state: "idle", app: "pi" }, "finished", "unknown"]] as const) {
    const { client } = await fake(t, (_, s) => reply(s, terminal({ status, state })));
    const pane = await client.getPaneInfo("t2");
    assert.equal(pane?.agent_status, expected);
    assert.equal(pane?.agent, state === "live" ? status?.app : undefined);
    assert.equal(pane?.state, state);
    assert.equal(pane?.reported_status, status?.state);
    assert.equal("workspace_id" in pane!, false);
    assert.equal("tab_id" in pane!, false);
  }
  for (const extra of [{ address: "shell-name" }, { state: "invalid" }, { status: "idle" }, { status: {} }, { labels: { x: 1 } }, { argv: [1] }, { rows: -1 }, { cwd: null }]) {
    const { client } = await fake(t, (_, s) => reply(s, terminal(extra)));
    await assert.rejects(client.getTerminal("t2"), /terminal|status/);
  }
});

test("read preserves completeness; unsupported sources/raw and invalid history are rejected", async t => {
  const { client, requests } = await fake(t, (_, s) => reply(s, { text: "screen", complete: false, how: "screen", why: "blocked" }));
  assert.deepEqual(await client.readTerminal("t2", { lines: 12 }), { text: "screen", complete: false, how: "screen", why: "blocked" });
  assert.equal(await client.readPane("t2"), "screen");
  assert.equal(requests[0].params.lines, 12);
  for (const options of [{ source: "recent-unwrapped" }, { source: "visible" }, { raw: true }, { lines: -1 }, { lines: 1.5 }]) await assert.rejects(client.readPane("t2", options));
  assert.equal(requests.length, 2);
});

test("send submits once, keys translate only actual parser keys", async t => {
  const { client, requests } = await fake(t, (_, s) => reply(s, { turn: 1 }));
  await client.runInPane("t2", "hello\nworld");
  await client.sendKeys("t2", ["C-c", "Enter", "Escape", "M-x", "S-Tab", "F12", "ctrl+backslash"]);
  assert.deepEqual(requests.map(r => [r.method, r.params]), [
    ["terminal.send", { caller: "t1", terminal: "t2", text: "hello\nworld" }],
    ["terminal.keys", { caller: "t1", terminal: "t2", keys: ["ctrl+c", "enter", "escape", "alt+x", "shift+tab", "f12", "ctrl+backslash"] }],
  ]);
  await client.sendKeys("t2", []);
  for (const key of ["hello", "F13", "ctrl++", "hyper+x", "C-!"]) await assert.rejects(client.sendKeys("t2", [key]), /key/);
  assert.equal(requests.length, 2);
});

test("creation uses structured argv/env, copies only placement labels, exposes label recovery", async t => {
  const { client, requests } = await fake(t, (r, s) => {
    if (r.method === "terminal.get") reply(s, terminal({ address: "t1", labels: { "herdr.space": "space", "herdr.tab": "tab", "herdr.seen": "9", "ovis.pane": "parent", secret: "not copied" } }));
    else if (r.method === "terminal.list") reply(s, { terminals: [terminal({ labels: { "pi-herdr.job": "unique-job" } })], hidden_finished: 0, machines: [] });
    else reply(s, terminal());
  });
  const argv = ["C:\\Program Files\\node.exe", "C:\\pi\\cli.js", "a \"b\"\n"];
  const env = { PI_HERD_WORKER: "1", PI_HERD_PRIVATE: "", PI_HERD_MAILBOX: "" };
  assert.equal((await client.createWorkerTerminal({ argv, cwd: "C:\\project", env, jobLabel: "unique-job", label: "worker label" })).address, "t2");
  assert.deepEqual(requests[1].params, { caller: "t1", parent: "t1", argv, cwd: "C:\\project", env, labels: { "herdr.space": "space", "herdr.tab": "tab", "ovis.pane": "worker label", "pi-herdr.job": "unique-job" }, no_notify: true, wait: false, keep: false, rm: false });
  assert.equal((await client.findWorkerTerminals("unique-job"))[0].address, "t2");
  assert.deepEqual(requests[2].params, { all: true, labels: { "pi-herdr.job": "unique-job" } });
});

test("source-verified pre-create rejections are certain, but post-create and unknown errors are not", async t => {
  for (const [code, kind, uncertain, message] of [
    [-32602, "invalid_params", false], [-32601, "unknown_method", false],
    [-32600, "invalid_request", false], [-32700, "parse_error", false],
    ...["config", "not_found", "machine_unknown", "name_taken", "invalid_template"].map(kind => [-32000, kind, false] as const),
    [-32000, "unavailable", false, "the core is stopping"],
    [-32000, "unavailable", false, "no holder: the holder disconnected before the terminal could start"],
    [-32000, "unavailable", false, "this core has used every terminal id"],
    [-32000, "unavailable", true, "registry persistence timed out; the operation may already have completed"],
    [-32000, "unavailable", true, "unknown failure phase"],
    [-32000, "spawn_failed", true], [-32000, "io", true], [-32603, "internal", true],
    [-32603, "unavailable", true], [-32000, "future_error", true],
  ] as const) {
    const { client, requests } = await fake(t, (r, s) => {
      if (r.method === "terminal.get") return reply(s, terminal({ address: "t1" }));
      s.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: message ?? kind, data: { kind } } }) + "\n");
    });
    await assert.rejects(client.createWorkerTerminal({ argv: ["pi"], cwd: "/p", env: {}, jobLabel: "job" }), (e: unknown) => {
      assert.ok(e instanceof CoreClientError);
      assert.equal(e.uncertain, uncertain, `${code}: ${kind}`);
      return true;
    });
    assert.equal(requests.filter(r => r.method === "terminal.run").length, 1);
  }
});

test("uncertain creation retains recovery label and validated identity, never retries", async t => {
  for (const mode of ["EOF", "deadline", "malformed", "parent", "abort", "rpc", "bad-id"]) {
    const controller = new AbortController();
    const { client, requests } = await fake(t, (r, s) => {
      if (r.method === "terminal.get") return reply(s, terminal({ address: "t1" }));
      if (mode === "EOF") s.end();
      if (mode === "malformed") reply(s, { address: "t9" });
      if (mode === "bad-id") reply(s, { address: "not-an-id" });
      if (mode === "rpc") rpcError(s, "io");
      if (mode === "parent") reply(s, terminal({ address: "t1" }));
      if (mode === "abort") controller.abort();
    }, 40);
    await assert.rejects(client.createWorkerTerminal({ argv: ["pi"], cwd: "/p", env: {}, jobLabel: "job" }, controller.signal), (e: unknown) => {
      assert.ok(e instanceof CoreClientError);
      assert.equal(e.uncertain, true);
      assert.equal(e.jobLabel, "job");
      assert.equal(e.terminalId, mode === "malformed" ? "t9" : undefined);
      return true;
    });
    assert.equal(requests.filter(r => r.method === "terminal.run").length, 1);
  }
});

test("cleanup kills live before rm, validates targets and propagates all failures", async t => {
  for (const state of ["live", "finished"]) {
    const { client, requests } = await fake(t, (r, s) => reply(s, r.method === "terminal.rm" ? { removed: "t2" } : terminal({ state: r.method === "terminal.kill" ? "finished" : state })));
    await client.closePane("t2");
    assert.deepEqual(requests.map(r => r.method), state === "live" ? ["terminal.get", "terminal.kill", "terminal.rm"] : ["terminal.get", "terminal.rm"]);
    await assert.rejects(client.closePane("arbitrary-name"));
  }
  for (const fail of ["terminal.get", "terminal.kill", "terminal.rm"]) {
    const { client, requests } = await fake(t, (r, s) => r.method === fail ? rpcError(s, "unavailable") : reply(s, terminal({ state: r.method === "terminal.kill" ? "finished" : "live" })));
    await assert.rejects(client.closePane("t2"), CoreClientError);
    assert.equal(requests.at(-1)?.method, fail);
  }
});

test("exact core consonant/digit u32 identities, not decimal or names", async t => {
  const { client } = await fake(t, (r, s) => reply(s, terminal({ address: r.params.terminal })));
  for (const id of ["t1", "t1b", "t9z", "t65jk"]) assert.equal((await client.getTerminal(id)).address, id);
  for (const id of ["t0", "t01", "t1a", "t1l", "t9zzzzzzzzzz", "T1", "machine/t1"]) await assert.rejects(client.getTerminal(id), /terminal id/);
});

test("core 0.1.17 omits the machines field when no remote machines exist", async t => {
  const { client } = await fake(t, (_, socket) => reply(socket, { terminals: [terminal()], hidden_finished: 0 }));
  assert.equal((await client.listTerminals())[0].address, "t2");
  const malformed = await fake(t, (_, socket) => reply(socket, { terminals: [], hidden_finished: 0, machines: null }));
  await assert.rejects(malformed.client.listTerminals(), /list response/);
});

test("list/read/input reject malformed results and get rejects mismatched identity", async t => {
  for (const result of [{}, { terminals: [terminal({ status: "idle" })], hidden_finished: 0, machines: [] }]) {
    const { client } = await fake(t, (_, s) => reply(s, result));
    await assert.rejects(client.listTerminals(), /list|status/);
  }
  const { client } = await fake(t, (_, s) => reply(s, {}));
  await assert.rejects(client.readTerminal("t2"), /read response/);
  await assert.rejects(client.runInPane("t2", "text"), (e: unknown) => e instanceof CoreClientError && e.uncertain);
  const mismatch = await fake(t, (_, s) => reply(s, terminal({ address: "t3" })));
  await assert.rejects(mismatch.client.getTerminal("t2"), /identity mismatch/);
});

test("worker launch without placement labels, invalid env and pre-send abort", async t => {
  const { client, requests } = await fake(t, (r, s) => reply(s, terminal({ address: r.method === "terminal.get" ? "t1" : "t2" })));
  const worker = { argv: ["pi"], cwd: "/p", env: {}, jobLabel: "job" };
  await client.createWorkerTerminal(worker);
  assert.deepEqual(requests[1].params.labels, { "pi-herdr.job": "job" });
  for (const env of [{ "bad=name": "x" }, { GOOD: "bad\u0000value" }] as Record<string, string>[]) await assert.rejects(client.createWorkerTerminal({ ...worker, env }), /structured/);
  await assert.rejects(client.createWorkerTerminal(worker, AbortSignal.abort()), (e: unknown) => e instanceof CoreClientError && !e.uncertain);
  assert.equal(requests.length, 2);
});

test("cleanup never removes after unconfirmed kill and rejects wrong removal identity", async t => {
  const { client, requests } = await fake(t, (_, s) => reply(s, terminal()));
  await assert.rejects(client.closePane("t2"), /did not confirm/);
  assert.deepEqual(requests.map(r => r.method), ["terminal.get", "terminal.kill"]);
  const wrong = await fake(t, (r, s) => reply(s, r.method === "terminal.rm" ? { removed: "t3" } : terminal({ state: "finished" })));
  await assert.rejects(wrong.client.closePane("t2"), /did not confirm/);
});
