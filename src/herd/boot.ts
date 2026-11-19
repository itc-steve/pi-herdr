/**
 * Boot / submit / wait / collect for herd jobs in Herdr panes.
 * Constants and ACK logic ported from v1 (battle-tested against starship + Enter drop).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentStatus, PaneInfo } from "../types.ts";
import {
  agentDisplayName,
  normalizeStatus,
  paneHasAgent,
  type HerdrClient,
  type TuiClient,
} from "../herdr/client.ts";
import {
  collectFromSessionFile,
  countSessionEntries,
  extractFromScrollback,
  hasUserMessageAfter,
  getNewEntries,
  type MessageEntry,
} from "../readback.ts";
import { ensureOutputFile } from "../handoff.ts";
import type { CoreClient, CorePane, CoreWorkerOptions } from "../herdr/core.ts";
import { JobCleanupError } from "./queue.ts";

type WorkerPane = PaneInfo | CorePane;

function assertWorkerLive(pane: WorkerPane): void {
  if ("state" in pane && pane.state === "finished") throw new Error(`Worker terminal ${pane.pane_id} finished before completion.`);
  if ("reported_status" in pane && pane.reported_status === "error") throw new Error(`Worker terminal ${pane.pane_id} reported native error.`);
}

/** Reconcile an uncertain run once; absence cannot prove a pending create failed. */
export async function cleanupCoreWorkers(opts: {
  herdr: CoreClient;
  jobLabel: string;
  onRecovered: (paneId: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    const terminals = await opts.herdr.findWorkerTerminals(opts.jobLabel, opts.signal);
    if (!terminals.length) throw new Error("No matching terminal; creation may still be pending");
    for (const terminal of terminals) opts.onRecovered(terminal.address);
    for (const terminal of terminals) await opts.herdr.closePane(terminal.address, opts.signal);
  } catch (error) {
    throw new JobCleanupError(`Core worker cleanup unconfirmed for ${opts.jobLabel}: ${error instanceof Error ? error.message : String(error)}. Capacity and lanes remain held; reconcile with herd close.`);
  }
}

export const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
export const DEFAULT_DISPATCH_TIMEOUT_MS = 600_000;
export const POLL_MS = 400;
export const SHELL_READY_TIMEOUT_MS = 45_000;
export const SHELL_SETTLE_MS = 600;
export const AGENT_READY_SETTLE_MS = 700;
export const AGENT_QUIT_TIMEOUT_MS = 30_000;
export const AGENT_GONE_POLL_MS = 300;
export const POST_SUBMIT_ENTER_RETRY_MS = 700;
/** First Enter nudge. */
export const POST_SUBMIT_ENTER_RETRY_MS_2 = 1_600;
export const POST_SUBMIT_CONFIRM_MS = 4_500;
export const POST_SUBMIT_GRACE_MS = 2_500;
export const OUTPUT_SETTLE_POLL_MS = 500;

export type JobHandle = {
  jobId: string;
  label: string;
  paneId: string;
  workspaceId?: string;
  sessionFile: string;
  watermark: number;
  taskPreview: string;
  runId?: string;
  outputPath?: string;
  outputBaselineBytes?: number;
  owns?: string[];
  forbid?: string[];
  model: string;
  thinking: string;
  local: boolean;
  role: string;
  /** Private (secret-dependent) local do worker. */
  private?: boolean;
};

export type PaneStatusHandler = (status: AgentStatus) => void;

function statusObserver(onStatus?: PaneStatusHandler): PaneStatusHandler {
  let previous: AgentStatus | undefined;
  return (status) => {
    if (status !== previous) {
      previous = status;
      onStatus?.(status);
    }
  };
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.message === "Aborted") ||
    (typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name?: string }).name === "AbortError")
  );
}

function looksLikeTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|deadline/i.test(msg);
}

function deadlineSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function outputFileBytes(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function isOutputReady(path: string, baselineBytes?: number): boolean {
  const size = outputFileBytes(path);
  if (size === 0) return false;
  // Unchanged size is still pending. Shorter overwrite (spec → summary) is done.
  if (baselineBytes != null && baselineBytes > 0 && size === baselineBytes) {
    return false;
  }
  try {
    return readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export function scrollbackLooksLikeShellPrompt(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/u, ""))
    .filter((l) => l.length > 0);
  if (!lines.length) return false;
  const last = lines[lines.length - 1]!;
  if (/[❯➜›»]/.test(last)) return true;
  if (/[\s~]>$/.test(last)) return true;
  if (/[$%#]$/.test(last)) return true;
  return false;
}

export async function waitForShellReady(
  herdr: TuiClient,
  paneId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const budget = Math.max(1_000, Math.min(timeoutMs, SHELL_READY_TIMEOUT_MS));
  const deadline = Date.now() + budget;

  let last = await herdr.readPane(
    paneId,
    { source: "recent-unwrapped", lines: 80 },
    signal,
  );
  let stableAt: number | null = scrollbackLooksLikeShellPrompt(last)
    ? Date.now()
    : null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");

    const text = await herdr.readPane(
      paneId,
      { source: "recent-unwrapped", lines: 80 },
      signal,
    );

    if (text !== last) {
      last = text;
      stableAt = scrollbackLooksLikeShellPrompt(text) ? Date.now() : null;
    } else if (
      scrollbackLooksLikeShellPrompt(text) &&
      stableAt != null &&
      Date.now() - stableAt >= SHELL_SETTLE_MS
    ) {
      return;
    }

    await sleep(POLL_MS, signal);
  }

  throw new Error(
    `Timed out waiting for shell prompt in pane ${paneId} before boot. ` +
      `New tabs need the shell (and any banner) to finish before \`pi\` is launched.`,
  );
}

function isAgentAcceptingInput(status: string): boolean {
  return status === "idle" || status === "done";
}

async function waitUntilAgentDetected(
  herdr: HerdrClient,
  paneId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onStatus?: PaneStatusHandler,
): Promise<WorkerPane> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let last: WorkerPane | null = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    last = await herdr.getPaneInfo(paneId, signal);
    if (!last) throw new Error(`Pane ${paneId} disappeared during boot`);
    assertWorkerLive(last);
    onStatus?.(normalizeStatus(last.agent_status));
    if (paneHasAgent(last)) return last;
    await sleep(POLL_MS, signal);
  }
  const status = last ? normalizeStatus(last.agent_status) : "unknown";
  throw new Error(
    `Timed out waiting for pi agent in pane ${paneId} (last status=${status}).`,
  );
}

export async function waitUntilAgentReady(
  herdr: HerdrClient,
  paneId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onStatus?: PaneStatusHandler,
): Promise<WorkerPane> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  if (herdr.kind === "core") signal = deadlineSignal(timeoutMs, signal);
  const remaining = () => Math.max(1, deadline - Date.now());

  const observe = statusObserver(onStatus);
  await waitUntilAgentDetected(herdr, paneId, remaining(), signal, observe);

  let useNativeWait = "waitAgentStatus" in herdr;
  let last: WorkerPane | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    last = await herdr.getPaneInfo(paneId, signal);
    if (!last) throw new Error(`Pane ${paneId} disappeared during boot`);
    assertWorkerLive(last);
    const status = normalizeStatus(last.agent_status);
    observe(status);
    if (!paneHasAgent(last)) {
      await sleep(POLL_MS, signal);
      continue;
    }
    if (isAgentAcceptingInput(status)) {
      await sleep(AGENT_READY_SETTLE_MS, signal);
      const settled = await herdr.getPaneInfo(paneId, signal);
      if (settled) assertWorkerLive(settled);
      if (!settled || !paneHasAgent(settled)) continue;
      observe(normalizeStatus(settled.agent_status));
      if (isAgentAcceptingInput(normalizeStatus(settled.agent_status))) {
        if (herdr.kind === "core") {
          signal?.throwIfAborted();
          if (Date.now() >= deadline) break;
        }
        return settled;
      }
      continue;
    }

    if (useNativeWait && "waitAgentStatus" in herdr) {
      try {
        await herdr.waitAgentStatus(paneId, "idle", Math.min(POLL_MS, remaining()), signal);
        continue;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err;
        if (looksLikeTimeoutError(err)) continue;
        useNativeWait = false;
      }
    }

    await sleep(POLL_MS, signal);
  }

  const status = last ? normalizeStatus(last.agent_status) : "unknown";
  throw new Error(
    `Timed out waiting for pi agent ready in pane ${paneId} (last status=${status}).`,
  );
}

