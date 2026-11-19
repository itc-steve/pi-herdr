/**
 * Full herd spawn: prepare → create/boot pane → submit ACK → monitor or wait.
 */

import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CoreClientError } from "../herdr/core.ts";
import type { HerdConfig, ManagedJob } from "../types.ts";
import type { Mailbox } from "./mailbox.ts";
import {
  resolveModelClaimingLocal,
  THINK_PER_MODEL,
} from "../resolve-model.ts";
import {
  assertLaneAvailable,
  assertMultiWriterOwns,
  formatLaneKickBlock,
  parsePathList,
} from "../lanes.ts";
import {
  assertOutputName,
  buildHandoffKick,
  ensureJobSessionFile,
  ensureOutputFile,
  parseReadsList,
  resolveHandoffPath,
} from "../handoff.ts";
import { nextJobId, requireActiveOrRef } from "../runs.ts";
import { appendJournal } from "../journal.ts";
import { preflightLocalModel, type ModelProbeFn } from "../local/preflight.ts";
import type { LocalStreamLock } from "../local-lock.ts";
import type { HerdState } from "../state.ts";
import type { HerdrClient } from "../herdr/client.ts";
import {
  collectReply,
  cleanupCoreWorkers,
  createAndBootJob,
  DEFAULT_BOOT_TIMEOUT_MS,
  DEFAULT_DISPATCH_TIMEOUT_MS,
  formatHerdResultMessage,
  outputFileBytes,
  shortTabLabel,
  submitTaskToPane,
  taskPreview,
  waitForJobIdle,
  type JobHandle,
  stopAgentInPane,
} from "./boot.ts";
import type { HerdMonitor } from "./monitor.ts";
import { countSessionEntries } from "../readback.ts";
import { bootCommand, resolveRole, shellQuote } from "../config.ts";
import { hasPrivateMarker } from "../private.ts";
import { JobCleanupError } from "./queue.ts";

export class SpawnError extends Error {}

/** Use the installed package bin, never a test/SDK host's argv[1] or daemon PATH. */
export function piWorkerArgv(args: string[], packageDir: string, runtime: { execPath: string; argv: string[]; versions: Record<string, string | undefined> } = process): string[] {
  if (runtime.versions.bun) {
    const entry = runtime.argv[1] ?? "";
    const compiled = entry.startsWith("/$bunfs/") || /^[A-Za-z]:[\\\\/]~BUN[\\\\/]/.test(entry);
    if (compiled && /^pi(\.exe)?$/i.test(basename(runtime.execPath))) return [runtime.execPath, ...args];
    throw new SpawnError("Core worker launch requires Node-installed Pi or a recognized compiled Pi executable; Bun script hosts are unsupported.");
  }
  if (!runtime.versions.node || runtime.versions.electron) throw new SpawnError("Core worker launch requires a Node runtime, not an unrecognized or Electron host executable.");
  const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { bin?: { pi?: unknown } };
  const bin = pkg.bin?.pi;
  if (typeof bin !== "string" || !/\.[cm]?js$/.test(bin)) throw new SpawnError("Installed Pi package has no runnable JavaScript bin.pi; cannot launch a core worker safely.");
  const cli = resolve(packageDir, bin);
  const local = relative(packageDir, cli);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || !existsSync(cli)) throw new SpawnError("Installed Pi CLI bin is missing or outside its package; cannot launch a core worker safely.");
  return [runtime.execPath, cli, ...args];
}

export type SpawnParams = {
  task: string;
  worker?: string;
  after?: string;
  /** New named-worker path: no owns means report-only. */
  readOnly?: boolean;
  role?: string;
  difficulty?: string;
  model?: string;
  thinking?: string;
  label?: string;
  run?: string;
  reads?: string;
  output?: string;
  owns?: string;
  forbid?: string;
  /** Explicit private=true spawn (secret-dependent local do only). */
  private?: boolean;
  waitForReply?: boolean;
  timeoutMs?: number;
  cwd?: string;
};

export type SpawnResult = {
  text: string;
  details: Record<string, unknown>;
  handle?: JobHandle;
};

