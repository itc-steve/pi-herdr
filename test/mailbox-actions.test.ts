import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMailbox } from "../src/herd/mailbox.ts";
import { executeHerd, type HerdRuntime } from "../src/herd/actions.ts";
import { createHerdState } from "../src/state.ts";
import { createRun } from "../src/runs.ts";
import { parseHerdConfig } from "../src/config.ts";
import { parseHerdSlashArgs } from "../src/herd/slash.ts";
import { assertOutputName, buildHandoffKick } from "../src/handoff.ts";

it("exposes scoped peer discovery, messages, parent log and private denial", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herd-mail-actions-"));
  const oldPrivate = process.env.PI_HERD_PRIVATE;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (oldPrivate === undefined) delete process.env.PI_HERD_PRIVATE; else process.env.PI_HERD_PRIVATE = oldPrivate;
  });
  const config = parseHerdConfig({ sessionDir: root });
  const { runId, runDir } = createRun(root, "messages");
  const box = createMailbox(join(runDir, "mail"));
  box.register("a", "Frontend"); box.register("b", "Backend");
  box.activate("a"); box.activate("b");
  const state = createHerdState(); state.mailboxes.set(runId, box);
  for (const jobId of ["a", "b", "private"]) state.jobs[jobId] = {
    jobId, runId, label: jobId, private: jobId === "private", paneId: "", workspaceId: "", sessionFile: "",
    model: "cloud/test", thinking: "off", local: false, role: "do", launchedAt: 0,
  };
  const runtime = { getConfig: () => config, state } as HerdRuntime;
  const child = { ...runtime, workerMailbox: { box, jobId: "a" } };
  assert.match((await executeHerd(child, { action: "peers" })).text, /Backend/);
  const sent = await executeHerd(child, { action: "message", jobId: "b", text: "What fields?" });
  assert.equal(sent.details.status, "queued");
  assert.match((await executeHerd(runtime, { action: "messages", run: runId })).text, /a → b/);
  await assert.rejects(executeHerd(child, { action: "peers", run: "another" }), /another run/);
  await assert.rejects(executeHerd(runtime, { action: "message", jobId: "private", text: "hello" }), /private target/);
  await assert.rejects(executeHerd(runtime, { action: "message", jobId: "../bad", text: "hello" }), /Unknown/);
  box.finish("b");
  assert.equal((await executeHerd(child, { action: "message", jobId: "b", text: "Late question" })).details.status, "recipient-finished");
  process.env.PI_HERD_PRIVATE = "1";
  for (const action of ["peers", "message", "messages"]) await assert.rejects(executeHerd(child, { action, jobId: "b", text: "private note" }), /Private workers/);
});

it("slash commands and worker instructions expose messaging without changing authority", () => {
  assert.deepEqual(parseHerdSlashArgs('message jobId=b text="Which fields?"'), { action: "message", jobId: "b", text: "Which fields?" });
  assert.deepEqual(parseHerdSlashArgs('messages run=demo'), { action: "messages", run: "demo" });
  assert.deepEqual(parseHerdSlashArgs('peers'), { action: "peers" });
  for (const path of [".mailboxes/overwrite.json", "./.mailboxes/overwrite.json", ".//.mailboxes/overwrite.json"]) {
    assert.throws(() => assertOutputName(path), /reserved/);
  }
  const kick = buildHandoffKick({ task: "Implement frontend", runDir: "/run", reads: [], readOnly: false, messaging: true });
  assert.match(kick, /herd peers/);
  assert.match(kick, /advisory/);
  const privateKick = buildHandoffKick({ task: "Count records", runDir: "/run", reads: [], private: true, messaging: true });
  assert.ok(!privateKick.includes("herd peers"));
});