export async function bootIntoPane(opts: {
  herdr: TuiClient;
  paneId: string;
  bootCmd: string;
  sessionFile: string;
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStatus?: PaneStatusHandler;
}): Promise<WorkerPane> {
  mkdirSync(dirname(opts.sessionFile), { recursive: true });
  try {
    await opts.herdr.renamePane(opts.paneId, opts.label, opts.signal);
  } catch {
    // optional
  }
  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const remaining = () => Math.max(1, deadline - Date.now());

  await waitForShellReady(opts.herdr, opts.paneId, remaining(), opts.signal);
  await opts.herdr.runInPane(opts.paneId, opts.bootCmd, opts.signal);
  return waitUntilAgentReady(opts.herdr, opts.paneId, remaining(), opts.signal, opts.onStatus);
}

/** Create a labeled tab (--no-focus) in the current workspace and boot pi. */
export async function createAndBootJob(opts: {
  herdr: HerdrClient;
  label: string;
  cwd: string;
  bootCmd: string;
  coreLaunch?: Omit<CoreWorkerOptions, "cwd" | "label">;
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onPaneCreated?: (paneId: string, workspaceId?: string) => void;
  onStatus?: PaneStatusHandler;
}): Promise<{ paneId: string; workspaceId?: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  if (opts.herdr.kind === "core") {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const signal = deadlineSignal(timeoutMs, opts.signal);
    if (!opts.coreLaunch) throw new Error("Core boot requires structured worker argv/env/jobLabel");
    mkdirSync(dirname(opts.sessionFile), { recursive: true });
    const terminal = await opts.herdr.createWorkerTerminal({ ...opts.coreLaunch, cwd: opts.cwd, label: opts.label }, signal);
    opts.onPaneCreated?.(terminal.address);
    signal.throwIfAborted();
    await waitUntilAgentReady(opts.herdr, terminal.address, Math.max(1, deadline - Date.now()), signal, opts.onStatus);
    signal.throwIfAborted();
    return { paneId: terminal.address };
  }
  const currentPane = await opts.herdr.getCurrentPaneInfo(opts.signal);
  const workspaceId = currentPane.workspace_id;
  // Always a new tab: two-word labels collide, so reuse-by-name would steal a live worker.
  const created = await opts.herdr.createTab(
    { workspaceId, label: opts.label, cwd: opts.cwd },
    opts.signal,
  );
  const paneId = created.paneId;

  opts.onPaneCreated?.(paneId, workspaceId);
  await bootIntoPane({
    herdr: opts.herdr,
    paneId,
    bootCmd: opts.bootCmd,
    sessionFile: opts.sessionFile,
    label: opts.label,
    timeoutMs,
    signal: opts.signal,
    onStatus: opts.onStatus,
  });

  return { paneId, workspaceId };
}

export async function stopAgentInPane(opts: {
  herdr: HerdrClient;
  paneId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? AGENT_QUIT_TIMEOUT_MS;
  if (opts.herdr.kind === "core") {
    const signal = deadlineSignal(timeoutMs, opts.signal);
    const pane = await opts.herdr.getPaneInfo(opts.paneId, signal);
    signal.throwIfAborted();
    // OSC app reports are optional metadata, not native process liveness.
    if (pane && pane.state === "live") await opts.herdr.closePane(opts.paneId, signal);
    signal.throwIfAborted();
    return;
  }
  const deadline = Date.now() + Math.max(1, timeoutMs);

  let pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
  if (!paneHasAgent(pane)) return;
  if (normalizeStatus(pane?.agent_status) === "blocked") {
    throw new Error(`Pane ${opts.paneId} is blocked; close it without answering its prompt.`);
  }

  try {
    await opts.herdr.runInPane(opts.paneId, "/quit", opts.signal);
  } catch {
    // continue
  }

  let resent = false;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Aborted");
    pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
    if (!paneHasAgent(pane)) return;
    if (normalizeStatus(pane?.agent_status) === "blocked") {
      throw new Error(`Pane ${opts.paneId} is blocked; close it without answering its prompt.`);
    }
    if (!resent && Date.now() >= deadline - timeoutMs / 2) {
      resent = true;
      try {
        await opts.herdr.runInPane(opts.paneId, "/quit", opts.signal);
      } catch {
        // ignore
      }
    }
    await sleep(AGENT_GONE_POLL_MS, opts.signal);
  }

  throw new Error(
    `Timed out waiting for agent to quit in pane ${opts.paneId} after /quit.`,
  );
}

