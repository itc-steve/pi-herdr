/**
 * Boot / submit / wait / collect for herd jobs in Herdr panes.
 * Constants and ACK logic ported from v1 (battle-tested against starship + Enter drop).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PaneInfo } from "../types.ts";
import {
  agentDisplayName,
  normalizeStatus,
  paneHasAgent,
  type HerdrClient,
} from "../herdr/client.ts";
import {
  collectFromSessionFile,
  countSessionEntries,
  extractFromScrollback,
  hasUserMessageAfter,
} from "../readback.ts";
import { ensureOutputFile } from "../handoff.ts";

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
  workspaceId: string;
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
  difficulty: string;
};

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
  if (baselineBytes != null && baselineBytes > 0) {
    if (size <= baselineBytes) return false;
  } else if (size === 0) {
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
  herdr: HerdrClient,
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
      `New spaces need the shell (and any banner) to finish before \`pi\` is launched.`,
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
): Promise<PaneInfo> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let last: PaneInfo | null = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    last = await herdr.getPaneInfo(paneId, signal);
    if (!last) throw new Error(`Pane ${paneId} disappeared during boot`);
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
): Promise<PaneInfo> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const remaining = () => Math.max(1, deadline - Date.now());

  await waitUntilAgentDetected(herdr, paneId, remaining(), signal);

  let useNativeWait = typeof herdr.waitAgentStatus === "function";
  let last: PaneInfo | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    last = await herdr.getPaneInfo(paneId, signal);
    if (!last) throw new Error(`Pane ${paneId} disappeared during boot`);
    if (!paneHasAgent(last)) {
      await sleep(POLL_MS, signal);
      continue;
    }

    const status = normalizeStatus(last.agent_status);
    if (isAgentAcceptingInput(status)) {
      await sleep(AGENT_READY_SETTLE_MS, signal);
      const settled = await herdr.getPaneInfo(paneId, signal);
      if (!settled || !paneHasAgent(settled)) continue;
      if (isAgentAcceptingInput(normalizeStatus(settled.agent_status))) {
        return settled;
      }
      continue;
    }

    if (useNativeWait) {
      try {
        await herdr.waitAgentStatus(paneId, "idle", remaining(), signal);
        continue;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err;
        if (looksLikeTimeoutError(err)) break;
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
  herdr: HerdrClient;
  paneId: string;
  bootCmd: string;
  sessionFile: string;
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PaneInfo> {
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
  return waitUntilAgentReady(opts.herdr, opts.paneId, remaining(), opts.signal);
}

/**
 * Create a labeled workspace (--no-focus) and boot pi into its root pane.
 */
