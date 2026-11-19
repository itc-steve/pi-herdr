import { createConnection } from "node:net";
import { normalizeStatus } from "./client.ts";
import type { AgentStatus } from "../types.ts";

export type CoreTerminal = {
  address: string;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  state: "live" | "finished";
  created_ms: number;
  screen: string;
  cols: number;
  rows: number;
  status?: { state: string; app?: string; title?: string; msg?: string; kind?: string | null; progress?: number | null } | null;
  reason?: string | null;
};
export type CorePane = { pane_id: string; agent?: string; agent_status: AgentStatus; state: "live" | "finished"; reported_status?: string; cwd: string; label?: string };
export type CoreReadOptions = { lines?: number; source?: string; raw?: boolean };
export type CoreRead = { text: string; complete: boolean; how: "screen" | "history" | "stitched"; why?: string | null };
export type CoreWorkerOptions = { argv: string[]; cwd: string; env: Record<string, string>; jobLabel: string; label?: string };

/** Uncertain mutations must be reconciled, never retried or treated as absent. */
export class CoreClientError extends Error {
  method: string;
  kind: string;
  code?: number;
  uncertain: boolean;
  terminalId?: string;
  jobLabel?: string;
  constructor(message: string, method: string, kind: string, uncertain = false, code?: number) {
    super(message);
    this.name = "CoreClientError";
    this.method = method;
    this.kind = kind;
    this.uncertain = uncertain;
    this.code = code;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every(v => typeof v === "string");
}
function natural(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function terminalId(value: unknown): value is string {
  if (typeof value !== "string" || !/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(value)) return false;
  // Core ids are a u32 counter encoded with 30 consonant/digit symbols, not decimal.
  const symbols = "0123456789bcdfghjkmnpqrstvwxyz";
  let rest = Number(value[1]) - 1;
  let before = 0;
  let size = 9;
  for (const digit of value.slice(2)) {
    rest = rest * 30 + symbols.indexOf(digit);
    before += size;
    size *= 30;
    if (before + rest + 1 > 0xffff_ffff) return false;
  }
  return true;
}
function requireId(value: string): void { if (!terminalId(value)) throw new Error("Expected a concrete local core terminal id"); }
function invalid(method: string, message: string): never { throw new CoreClientError(message, method, "invalid_response", method === "terminal.kill" || method === "terminal.rm"); }
function parseTerminal(value: unknown, method: string): CoreTerminal {
  if (!object(value) || !terminalId(value.address) || !strings(value.labels) || !Array.isArray(value.argv) || !value.argv.every(v => typeof v === "string") || typeof value.cwd !== "string" || !["live", "finished"].includes(value.state as string) || !natural(value.created_ms) || typeof value.screen !== "string" || !natural(value.cols) || value.cols > 65535 || !natural(value.rows) || value.rows > 65535) invalid(method, "Invalid core terminal response");
  if (value.reason != null && typeof value.reason !== "string") invalid(method, "Invalid terminal reason");
  if (value.status != null) {
    const status = value.status;
    if (!object(status) || typeof status.state !== "string" || ["app", "title", "msg"].some(k => status[k] !== undefined && typeof status[k] !== "string") || (status.kind != null && typeof status.kind !== "string") || (status.progress != null && !Number.isSafeInteger(status.progress))) invalid(method, "Invalid core terminal status");
  }
  return value as CoreTerminal;
}
function pane(terminal: CoreTerminal): CorePane {
  return {
    pane_id: terminal.address,
    agent: terminal.state === "live" ? terminal.status?.app : undefined,
    agent_status: terminal.state === "live" ? normalizeStatus(terminal.status?.state) : "unknown",
    state: terminal.state,
    reported_status: terminal.status?.state,
    cwd: terminal.cwd,
    label: terminal.labels["ovis.pane"],
  };
}

/** Core 0.1.17 parser spellings, with the supported TUI modifier aliases. */
function coreKey(key: string): string {
  const translated = key.replace(/^(?:[CMS]-)+/, prefix => prefix.replaceAll("C-", "ctrl+").replaceAll("M-", "alt+").replaceAll("S-", "shift+")).toLowerCase();
  const parts = translated.split("+");
  const name = parts.pop()!;
  const named = /^(backslash|backspace|enter|return|space|tab|delete|del|end|home|insert|pagedown|pgdn|pageup|pgup|down|left|right|up|esc|escape|f([1-9]|1[0-2]))$/;
  if (!parts.every(p => ["shift", "ctrl", "control", "alt", "meta", "opt", "super", "cmd"].includes(p)) || !(named.test(name) || /^[a-z0-9`\\\[\],=\-.';/]$/.test(name))) throw new Error(`Unsupported core key: ${key}`);
  return translated;
}

export function createCoreClient(options: { socketPath: string; terminalId: string; timeoutMs?: number }) {
  if (typeof options.socketPath !== "string" || !options.socketPath || options.socketPath.includes("\0")) throw new Error("Explicit core socketPath is required");
  requireId(options.terminalId);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid core deadline");
  const caller = options.terminalId;

  async function request(method: string, params: Record<string, unknown>, signal?: AbortSignal, mutation = false): Promise<unknown> {
    if (signal?.aborted) throw new CoreClientError("Core request aborted", method, "aborted");
    return new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      let text = "";
      let responseBytes = 0;
      const socket = createConnection({ path: options.socketPath });
      const finish = (error?: CoreClientError, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const fail = (message: string, kind: string) => finish(new CoreClientError(message, method, kind, mutation && sent));
      const abort = () => fail("Core request aborted", "aborted");
      const timer = setTimeout(() => fail("Core request deadline exceeded", "deadline"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        if (settled) return;
        sent = true;
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
      });
      socket.on("data", chunk => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > 8 * 1024 * 1024) return fail("Core response exceeds 8 MiB", "invalid_response");
        text += chunk;
        const end = text.indexOf("\n");
        if (end === -1) return;
        let response: unknown;
        try { response = JSON.parse(text.slice(0, end)); }
        catch { return fail("Invalid JSON core response", "invalid_response"); }
        if (!object(response) || response.jsonrpc !== "2.0" || response.id !== 1 || Object.hasOwn(response, "result") === Object.hasOwn(response, "error")) return fail("Invalid core response envelope", "invalid_response");
        if (Object.hasOwn(response, "error")) {
          const error = response.error;
          if (!object(error) || !Number.isInteger(error.code) || typeof error.message !== "string" || !object(error.data) || typeof error.data.kind !== "string") return fail("Invalid core error response", "invalid_response");
          const kind = error.data.kind;
          // 0.1.17 also uses unavailable after persistence: only proven pre-start failures are certain.
          const rejectedRun = method === "terminal.run" && (
            (error.code === -32000 && (
              ["config", "not_found", "machine_unknown", "name_taken", "invalid_template"].includes(kind) ||
              (kind === "unavailable" && (
                error.message === "the core is stopping" || error.message.startsWith("no holder: ") ||
                error.message === "this core has used every terminal id"
              ))
            )) ||
            (error.code === -32602 && kind === "invalid_params") ||
            (error.code === -32601 && kind === "unknown_method") ||
            (error.code === -32600 && kind === "invalid_request") ||
            (error.code === -32700 && kind === "parse_error")
          );
          finish(new CoreClientError(error.message, method, kind, mutation && sent && !rejectedRun, error.code as number));
        } else finish(undefined, response.result);
      });
      socket.once("error", error => fail(error.message, "transport"));
      socket.once("end", () => fail("Core EOF before response", "transport"));
      socket.once("close", () => fail("Core connection closed before response", "transport"));
      if (signal?.aborted) abort();
    });
  }

  async function getTerminal(id: string, signal?: AbortSignal): Promise<CoreTerminal> {
    requireId(id);
    const result = parseTerminal(await request("terminal.get", { terminal: id, caller }, signal), "terminal.get");
    if (result.address !== id) invalid("terminal.get", "Core terminal identity mismatch");
    return result;
  }
  async function getCurrentTerminal(signal?: AbortSignal): Promise<CoreTerminal> { return getTerminal(caller, signal); }
  async function getPaneInfo(id: string, signal?: AbortSignal): Promise<CorePane | null> {
    try { return pane(await getTerminal(id, signal)); }
    catch (error) { if (error instanceof CoreClientError && error.kind === "not_found") return null; throw error; }
  }
  async function listTerminals(filters: { all?: boolean; labels?: Record<string, string> } = {}, signal?: AbortSignal): Promise<CoreTerminal[]> {
    if ((filters.all !== undefined && typeof filters.all !== "boolean") || (filters.labels !== undefined && !strings(filters.labels))) throw new Error("Invalid terminal list filters");
    const result = await request("terminal.list", filters, signal);
    // 0.1.17 omits empty machines despite listing it as required in its generated schema.
    if (!object(result) || !Array.isArray(result.terminals) || !natural(result.hidden_finished) || (result.machines !== undefined && !Array.isArray(result.machines))) invalid("terminal.list", "Invalid terminal list response");
    return result.terminals.map(t => parseTerminal(t, "terminal.list"));
  }
  async function readTerminal(id: string, readOptions: CoreReadOptions = {}, signal?: AbortSignal): Promise<CoreRead> {
    requireId(id);
    if (readOptions.source !== undefined || (readOptions.raw !== undefined && readOptions.raw !== false)) throw new Error("Core read does not support source or raw semantics");
    if (readOptions.lines !== undefined && !natural(readOptions.lines)) throw new Error("Core lines must be nonnegative history lines above the screen");
    const result = await request("terminal.read", { terminal: id, caller, lines: readOptions.lines ?? 0 }, signal);
    if (!object(result) || typeof result.text !== "string" || typeof result.complete !== "boolean" || !["screen", "history", "stitched"].includes(result.how as string) || (result.why != null && typeof result.why !== "string")) invalid("terminal.read", "Invalid terminal read response");
    return result as CoreRead;
  }
  async function readPane(id: string, readOptions: CoreReadOptions = {}, signal?: AbortSignal): Promise<string> { return (await readTerminal(id, readOptions, signal)).text; }
  async function input(method: string, id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    requireId(id);
    const result = await request(method, { terminal: id, caller, ...params }, signal, true);
    if (!object(result) || !natural(result.turn) || (result.status != null && typeof result.status !== "string") || (result.started != null && typeof result.started !== "boolean")) throw new CoreClientError("Invalid core input response", method, "invalid_response", true);
  }
  /** terminal.send already submits Enter; lifecycle callers must not nudge again. */
  async function runInPane(id: string, command: string, signal?: AbortSignal): Promise<void> {
    if (typeof command !== "string") throw new Error("Core command must be text");
    await input("terminal.send", id, { text: command }, signal);
  }
  async function sendKeys(id: string, keys: string[], signal?: AbortSignal): Promise<void> {
    requireId(id);
    if (!Array.isArray(keys) || !keys.every(k => typeof k === "string")) throw new Error("Invalid core keys");
    const translated = keys.map(coreKey);
    if (translated.length) await input("terminal.keys", id, { keys: translated }, signal);
  }
  async function closePane(id: string, signal?: AbortSignal): Promise<void> {
    const terminal = await getTerminal(id, signal);
    if (terminal.state === "live") {
      const killed = parseTerminal(await request("terminal.kill", { terminal: id, caller }, signal, true), "terminal.kill");
      if (killed.address !== id || killed.state !== "finished") invalid("terminal.kill", "Core kill did not confirm target finished");
    }
    const result = await request("terminal.rm", { terminal: id, caller }, signal, true);
    if (!object(result) || result.removed !== id) invalid("terminal.rm", "Core removal did not confirm target");
  }
  async function findWorkerTerminals(jobLabel: string, signal?: AbortSignal): Promise<CoreTerminal[]> {
    if (typeof jobLabel !== "string" || !jobLabel.trim()) throw new Error("Unique worker jobLabel is required");
    const terminals = await listTerminals({ all: true, labels: { "pi-herdr.job": jobLabel } }, signal);
    return terminals.filter(t => t.address !== caller && t.labels["pi-herdr.job"] === jobLabel);
  }
  async function createWorkerTerminal(worker: CoreWorkerOptions, signal?: AbortSignal): Promise<CoreTerminal> {
    if (!Array.isArray(worker.argv) || !worker.argv.length || !worker.argv.every(v => typeof v === "string" && !v.includes("\0")) || !worker.argv[0] || typeof worker.cwd !== "string" || !worker.cwd || worker.cwd.includes("\0") || !strings(worker.env) || Object.entries(worker.env).some(([k, v]) => !k || k.includes("=") || k.includes("\0") || v.includes("\0")) || typeof worker.jobLabel !== "string" || !worker.jobLabel.trim() || (worker.label !== undefined && typeof worker.label !== "string")) throw new Error("Invalid structured core worker launch");
    const parent = await getCurrentTerminal(signal);
    const labels: Record<string, string> = { "pi-herdr.job": worker.jobLabel };
    for (const key of ["herdr.space", "herdr.tab"]) if (Object.hasOwn(parent.labels, key)) labels[key] = parent.labels[key];
    if (worker.label !== undefined) labels["ovis.pane"] = worker.label;
    let result: unknown;
    try {
      result = await request("terminal.run", { caller, parent: caller, argv: worker.argv, cwd: worker.cwd, env: worker.env, labels, no_notify: true, wait: false, keep: false, rm: false }, signal, true);
      const terminal = parseTerminal(result, "terminal.run");
      if (terminal.address === caller) invalid("terminal.run", "Core returned parent identity for worker");
      return terminal;
    } catch (error) {
      if (error instanceof CoreClientError) {
        if (result !== undefined) error.uncertain = true;
        error.jobLabel = worker.jobLabel;
        if (object(result) && terminalId(result.address) && result.address !== caller) error.terminalId = result.address;
      }
      throw error;
    }
  }
  return { kind: "core" as const, getTerminal, getCurrentTerminal, listTerminals, readTerminal, createWorkerTerminal, findWorkerTerminals, getPaneInfo, readPane, runInPane, sendKeys, closePane };
}
export type CoreClient = ReturnType<typeof createCoreClient>;