/**
 * Submit via pane-run; confirm with working status OR a real user message.
 * Extension noise (model_change, caveman custom, …) must NOT count as ACK —
 * that falsely skipped Enter and left the kick sitting in the Pi editor.
 */
export async function submitTaskToPane(opts: {
  herdr: HerdrClient;
  paneId: string;
  task: string;
  sessionFile?: string;
  watermark?: number;
  signal?: AbortSignal;
}): Promise<{ nudgedEnter: boolean }> {
  if (opts.herdr.kind === "core") {
    opts = { ...opts, signal: deadlineSignal(AGENT_READY_SETTLE_MS + POST_SUBMIT_CONFIRM_MS, opts.signal) };
  }
  // Settle briefly so footer/extensions finish writing JSONL before we snapshot.
  await sleep(AGENT_READY_SETTLE_MS, opts.signal);

  // Always re-read after settle — spawn's pre-settle watermark is too early
  // (caveman/model custom events would look like submit evidence).
  const watermark = opts.sessionFile
    ? countSessionEntries(opts.sessionFile)
    : 0;

  await opts.herdr.runInPane(opts.paneId, opts.task, opts.signal);

  const started = Date.now();
  const deadline = started + POST_SUBMIT_CONFIRM_MS;
  let nudgedEnter = false;
  let nudgedEnterTwice = false;

  const kickLanded = async (): Promise<boolean> => {
    const pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
    if (!pane) throw new Error(`Pane ${opts.paneId} disappeared after submit`);
    assertWorkerLive(pane);
    const status = normalizeStatus(pane.agent_status);
    if (status === "working" || status === "blocked") return true;
    if (opts.sessionFile && hasUserMessageAfter(opts.sessionFile, watermark)) {
      return true;
    }
    return false;
  };

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Aborted");

    if (await kickLanded()) {
      if (opts.herdr.kind === "core") opts.signal?.throwIfAborted();
      return { nudgedEnter: nudgedEnter || nudgedEnterTwice };
    }

    const pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
    const status = pane ? normalizeStatus(pane.agent_status) : "unknown";
    const elapsed = Date.now() - started;

    // Nudge Enter when idle/done, and also on "unknown" — status detection can
    // lag right after boot under parallel spawns, leaving the kick in the editor.
    const mayNeedEnter = opts.herdr.kind !== "core" &&
      (isAgentAcceptingInput(status) || status === "unknown");
    if (
      !nudgedEnter &&
      elapsed >= POST_SUBMIT_ENTER_RETRY_MS &&
      mayNeedEnter
    ) {
      await opts.herdr.sendKeys(opts.paneId, ["Enter"], opts.signal);
      nudgedEnter = true;
    } else if (
      nudgedEnter &&
      !nudgedEnterTwice &&
      elapsed >= POST_SUBMIT_ENTER_RETRY_MS_2 &&
      mayNeedEnter
    ) {
      // Second Enter: first may only insert a blank line after a trailing newline.
      await opts.herdr.sendKeys(opts.paneId, ["Enter"], opts.signal);
      nudgedEnterTwice = true;
    }

    await sleep(POLL_MS, opts.signal);
  }

  throw new Error(
    `Task submit to pane ${opts.paneId} was not confirmed ` +
      `(agent never went working and no user message after watermark=${watermark}` +
      (nudgedEnter ? "; Enter nudged" : "") +
      (nudgedEnterTwice ? " twice" : "") +
      `). Kick may still be sitting in the Pi editor — press Enter manually or re-spawn.`,
  );
}

