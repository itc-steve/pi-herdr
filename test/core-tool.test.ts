import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CoreClient, CorePane, CoreTerminal } from "../src/herdr/core.ts";
import { registerCoreHerdrTool } from "../src/herdr/core-tool.ts";
import { registerHerdrTool } from "../src/herdr/tool.ts";

function setup(register = registerCoreHerdrTool) {
  const calls: unknown[][] = [];
  const terminals: CoreTerminal[] = ["t1", "t2"].map((address, i) => ({ address, labels: { "ovis.pane": i ? "tests" : "parent" }, argv: [], cwd: "/fake", state: "live" as const, created_ms: 0, screen: "", cols: 80, rows: 24 }));
  let pane: CorePane = { pane_id: "t2", agent: "pi", agent_status: "done", reported_status: "done", state: "live", cwd: "/fake" };
  let text = "ready";
  const client = {
    kind: "core",
    getCurrentTerminal: async () => terminals[0],
    listTerminals: async () => terminals,
    getPaneInfo: async () => pane,
    readTerminal: async (id: string, options: unknown, signal?: AbortSignal) => { signal?.throwIfAborted(); calls.push(["read", id, options]); return { text, complete: false, how: "screen", why: "working" }; },
    runInPane: async (...args: unknown[]) => { calls.push(["run", ...args.slice(0, 2)]); },
    sendKeys: async (...args: unknown[]) => { calls.push(["keys", ...args.slice(0, 2)]); },
    closePane: async (id: string) => { calls.push(["close", id]); },
  } as unknown as CoreClient;
  let tool: any;
  register({ registerTool: (t: unknown) => { tool = t; } } as ExtensionAPI, client);
  return { tool, client, calls, terminals, setPane: (p: Partial<CorePane>) => { pane = { ...pane, ...p }; }, setText: (t: string) => { text = t; }, execute: (args: unknown, signal?: AbortSignal) => tool.execute("test", args, signal) };
}