export async function createAndBootJob(opts: {
  herdr: HerdrClient;
  label: string;
  cwd: string;
  bootCmd: string;
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ paneId: string; workspaceId: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;

  // Reuse existing space with this label if present
  const spaces = await opts.herdr.getWorkspaceList(opts.signal);
  const matches = spaces.filter((w) => (w.label || "").trim() === opts.label);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous workspaces labeled '${opts.label}': ` +
        `${matches.map((w) => w.workspace_id).join(", ")}. Rename or close extras.`,
    );
  }

  let paneId: string;
  let workspaceId: string;

  if (matches[0]) {
    workspaceId = matches[0].workspace_id;
    const panes = await opts.herdr.getPaneList(workspaceId, opts.signal);
    const labeled =
      panes.find((p) => (p.label || "").trim() === opts.label) ?? panes[0];
    if (!labeled) {
      throw new Error(`Workspace '${opts.label}' has no pane`);
    }
    paneId = labeled.pane_id;

    if (paneHasAgent(labeled)) {
      // Quit existing agent so we can boot onto our per-job session
      await stopAgentInPane({
        herdr: opts.herdr,
        paneId,
        signal: opts.signal,
      });
    }
  } else {
    const created = await opts.herdr.createWorkspace(
      { label: opts.label, cwd: opts.cwd },
      opts.signal,
    );
    workspaceId = created.workspace.workspace_id;
    paneId = created.paneId;
  }

  await bootIntoPane({
    herdr: opts.herdr,
    paneId,
    bootCmd: opts.bootCmd,
    sessionFile: opts.sessionFile,
    label: opts.label,
    timeoutMs,
    signal: opts.signal,
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
  const deadline = Date.now() + Math.max(1, timeoutMs);

  let pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
  if (!paneHasAgent(pane)) return;

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
      return { nudgedEnter: nudgedEnter || nudgedEnterTwice };
    }

    const pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
    const status = pane ? normalizeStatus(pane.agent_status) : "unknown";
    const elapsed = Date.now() - started;

    if (
      !nudgedEnter &&
      elapsed >= POST_SUBMIT_ENTER_RETRY_MS &&
      isAgentAcceptingInput(status)
    ) {
      await opts.herdr.sendKeys(opts.paneId, ["Enter"], opts.signal);
      nudgedEnter = true;
    } else if (
      nudgedEnter &&
      !nudgedEnterTwice &&
      elapsed >= POST_SUBMIT_ENTER_RETRY_MS_2 &&
      isAgentAcceptingInput(status)
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
  signal?: AbortSignal;
}): Promise<{ status: string; sawBusy: boolean }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false;
  const started = Date.now();
  let useNativeWait = typeof opts.herdr.waitAgentStatus === "function";

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

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Aborted");

    const pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
    if (!pane) throw new Error(`Pane ${opts.paneId} disappeared while waiting`);

    const status = normalizeStatus(pane.agent_status);
    if (status === "working" || status === "blocked") {
      sawBusy = true;
    }

    if (status === "idle" || status === "done") {
      const elapsed = Date.now() - started;
      const statusReady =
        sawBusy ||
        (opts.allowIdleWithoutBusy === true &&
          elapsed >= POST_SUBMIT_GRACE_MS &&
          hasPostSubmitEvidence());

      if (statusReady) {
        if (
          opts.outputPath &&
          !isOutputReady(opts.outputPath, opts.outputBaselineBytes)
        ) {
          await sleep(OUTPUT_SETTLE_POLL_MS, opts.signal);
          continue;
        }
        return { status, sawBusy };
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    if (
      useNativeWait &&
      (status === "working" || status === "blocked" || status === "unknown")
    ) {
      try {
        await opts.herdr.waitAgentStatus(
          opts.paneId,
          "idle",
          remaining,
          opts.signal,
        );
        continue;
      } catch (err) {
        if (opts.signal?.aborted || isAbortError(err)) throw err;
        if (looksLikeTimeoutError(err)) break;
        useNativeWait = false;
      }
    }

    await sleep(POLL_MS, opts.signal);
  }

  const pane = await opts.herdr.getPaneInfo(opts.paneId, opts.signal);
  const last = pane ? normalizeStatus(pane.agent_status) : "unknown";

  if (
    (last === "idle" || last === "done") &&
    (sawBusy || (opts.allowIdleWithoutBusy && hasPostSubmitEvidence()))
  ) {
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
}): Promise<{ reply: string; source: "session" | "scrollback" }> {
  const { herdr, handle, signal } = opts;

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
      { source: "recent-unwrapped", lines: 200 },
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

export function formatHerdResultMessage(opts: {
  jobId: string;
  label: string;
  status: "done" | "failed" | "aborted";
  difficulty: string;
  model: string;
  thinking: string;
  taskPreview: string;
  runId?: string;
  outputPath?: string;
  owns?: string[];
  reply?: string;
  error?: string;
}): string {
  const lines = [
    `Herd ${opts.jobId} (${opts.label}) ${opts.status}`,
    `difficulty=${opts.difficulty} model=${opts.model}:${opts.thinking}`,
    `task: ${opts.taskPreview}`,
  ];
  if (opts.runId) lines.push(`run: ${opts.runId}`);
  if (opts.outputPath) lines.push(`output: ${opts.outputPath}`);
  if (opts.owns?.length) lines.push(`owns: ${opts.owns.join(", ")}`);
  if (opts.reply) {
    lines.push("", "── reply ──", opts.reply);
  }
  if (opts.error) {
    lines.push("", "── error ──", opts.error);
  }
  return lines.join("\n");
}

void agentDisplayName;