export async function waitForJobIdle(opts: {
  herdr: HerdrClient;
  paneId: string;
  timeoutMs?: number;
  allowIdleWithoutBusy?: boolean;
  sessionFile?: string;
  watermark?: number;
  outputPath?: string;
  outputBaselineBytes?: number;
  /** Pi must close reception before we release this worker's lanes/capacity. */
  mailboxFinished?: () => boolean;
  signal?: AbortSignal;
  onStatus?: PaneStatusHandler;
}): Promise<{ status: string; sawBusy: boolean }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  let deadline = Date.now() + timeoutMs;
  let sawBusy = false;
  const started = Date.now();
  const observe = statusObserver(opts.onStatus);
  let useNativeWait = "waitAgentStatus" in opts.herdr;
  let signal = opts.signal;

  function hasPostSubmitEvidence(): boolean {
    if (
      opts.outputPath &&
      isOutputReady(opts.outputPath, opts.outputBaselineBytes)
    ) {
      return true;
    }
    if (opts.sessionFile) {
      // User kick must land before we treat idle as "done" without sawBusy.
      if (hasUserMessageAfter(opts.sessionFile, opts.watermark ?? 0)) {
        return true;
      }
    }
    return false;
  }

  function assertSessionSucceeded(): void {
    if (!opts.sessionFile) return;
    let entries;
    try {
      entries = getNewEntries(opts.sessionFile, opts.watermark ?? 0);
    } catch {
      return; // Session may be absent or its final JSONL line still in flight.
    }
    const last = entries.findLast(entry =>
      entry.type === "message" && (entry as MessageEntry).message?.role === "assistant",
    ) as MessageEntry | undefined;
    const reason = last?.message.stopReason;
    if (reason === "aborted" || reason === "error") {
      const error = new Error(`Worker in pane ${opts.paneId} ended with stopReason=${reason}.`);
      if (reason === "aborted") error.name = "AbortError";
      throw error;
    }
  }

  // Stall clock, not job wall-clock: only working slides it, not user prompts.
  // A 10min local review must not free the GPU seat under itself.
  while (true) {
    if (opts.herdr.kind === "core") signal = deadlineSignal(deadline - Date.now(), opts.signal);
    if (signal?.aborted) throw new Error("Aborted");

    const pane = await opts.herdr.getPaneInfo(opts.paneId, signal);
    if (opts.herdr.kind === "core") {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) break;
    }
    if (!pane) throw new Error(`Pane ${opts.paneId} disappeared while waiting`);
    assertWorkerLive(pane);

    const status = normalizeStatus(pane.agent_status);
    observe(status);
    if (status === "working" || status === "blocked") sawBusy = true;
    if (status === "working") {
      deadline = Date.now() + timeoutMs;
      if (opts.herdr.kind === "core") signal = deadlineSignal(timeoutMs, opts.signal);
    }

    if (status === "idle" || status === "done") {
      const elapsed = Date.now() - started;
      const statusReady =
        sawBusy ||
        (opts.allowIdleWithoutBusy === true &&
          elapsed >= POST_SUBMIT_GRACE_MS &&
          hasPostSubmitEvidence());

      if (statusReady) {
        if (opts.mailboxFinished && !opts.mailboxFinished()) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(POLL_MS, remaining), signal);
          continue;
        }
        assertSessionSucceeded();
        if (
          opts.outputPath &&
          !isOutputReady(opts.outputPath, opts.outputBaselineBytes)
        ) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(OUTPUT_SETTLE_POLL_MS, remaining), signal);
          continue;
        }
        return { status, sawBusy };
      }
    }

    if (Date.now() >= deadline) break;

    const remaining = deadline - Date.now();
    if (
      useNativeWait && "waitAgentStatus" in opts.herdr &&
      (status === "working" || status === "blocked" || status === "unknown")
    ) {
      try {
        await opts.herdr.waitAgentStatus(
          opts.paneId,
          "idle",
          Math.min(POLL_MS, remaining),
          signal,
        );
        continue;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err;
        if (looksLikeTimeoutError(err)) {
          // Re-check pane. Still-working slides the deadline next iteration.
          continue;
        }
        useNativeWait = false;
      }
    }

    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal);
  }

  // Core's stall deadline also bounds the final IPC; never accept a late idle.
  if (opts.herdr.kind === "core") throw new Error(`Timed out waiting for pane ${opts.paneId} to finish.`);
  const pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
  if (pane) assertWorkerLive(pane);
  const last = pane ? normalizeStatus(pane.agent_status) : "unknown";
  observe(last);

  if (
    (last === "idle" || last === "done") &&
    (sawBusy || (opts.allowIdleWithoutBusy && hasPostSubmitEvidence())) &&
    (!opts.mailboxFinished || opts.mailboxFinished())
  ) {
    assertSessionSucceeded();
    if (
      opts.outputPath &&
      !isOutputReady(opts.outputPath, opts.outputBaselineBytes)
    ) {
      throw new Error(
        `Pane ${opts.paneId} is ${last} but output file is empty/unchanged: ${opts.outputPath}`,
      );
    }
    return { status: last, sawBusy };
  }

  throw new Error(
    `Timed out waiting for pane ${opts.paneId} to finish (last status=${last}, sawBusy=${sawBusy}).`,
  );
}