test("core registration advertises only supported actions and early dispatch bypasses TUI", () => {
  const { tool } = setup(registerHerdrTool);
  assert.deepEqual(tool.parameters.properties.action.enum, ["list", "current", "pane_get", "agent_list", "agent_get", "read", "run", "send", "stop", "watch", "wait_agent"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.source, undefined);
  assert.match(tool.promptGuidelines.join(" "), /preserve.*focus/i);
});

test("list/current and read carry no synthetic topology and preserve completeness", async () => {
  const s = setup();
  for (const action of ["list", "current", "pane_get", "agent_list", "agent_get"]) {
    const r = await s.execute({ action, ...(["pane_get", "agent_get"].includes(action) ? { pane: "tests" } : {}) });
    assert.doesNotMatch(r.content[0].text, /workspace|tab_id|focus/);
  }
  const r = await s.execute({ action: "read", pane: "tests", lines: 7 });
  assert.equal(r.details.complete, false);
  assert.equal(r.details.how, "screen");
  assert.equal(r.details.why, "working");
  assert.match(r.content[0].text, /ready/);
  assert.deepEqual(s.calls.at(-1), ["read", "t2", { lines: 7 }]);
});

test("agent listing uses only live reported apps, not process argv", async () => {
  const s = setup();
  s.terminals[0].argv = ["pi"];
  s.terminals[1].status = { app: "pi", state: "error" };
  const agents = (await s.execute({ action: "agent_list" })).details.agents;
  assert.equal(agents.length, 1);
  assert.equal(agents[0].pane_id, "t2");
  assert.equal(agents[0].agent_status, "unknown");
  assert.equal(agents[0].reported_status, "error");
  s.terminals[1].state = "finished";
  assert.deepEqual((await s.execute({ action: "agent_list" })).details.agents, []);
});

test("run submits while send only injects keys; stop never closes parent", async () => {
  const s = setup();
  await s.execute({ action: "run", pane: "tests", command: "echo hi" });
  await s.execute({ action: "send", pane: "t2", keys: "C-c Enter" });
  await s.execute({ action: "stop", pane: "tests" });
  assert.deepEqual(s.calls, [["run", "t2", "echo hi"], ["keys", "t2", ["C-c", "Enter"]], ["close", "t2"]]);
  await assert.rejects(s.execute({ action: "stop", pane: "parent" }), /parent|current/i);
  await assert.rejects(s.execute({ action: "stop" }), /pane/i);
  await assert.rejects(s.execute({ action: "send", pane: "tests", text: "do not submit" }), /text.*unsupported|unsupported.*text/i);
});

test("unsupported actions, target options, read semantics and malformed values fail closed", async () => {
  const s = setup();
  for (const args of [
    { action: "focus", pane: "t2" }, { action: "list", workspace: "main" },
    { action: "read", source: "recent-unwrapped" }, { action: "read", raw: true },
    { action: "watch", match: "x", regex: true }, { action: "read", lines: -1 },
    { action: "run", pane: "tests" }, { action: "send", pane: "tests", keys: "" },
    { action: "wait_agent", panes: ["t2"] }, { action: "list", pane: "t2" },
    { action: "watch", match: "x", timeout: 600001 },
  ]) await assert.rejects(s.execute(args), /unsupported|invalid|required/i);
  assert.deepEqual(s.calls, []);
});

test("targets must exist, labels must be unique, exact IDs take precedence", async () => {
  const s = setup();
  s.terminals[0].labels["ovis.pane"] = "tests";
  await assert.rejects(s.execute({ action: "read", pane: "tests" }), /ambiguous/i);
  await assert.rejects(s.execute({ action: "read", pane: "t999" }), /not found/i);
  await s.execute({ action: "read", pane: "t2" });
});

test("watch is literal and bounded; wait_agent requires reported live agents and settles idle/done equally", async () => {
  const s = setup();
  assert.equal((await s.execute({ action: "watch", pane: "t2", match: "ready" })).details.matched, true);
  s.setText("not yet");
  await assert.rejects(s.execute({ action: "watch", pane: "t2", match: "ready", timeout: 15 }), /timeout|timed out/i);
  assert.equal((await s.execute({ action: "wait_agent", pane: "t2", status: "idle" })).details.agent_status, "done");
  for (const p of [{ agent: undefined }, { state: "finished" as const }, { reported_status: "error" }]) {
    const other = setup(); other.setPane(p);
    await assert.rejects(other.execute({ action: "wait_agent", pane: "t2", timeout: 15 }), /reported|finished|error/i);
  }
  s.setPane({ agent_status: "working", reported_status: "working" });
  await assert.rejects(s.execute({ action: "wait_agent", pane: "t2", timeout: 15 }), /timeout|timed out/i);
  const controller = new AbortController();
  const waiting = s.execute({ action: "watch", pane: "t2", match: "ready", timeout: 1000 }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(waiting, /abort/i);
  await assert.rejects(s.execute({ action: "list" }, controller.signal), /abort/i);
});

test("wait deadline and cancellation reach in-flight client requests", async () => {
  const s = setup();
  s.client.readTerminal = async (_id, _options, signal) => {
    await sleep(1000, undefined, { signal });
    throw new Error("should have aborted request");
  };
  await assert.rejects(s.execute({ action: "watch", pane: "t2", match: "ready", timeout: 15 }), /timed out/i);
  const controller = new AbortController();
  const pending = s.execute({ action: "watch", pane: "t2", match: "ready", timeout: 1000 }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /aborted/i);
});

test("read truncates using Pi bounds without losing read metadata", async () => {
  const s = setup(); s.setText("line\n".repeat(2500));
  const r = await s.execute({ action: "read" });
  assert.equal(r.details.truncated, true);
  assert.equal(r.details.complete, false);
  assert.match(r.content[0].text, /truncated/i);
  assert.match(r.content[0].text, /"complete":false.*"how":"screen".*"why":"working"/);
});
