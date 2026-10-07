import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMailbox } from "../src/herd/mailbox.ts";
import { bindWorkerMailbox } from "../src/herd/mailbox-worker.ts";

it("injects at turn boundaries, acknowledges context entry, never wakes/reopens a finished job", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herd-worker-mail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const box = createMailbox(join(root, "mail"));
  box.register("a", "Sender"); box.register("b", "Recipient"); box.activate("a");
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = { on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); } } as unknown as ExtensionAPI;
  const worker = bindWorkerMailbox(pi, { box, jobId: "b" });
  const ctx = { isIdle: () => false };
  await handlers.get("agent_start")!({}, ctx);
  const question = box.send("a", "b", "What fields?");
  assert.equal(sent.length, 0);
  await handlers.get("turn_end")!({}, ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.options, { deliverAs: "steer", triggerTurn: true });
  assert.match(sent[0]!.message.content, /What fields\?/);
  assert.match(sent[0]!.message.content, /advisory/i);
  assert.equal(box.messages()[0]!.status, "queued");
  await handlers.get("turn_end")!({}, ctx);
  assert.equal(sent.length, 1, "no duplicate while awaiting native queue delivery");
  await handlers.get("message_end")!({ message: { role: "custom", ...sent[0]!.message } }, ctx);
  assert.equal(box.messages()[0]!.status, "delivered");
  assert.equal(question.id, box.messages()[0]!.id);
  const aborted = box.send("a", "b", "New question");
  await handlers.get("turn_end")!({}, { ...ctx, signal: AbortSignal.abort() });
  assert.equal(sent.length, 1);
  await handlers.get("agent_settled")!({}, ctx);
  assert.equal(box.messages().find((m) => m.id === aborted.id)!.status, "recipient-finished");
  await handlers.get("agent_start")!({}, ctx);
  await handlers.get("turn_end")!({}, ctx);
  assert.equal(sent.length, 1);
  assert.equal(box.isFinished("b"), true);
  worker!.dispose(); worker!.dispose();
});

it("private workers cannot bind a mailbox even when identity is supplied", (t) => {
  const old = process.env.PI_HERD_PRIVATE;
  t.after(() => { if (old === undefined) delete process.env.PI_HERD_PRIVATE; else process.env.PI_HERD_PRIVATE = old; });
  process.env.PI_HERD_PRIVATE = "1";
  assert.equal(bindWorkerMailbox({ on: () => assert.fail("private worker registered receiver") } as unknown as ExtensionAPI), undefined);
});