export async function collectReply(opts: {
  herdr: HerdrClient;
  handle: JobHandle;
  signal?: AbortSignal;
  /** Idempotent redaction chokepoint (cloud parent); identity when omitted. */
  sanitize?: (text: string) => string;
}): Promise<{ reply: string; source: "session" | "scrollback" }> {
  const { herdr, handle, signal, sanitize } = opts;

  const sessionGrew =
    countSessionEntries(handle.sessionFile) > handle.watermark;

  let reply: string | null = collectFromSessionFile(
    handle.sessionFile,
    handle.watermark,
  );
  let source: "session" | "scrollback" = "session";

  if (!reply) {
    if (!sessionGrew && !handle.outputPath) {
      throw new Error(
        `No reply collected for '${handle.jobId}' yet (session watermark=${handle.watermark}).`,
      );
    }
    const text = await herdr.readPane(
      handle.paneId,
      herdr.kind === "core" ? { lines: 200 } : { source: "recent-unwrapped", lines: 200 },
      signal,
    );
    reply = extractFromScrollback(text);
    source = "scrollback";
  }

  if (!reply) {
    throw new Error(
      `No reply collected for '${handle.jobId}' yet (session watermark=${handle.watermark}).`,
    );
  }

  if (sanitize && reply) reply = sanitize(reply);

  if (handle.outputPath) {
    try {
      const existing = existsSync(handle.outputPath)
        ? readFileSync(handle.outputPath, "utf8").trim()
        : "";
      if (!existing) {
        ensureOutputFile(handle.outputPath);
        writeFileSync(handle.outputPath, reply);
      }
    } catch {
      // non-fatal
    }
  }

  return { reply, source };
}

export function taskPreview(task: string, max = 120): string {
  const one = task.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Herdr tab/pane title: two words (task or role). */
export function shortTabLabel(text: string, fallback = "job"): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.join(" ") || fallback;
}

export function formatHerdResultMessage(opts: {
  jobId: string;
  label: string;
  status: "done" | "failed" | "aborted";
  role: string;
  model: string;
  thinking: string;
  taskPreview: string;
  runId?: string;
  outputPath?: string;
  owns?: string[];
  reply?: string;
  error?: string;
  /** pointer (default): no full reply paste when output exists. full: include reply. */
  resultDelivery?: "pointer" | "full";
}): string {
  const delivery = opts.resultDelivery ?? "pointer";
  const lines = [
    `Herd ${opts.jobId} (${opts.label}) ${opts.status}`,
    `model=${opts.model}:${opts.thinking}`,
    `task: ${opts.taskPreview}`,
  ];
  if (opts.runId) lines.push(`run: ${opts.runId}`);
  if (opts.outputPath) {
    lines.push(`output: ${opts.outputPath}`);
    if (delivery === "pointer") {
      lines.push(
        "Artifact on disk — read the file if needed; do not re-derive or reassess the whole task.",
      );
    }
  }
  if (opts.owns?.length) lines.push(`owns: ${opts.owns.join(", ")}`);

  const includeReply =
    Boolean(opts.reply) &&
    (delivery === "full" || !opts.outputPath);
  if (includeReply && opts.reply) {
    const reply =
      opts.reply.length > 4_000
        ? `${opts.reply.slice(0, 4_000)}\n…(truncated)`
        : opts.reply;
    lines.push("", "── reply ──", reply);
  }
  if (opts.error) {
    lines.push("", "── error ──", opts.error);
  }
  return lines.join("\n");
}

void agentDisplayName;
