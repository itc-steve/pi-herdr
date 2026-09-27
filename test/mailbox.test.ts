import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailbox, openMailbox, MAX_MESSAGES, MAX_MESSAGE_BYTES } from "../src/herd/mailbox.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "herd-mail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const box = createMailbox(join(dir, "run"));
  box.register("frontend", "Frontend");
  box.register("backend", "Backend");
  box.activate("frontend");
  box.activate("backend");
  return { dir, box };
}

it("independent clients exchange intact messages and acknowledge only actual delivery", (t) => {
  const { box } = fixture(t);
  const receiver = openMailbox(box.dir);
  const body = "Which shape?\n```json\n{\"theme\": \"dark\"}\n```\n✓";
  const sent = box.send("frontend", "backend", body);
  assert.equal(sent.status, "queued");
  assert.equal(receiver.pending("backend")[0]?.text, body);
  assert.throws(() => receiver.acknowledge(sent.id, "frontend"), /recipient/);
  receiver.acknowledge(sent.id, "backend");
  assert.equal(box.messages()[0]?.status, "delivered");
  assert.equal(receiver.pending("backend").length, 0);
  assert.equal(statSync(box.dir).mode & 0o777, 0o700);
  const file = readdirSync(join(box.dir, "messages"))[0]!;
  assert.equal(statSync(join(box.dir, "messages", file)).mode & 0o777, 0o600);
});

it("late messages stay visible but cannot reopen finished recipients", (t) => {
  const { box } = fixture(t);
  box.send("frontend", "backend", "Pending question");
  box.finish("backend");
  const late = box.send("frontend", "backend", "Too late");
  assert.equal(late.status, "recipient-finished");
  assert.equal(box.messages().every((m) => m.status === "recipient-finished"), true);
  assert.equal(box.activate("backend"), false);
  assert.equal(box.pending("backend").length, 0);
  assert.throws(() => box.send("backend", "frontend", "Revive me"), /active/);
});

it("scopes peers and logs, rejects unknown/booting recipients and unsafe input", (t) => {
  const { dir, box } = fixture(t);
  const other = createMailbox(join(dir, "other-run"));
  other.register("outsider", "Other run");
  other.activate("outsider");
  box.register("queued", "Not started");
  assert.throws(() => box.send("frontend", "outsider", "hello"), /Unknown/);
  assert.throws(() => box.send("frontend", "queued", "hello"), /not active/);
  assert.throws(() => box.register("../escape", "bad"), /Invalid/);
  assert.throws(() => box.send("frontend", "backend", " "), /empty/);
  assert.throws(() => box.send("frontend", "backend", "é".repeat(MAX_MESSAGE_BYTES)), /bytes/);
  assert.throws(() => box.send("frontend", "backend", "[PRIVATE:withheld]"), /private/i);
  assert.throws(() => box.send("frontend", "backend", `ghp_${"Q".repeat(36)}`), /private/i);
  box.send("parent", "backend", "Parent note");
  assert.equal(box.messages("frontend").length, 0);
  assert.equal(box.messages("backend").length, 1);
});

it("caps worker chatter and closes all admission on parent shutdown", (t) => {
  const { box } = fixture(t);
  for (let i = 0; i < MAX_MESSAGES; i++) box.send("frontend", "backend", `Note ${i}`);
  assert.throws(() => box.send("frontend", "backend", "one more"), /budget/);
  box.close();
  assert.equal(box.isFinished("backend"), true);
  assert.equal(box.pending("backend").length, 0);
  assert.throws(() => box.send("parent", "backend", "after reload"), /closed/);
});

it("rejects malformed mailbox files instead of injecting them", (t) => {
  const { box } = fixture(t);
  const message = box.send("frontend", "backend", "hello");
  writeFileSync(join(box.dir, "messages", `${message.id}.json`), JSON.stringify({ ...message, text: 42 }));
  assert.throws(() => box.pending("backend"), /Invalid mailbox/);
});
