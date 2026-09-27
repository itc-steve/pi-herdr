import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasPrivateMarker, redactForCloud } from "../private.ts";

export const MAX_MESSAGE_BYTES = 4_096;
export const MAX_MESSAGES = 20;
export type MailStatus = "queued" | "delivered" | "recipient-finished";
export type MailMessage = { id: string; from: string; to: string; text: string; status: MailStatus };
export type MailPeer = { id: string; label: string; status: "booting" | "active" | "finished" };

function validId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(id);
}
function assertId(id: string): string {
  if (!validId(id)) throw new Error("Invalid mailbox identifier");
  return id;
}
function validateText(text: string): void {
  if (typeof text !== "string" || !text.trim()) throw new Error("Message is empty");
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error(`Message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  // Defence in depth, not PII containment. Private helpers never join this transport.
  if (hasPrivateMarker(text) || redactForCloud(text).count) throw new Error("Private content cannot be sent through peer mailboxes");
}
function readRecord(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 32_768) throw new Error("Invalid mailbox record");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Invalid mailbox record"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mailbox record");
  return value as Record<string, unknown>;
}
function atomicWrite(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function createMailbox(dir: string): Mailbox {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["peers", "messages", "receipts"]) mkdirSync(join(dir, name), { mode: 0o700 });
  return openMailbox(dir);
}

/** One parent-session namespace per run. Files survive shutdown for inspection, not resume. */
export function openMailbox(dir: string) {
  const peerPath = (id: string, suffix = "json") => join(dir, "peers", `${assertId(id)}.${suffix}`);
  const messagePath = (id: string) => join(dir, "messages", `${assertId(id)}.json`);
  const receiptPath = (id: string) => join(dir, "receipts", assertId(id));
  const closed = () => existsSync(join(dir, "closed"));
  const isFinished = (id: string) => closed() || existsSync(peerPath(id, "closed"));
  function peer(id: string): MailPeer {
    if (!existsSync(peerPath(id))) throw new Error(`Unknown mailbox peer '${id}' in this run`);
    const data = readRecord(peerPath(id));
    if (data.id !== id || typeof data.label !== "string" || data.label.length > 240) throw new Error("Invalid mailbox peer");
    return { id, label: data.label, status: isFinished(id) ? "finished" : existsSync(peerPath(id, "active")) ? "active" : "booting" };
  }
  function readMessage(id: string): MailMessage {
    const m = readRecord(messagePath(id));
    if (m.id !== id || !validId(m.from) || !validId(m.to) || typeof m.text !== "string") throw new Error("Invalid mailbox message");
    validateText(m.text);
    if (m.from !== "parent") peer(m.from);
    peer(m.to);
    return { id, from: m.from, to: m.to, text: m.text, status: existsSync(receiptPath(id)) ? "delivered" : isFinished(m.to) ? "recipient-finished" : "queued" };
  }
  // ponytail: scan a small run log; 20 outgoing messages/worker. Index only if large herds make this measurable.
  function messages(viewer?: string): MailMessage[] {
    return readdirSync(join(dir, "messages")).filter((f) => f.endsWith(".json")).sort()
      .map((f) => readMessage(f.slice(0, -5)))
      .filter((m) => !viewer || m.from === viewer || m.to === viewer);
  }
  return {
    dir, peer, isFinished, messages,
    peers: () => readdirSync(join(dir, "peers")).filter((f) => f.endsWith(".json")).sort().map((f) => peer(f.slice(0, -5))),
    register(id: string, label: string) {
      if (closed()) throw new Error("Mailbox session is closed");
      if (id === "parent") throw new Error("Invalid mailbox peer: parent is reserved");
      validateText(label);
      if (existsSync(peerPath(id))) throw new Error("Mailbox peer already registered");
      // Registration has one writer (the parent); readers must never see partial JSON.
      atomicWrite(peerPath(id), { id, label: label.slice(0, 240) });
    },
    activate(id: string): boolean {
      if (peer(id).status === "finished") return false;
      atomicWrite(peerPath(id, "active"), true);
      return !isFinished(id);
    },
    finish(id: string) { peer(id); atomicWrite(peerPath(id, "closed"), true); },
    close() { atomicWrite(join(dir, "closed"), true); },
    send(from: string, to: string, text: string): MailMessage {
      if (closed()) throw new Error("Mailbox session is closed");
      validateText(text);
      if (from !== "parent" && peer(from).status !== "active") throw new Error("Only active workers can send messages");
      if (from === to) throw new Error("Cannot message yourself");
      if (peer(to).status === "booting") throw new Error("Recipient is not active; report the blocker to the parent instead of waiting");
      if (from !== "parent" && messages(from).filter((m) => m.from === from).length >= MAX_MESSAGES) throw new Error(`Worker message budget (${MAX_MESSAGES}) exhausted; report blockers to the parent`);
      const id = `${Date.now()}-${randomUUID()}`;
      atomicWrite(messagePath(id), { id, from, to, text });
      return readMessage(id);
    },
    pending(id: string): MailMessage[] {
      if (peer(id).status !== "active") return [];
      return messages(id).filter((m) => m.to === id && m.status === "queued");
    },
    acknowledge(id: string, recipient: string) {
      if (readMessage(id).to !== recipient) throw new Error("Wrong message recipient");
      atomicWrite(receiptPath(id), true);
    },
  };
}
export type Mailbox = ReturnType<typeof openMailbox>;

export function formatMessages(messages: MailMessage[]): string {
  if (!messages.length) return "No mailbox messages.";
  return messages.slice(-20).map((m) => `[${m.status}] ${m.from} → ${m.to}\n${m.text}`).join("\n\n");
}