export async function spawnJob(opts: {
  config: HerdConfig;
  params: SpawnParams;
  state: HerdState;
  localLock: LocalStreamLock;
  herdr: HerdrClient;
  monitor: HerdMonitor;
  modelProbe?: ModelProbeFn;
  parentSignal?: AbortSignal;
  /** Queue allocates identity before capacity is available. */
  prepared?: { jobId: string; runId: string; runDir: string };
  slotMax?: number;
  mailbox?: Mailbox;
  /** Idempotent redaction hook for collected replies (private spawn). */
  sanitizeReply?: (text: string) => string;
}): Promise<SpawnResult> {
  const { config, params, state, localLock, herdr, monitor } = opts;
  const task = params.task?.trim();
  if (!task) throw new SpawnError("task is required");

  // Private contract — reject BEFORE any seat claim / reserveSlot / boot.
  // Prompt instructions are not a security boundary: private workers cannot fan out.
  if (process.env.PI_HERD_PRIVATE === "1" || process.env.PI_HERD_WORKER === "1") {
    throw new SpawnError("workers cannot spawn further jobs.");
  }
  const isPrivate = params.private === true;
  if (isPrivate) {
    if (!config.private.enabled) {
      throw new SpawnError(
        'private spawn is not enabled. Set "private": { "enabled": true } ' +
          "in ~/.pi/agent/herd.json and retry.",
      );
    }
    if (!config.local.enabled) {
      throw new SpawnError("private spawn requires local.enabled=true.");
    }
    const { role } = resolveRole({
      role: params.role,
      difficulty: params.difficulty,
    });
    if (role === "think") {
      throw new SpawnError(
        "private spawn is local do only — role=think (aliases review/plan/"
          + "architect/verify, difficulty=hard) is rejected.",
      );
    }
    const model = params.model?.trim();
    if (model && model !== config.local.model) {
      throw new SpawnError(
        `private spawn model= must be exactly the local model ` +
          `(got '${model}', expected '${config.local.model}').`,
      );
    }
  } else if (
    config.private.enabled &&
    (hasPrivateMarker(task) || hasPrivateMarker(params.reads ?? ""))
  ) {
    throw new SpawnError(
      "task/reads contains a [PRIVATE: marker. Retry this spawn with private=true.",
    );
  }

  const waitForReply = params.waitForReply === true;
  const requireOutput = config.defaults.requireOutput && !waitForReply;
  let outputRel: string | undefined;
  if (params.output?.trim()) {
    outputRel = assertOutputName(params.output);
  } else if (requireOutput) {
    throw new SpawnError(
      "Async spawn requires output= (artifact path under the run). " +
        "Or pass waitForReply=true for a blocking collect without a file.",
    );
  }

  const owns = parsePathList(params.owns);
  const forbid = parsePathList(params.forbid);
  const brief = taskPreview(task);

  let localHeld = false;
  let jobId = "";
  let ticketId = "";
  let startedPane = "";
  let coreJobLabel: string | undefined;

  try {
    // Job id first so the local-seat claim has a stable holder key before any async work.
    const { runId, runDir } = opts.prepared ?? requireActiveOrRef(config.sessionDir, params.run);
    jobId = opts.prepared?.jobId ?? nextJobId(runDir);
    const label = shortTabLabel(params.label || task);
    const sessionFile = ensureJobSessionFile(runDir, jobId);

    // Resolve role (default do) and claim a local seat when needed.
    const claimed = await resolveModelClaimingLocal(
      config,
      {
        role: isPrivate ? "do" : params.role,
        difficulty: isPrivate ? undefined : params.difficulty,
        model: isPrivate ? config.local.model : params.model,
        thinking: params.thinking,
        jobId,
        modelInUse: (m) => opts.monitor.thinkLoad(m),
        maxModelConcurrent: config.maxModelConcurrent,
        claimThinkPick: (catalog, max, id) =>
          opts.monitor.claimThinkPick(catalog, max, id),
        claimDoPick: (catalog, localModel, localInUse, localMax, localEnabled, id) =>
          opts.monitor.claimDoPick(
            catalog,
            localModel,
            localInUse,
            localMax,
            localEnabled,
            id,
          ),
      },
      localLock,
      opts.parentSignal,
    );
    const resolved = claimed.resolved;
    localHeld = claimed.localHeld;

    if (resolved.local) {
      await preflightLocalModel({
        model: resolved.model,
        enabled: config.local.preflight,
        probe: opts.modelProbe,
      });
    }

    let outputPath: string | undefined;
    let outputBaselineBytes: number | undefined;
    if (outputRel) {
      outputPath = resolveHandoffPath(runDir, outputRel);
      ensureOutputFile(outputPath);
      outputBaselineBytes = outputFileBytes(outputPath);
    }

    if (!opts.prepared) {
      assertMultiWriterOwns({ owns, inFlight: monitor.inFlightLaneClaims(jobId) });
      assertLaneAvailable({ key: jobId, owns, forbid, inFlight: monitor.inFlightLaneClaims(jobId) });
    }

    // Per-model seat keyed by exact provider/model (e.g. grok-cli/grok-4.5).
    ticketId = await monitor.reserveSlot(opts.parentSignal, {
      model: resolved.model,
      jobId,
      // Named jobs already hold cwd-aware lanes in the queue; do not re-check
      // relative paths across unrelated projects in the legacy monitor.
      owns: opts.prepared ? undefined : owns,
      forbid,
      brief,
      thinking: resolved.thinking,
      local: resolved.local,
      role: resolved.role,
      slotMax: opts.slotMax ?? (
        config.think.some((e) => e.model === resolved.model) ||
        config.do.some((e) => e.model === resolved.model)
          ? THINK_PER_MODEL
          : undefined),
    });
    monitor.releaseThinkHold(jobId);

    const reads = parseReadsList(params.reads);
    const laneBlock =
      owns.length || forbid.length
        ? formatLaneKickBlock({ owns, forbid })
        : undefined;
    const kick = buildHandoffKick({
      task,
      runDir,
      reads,
      output: outputRel,
      laneBlock,
      role: resolved.role,
      local: resolved.local,
      private: isPrivate || undefined,
      readOnly: params.readOnly,
      messaging: !!opts.mailbox && !isPrivate,
    });

    let baseBootCmd = bootCommand(resolved.model, resolved.thinking, sessionFile);
    // All workers need the write policy, even without a mailbox or global install.
    baseBootCmd += ` --extension ${shellQuote(fileURLToPath(new URL("../../index.ts", import.meta.url)))}`;
    if (isPrivate) baseBootCmd += " --no-mcp";
    const mailbox = isPrivate ? undefined : opts.mailbox;
    const cwd = params.cwd?.trim() || process.cwd();
    const workerEnv = [
      "PI_HERD_WORKER=1",
      "PI_PROGRAM_STATUS=1",
      `PI_CODING_AGENT_SESSION_DIR=${shellQuote(dirname(sessionFile))}`,
      `PI_HERD_ROOT=${shellQuote(resolve(cwd))}`,
      `PI_HERD_OWNS=${shellQuote(JSON.stringify(owns))}`,
      `PI_HERD_FORBID=${shellQuote(JSON.stringify(forbid))}`,
      ...(outputPath ? [`PI_HERD_OUTPUT=${shellQuote(outputPath)}`] : []),
      ...(isPrivate ? ["PI_HERD_PRIVATE=1"] : []),
      ...(mailbox ? [`PI_HERD_MAILBOX=${shellQuote(mailbox.dir)}`, `PI_HERD_JOB=${shellQuote(jobId)}`] : []),
    ];
    // Clear optional inherited identities/policy before assigning this job's values.
    const bootCmd = `env -u PI_HERD_PRIVATE -u PI_HERD_MAILBOX -u PI_HERD_JOB -u PI_HERD_OUTPUT ${workerEnv.join(" ")} ${baseBootCmd}`;
    let coreLaunch: { argv: string[]; env: Record<string, string>; jobLabel: string } | undefined;
    if (herdr.kind === "core") {
      const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
      const args = ["--model", `${resolved.model}:${resolved.thinking}`, "--session", sessionFile,
        "--extension", fileURLToPath(new URL("../../index.ts", import.meta.url)), ...(isPrivate ? ["--no-mcp"] : [])];
      const argv = piWorkerArgv(args, getPackageDir());
      coreJobLabel = `pi-herdr:${randomUUID()}`;
      coreLaunch = { argv, jobLabel: coreJobLabel, env: {
        PI_HERD_WORKER: "1", PI_PROGRAM_STATUS: "1",
        PI_CODING_AGENT_SESSION_DIR: dirname(sessionFile), PI_HERD_ROOT: resolve(cwd),
        PI_HERD_OWNS: JSON.stringify(owns), PI_HERD_FORBID: JSON.stringify(forbid),
        PI_HERD_OUTPUT: outputPath ?? "", PI_HERD_PRIVATE: isPrivate ? "1" : "",
        PI_HERD_MAILBOX: mailbox?.dir ?? "", PI_HERD_JOB: mailbox ? jobId : "",
        // Core merges daemon env; empty values disable this package's stale TUI identity.
        HERDR_ENV: "", HERDR_PANE_ID: "", HERDR_WORKSPACE_ID: "", HERDR_TAB_ID: "",
      } };
      state.jobs[jobId] = { ...state.jobs[jobId], jobId, label, paneId: "", coreJobLabel, sessionFile,
        model: resolved.model, thinking: resolved.thinking, local: resolved.local, role: resolved.role,
        runId, outputPath, owns, forbid, private: isPrivate || undefined, launchedAt: Date.now() };
      delete state.jobs[jobId]!.workspaceId;
      if (!state.order.includes(jobId)) state.order.push(jobId);
    }
    const bootTimeout = Math.min(
      params.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      DEFAULT_BOOT_TIMEOUT_MS,
    );

    const { paneId, workspaceId } = await createAndBootJob({
      herdr,
      label,
      cwd,
      bootCmd,
      coreLaunch,
      sessionFile,
      timeoutMs: bootTimeout,
      signal: opts.parentSignal,
      onStatus: status => monitor.setPaneStatus(jobId, startedPane, status),
      onPaneCreated: (id, workspace) => {
        startedPane = id;
        const queued = state.jobs[jobId];
        if (queued) { queued.paneId = id; queued.workspaceId = workspace; }
      },
    });

    startedPane = paneId;
    const watermark = countSessionEntries(sessionFile);
    const { nudgedEnter } = await submitTaskToPane({
      herdr,
      paneId,
      task: kick,
      sessionFile,
      watermark,
      signal: opts.parentSignal,
    });

    const handle = {
      jobId,
      label,
      paneId,
      workspaceId,
      sessionFile,
      watermark,
      taskPreview: brief,
      runId,
      outputPath,
      outputBaselineBytes,
      owns: owns.length ? owns : undefined,
      forbid: forbid.length ? forbid : undefined,
      model: resolved.model,
      thinking: resolved.thinking,
      local: resolved.local,
      role: resolved.role,
      private: isPrivate || undefined,
    } as JobHandle;

    const managed: ManagedJob = {
      jobId,
      label,
      paneId,
      workspaceId,
      coreJobLabel,
      sessionFile,
      model: resolved.model,
      thinking: resolved.thinking,
      local: resolved.local,
      role: resolved.role,
      runId,
      outputPath,
      outputBaselineBytes,
      private: handle.private,
      owns: handle.owns,
      forbid: handle.forbid,
      watermark,
      launchedAt: Date.now(),
    };
    state.jobs[jobId] = managed;
    if (!state.order.includes(jobId)) state.order.push(jobId);
    state.activeMonitors.add(jobId);

    const timeoutMs = params.timeoutMs ?? config.defaults.timeoutMs;

    if (waitForReply) {
        await waitForJobIdle({
          herdr,
          paneId,
          timeoutMs: timeoutMs || DEFAULT_DISPATCH_TIMEOUT_MS,
          allowIdleWithoutBusy: true,
          sessionFile,
          watermark,
          outputPath,
          outputBaselineBytes,
          mailboxFinished: mailbox ? () => mailbox.isFinished(jobId) : undefined,
          onStatus: status => monitor.setPaneStatus(jobId, paneId, status),
          signal: opts.parentSignal,
        });
        const collected = await collectReply({
          herdr,
          handle,
          signal: opts.parentSignal,
          sanitize: opts.sanitizeReply,
        });
        if (!opts.prepared) appendJournal(runDir, {
          jobId,
          model: resolved.model,
          thinking: resolved.thinking,
          role: resolved.role,
          taskPreview: brief,
          reads,
          output: outputRel,
          status: "ok",
          finishedAt: new Date().toISOString(),
        });
        state.activeMonitors.delete(jobId);
        if (localHeld) localLock.release(jobId);
        monitor.releaseTicket(ticketId);
        return {
          text:
            `Spawned ${jobId} ${resolved.model}:${resolved.thinking}` +
            `${resolved.local ? " [local]" : ""}\n` +
            `pane ${paneId}${workspaceId ? ` workspace ${workspaceId}` : ""}` +
            `${nudgedEnter ? " (Enter nudged)" : ""}\n\n` +
            collected.reply,
          details: { handle, collected, nudgedEnter },
          handle,
        };
    }

    // Async monitor outlives this tool call. Tool-batch cancellation must not
    // abort it and release a local seat while the pane is still working.
    const onDoneLocal = localHeld;
    const monJob = monitor.attachAndWatch({
      ticketId,
      handle,
      timeoutMs: timeoutMs || DEFAULT_DISPATCH_TIMEOUT_MS,
      mailboxFinished: mailbox ? () => mailbox.isFinished(jobId) : undefined,
    });

    // Patch monitor completion to release local + journal + clear active
    // (index.ts also wraps onComplete for follow-up — we hook via state tracking)
    void monJob;
    // Store release callback on state for index to use — simpler: wrap in index.
    // Here we register a one-shot via a WeakMap-like: monkey patch not clean.
    // Instead attach a side effect by replacing isn't available.
    // The index onComplete will call releaseLocalIfNeeded(jobId).

    (state as HerdState & { _localHeld?: Set<string> })._localHeld ??=
      new Set();
    if (onDoneLocal) {
      (state as HerdState & { _localHeld: Set<string> })._localHeld.add(jobId);
    }

    return {
      text:
        `Spawned ${jobId} [${resolved.role}] ${resolved.model}:${resolved.thinking}` +
        `${resolved.local ? " [local]" : ""} (async)\n` +
        `pane ${paneId}${workspaceId ? ` · workspace ${workspaceId}` : ""} · label ${label}\n` +
        `reason: ${resolved.reason}` +
        `${nudgedEnter ? " · Enter nudged" : ""}\n` +
        `Monitor will deliver a herd-result pointer when the wave finishes.\n` +
        (outputRel ? `output=${outputRel} (read the file; no full reply paste)` : ""),
      details: {
        handle,
        ticketId,
        nudgedEnter,
        scaffold: false,
      },
      handle,
    };
  } catch (err) {
    if (herdr.kind === "core" && err instanceof CoreClientError && err.uncertain && coreJobLabel) {
      await cleanupCoreWorkers({ herdr, jobLabel: coreJobLabel, signal: AbortSignal.timeout(15_000), onRecovered: id => {
        startedPane = id;
        const job = state.jobs[jobId];
        if (job) job.paneId = id;
      } });
    } else if (herdr.kind === "core" && startedPane) {
      try { await herdr.closePane(startedPane, AbortSignal.timeout(15_000)); }
      catch { throw new JobCleanupError(`Could not close core terminal ${startedPane}. Capacity and lanes remain held; herd close jobId=${jobId}.`); }
    } else if (startedPane) {
      try {
        await stopAgentInPane({ herdr, paneId: startedPane, signal: AbortSignal.timeout(35_000) });
      } catch {
        try { await herdr.closePane(startedPane, AbortSignal.timeout(10_000)); }
        catch {
          throw new JobCleanupError(`Could not stop pane ${startedPane}. Capacity and lanes remain held; stop it, then herd close jobId=${jobId}.`);
        }
      }
    }
    // Uncertain creation exits above; a certain pre-create failure needs no recovery label.
    if (herdr.kind === "core" && !startedPane && state.jobs[jobId]) delete state.jobs[jobId]!.coreJobLabel;
    if (ticketId) monitor.releaseTicket(ticketId);
    if (jobId) monitor.releaseThinkHold(jobId);
    if (localHeld && jobId) localLock.release(jobId);
    if (jobId) state.activeMonitors.delete(jobId);
    throw err;
  }
}

export { formatHerdResultMessage };
