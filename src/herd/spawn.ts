/**
 * Full herd spawn: prepare → create/boot pane → submit ACK → monitor or wait.
 */

import type { HerdConfig, ManagedJob } from "../types.ts";
import { resolveModel } from "../resolve-model.ts";
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
  createAndBootJob,
  DEFAULT_BOOT_TIMEOUT_MS,
  DEFAULT_DISPATCH_TIMEOUT_MS,
  formatHerdResultMessage,
  outputFileBytes,
  submitTaskToPane,
  taskPreview,
  waitForJobIdle,
  type JobHandle,
} from "./boot.ts";
import type { HerdMonitor } from "./monitor.ts";
import { countSessionEntries } from "../readback.ts";
import { bootCommand } from "../config.ts";

export class SpawnError extends Error {}

export type SpawnParams = {
  task: string;
  difficulty: string;
  model?: string;
  thinking?: string;
  label?: string;
  run?: string;
  reads?: string;
  output?: string;
  owns?: string;
  forbid?: string;
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
}): Promise<SpawnResult> {
  const { config, params, state, localLock, herdr, monitor } = opts;
  const task = params.task?.trim();
  if (!task) throw new SpawnError("task is required");
  if (!params.difficulty?.trim()) {
    throw new SpawnError("difficulty=easy|medium|hard is required");
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

  try {
    const resolved = resolveModel(config, {
      difficulty: params.difficulty,
      model: params.model,
      thinking: params.thinking,
      localInUse: localLock.inUse(),
    });

    if (resolved.local) {
      await preflightLocalModel({
        model: resolved.model,
        enabled: config.local.preflight,
        probe: opts.modelProbe,
      });
    }

    const { runId, runDir } = requireActiveOrRef(config.sessionDir, params.run);
    jobId = nextJobId(runDir);
    const label = params.label?.trim() || jobId;
    const sessionFile = ensureJobSessionFile(runDir, jobId);

    let outputPath: string | undefined;
    let outputBaselineBytes: number | undefined;
    if (outputRel) {
      outputPath = resolveHandoffPath(runDir, outputRel);
      ensureOutputFile(outputPath);
      outputBaselineBytes = outputFileBytes(outputPath);
    }

    assertMultiWriterOwns({
      owns,
      inFlight: monitor.inFlightLaneClaims(jobId),
    });
    assertLaneAvailable({
      key: jobId,
      owns,
      forbid,
      inFlight: monitor.inFlightLaneClaims(jobId),
    });

    if (resolved.local) {
      if (!localLock.tryAcquire(jobId)) {
        throw new SpawnError(
          `Local streams full (${localLock.inUse()}/${localLock.maxStreamsCount()}). ` +
            `Retry, wait, or spawn without forcing the local model.`,
        );
      }
      localHeld = true;
    }

    // Per-model seat keyed by exact provider/model (e.g. grok-cli/grok-4.5).
    ticketId = await monitor.reserveSlot(opts.parentSignal, {
      model: resolved.model,
      jobId,
      owns,
      forbid,
      brief,
      thinking: resolved.thinking,
      local: resolved.local,
      difficulty: resolved.difficulty,
    });

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
    });

    const bootCmd = bootCommand(
      resolved.model,
      resolved.thinking,
      sessionFile,
    );
    const cwd = params.cwd?.trim() || process.cwd();
    const bootTimeout = Math.min(
      params.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      DEFAULT_BOOT_TIMEOUT_MS,
    );

    const { paneId, workspaceId } = await createAndBootJob({
      herdr,
      label,
      cwd,
      bootCmd,
      sessionFile,
      timeoutMs: bootTimeout,
      signal: opts.parentSignal,
    });

    const watermark = countSessionEntries(sessionFile);
    const { nudgedEnter } = await submitTaskToPane({
      herdr,
      paneId,
      task: kick,
      sessionFile,
      watermark,
      signal: opts.parentSignal,
    });

    const handle: JobHandle = {
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
      difficulty: resolved.difficulty,
    };

    const managed: ManagedJob = {
      jobId,
      label,
      paneId,
      workspaceId,
      sessionFile,
      model: resolved.model,
      thinking: resolved.thinking,
      local: resolved.local,
      difficulty: resolved.difficulty,
      runId,
      outputPath,
      owns: handle.owns,
      forbid: handle.forbid,
      watermark,
      launchedAt: Date.now(),
    };
    state.jobs[jobId] = managed;
    state.order.push(jobId);
    state.activeMonitors.add(jobId);

    const timeoutMs = params.timeoutMs ?? config.defaults.timeoutMs;

    if (waitForReply) {
      try {
        await waitForJobIdle({
          herdr,
          paneId,
          timeoutMs: timeoutMs || DEFAULT_DISPATCH_TIMEOUT_MS,
          allowIdleWithoutBusy: true,
          sessionFile,
          watermark,
          outputPath,
          outputBaselineBytes,
          signal: opts.parentSignal,
        });
        const collected = await collectReply({ herdr, handle });
        appendJournal(runDir, {
          jobId,
          model: resolved.model,
          thinking: resolved.thinking,
          difficulty: resolved.difficulty,
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
            `Spawned ${jobId} [${resolved.difficulty}] ${resolved.model}:${resolved.thinking}` +
            `${resolved.local ? " [local]" : ""}\n` +
            `pane ${paneId} workspace ${workspaceId}` +
            `${nudgedEnter ? " (Enter nudged)" : ""}\n\n` +
            collected.reply,
          details: { handle, collected, nudgedEnter },
          handle,
        };
      } catch (err) {
        state.activeMonitors.delete(jobId);
        if (localHeld) localLock.release(jobId);
        monitor.releaseTicket(ticketId);
        throw err;
      }
    }

    // Async: attach monitor; release local lock when monitor completes
    const onDoneLocal = localHeld;
    const monJob = monitor.attachAndWatch({
      ticketId,
      handle,
      timeoutMs: timeoutMs || DEFAULT_DISPATCH_TIMEOUT_MS,
      parentSignal: opts.parentSignal,
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
        `Spawned ${jobId} [${resolved.difficulty}] ${resolved.model}:${resolved.thinking}` +
        `${resolved.local ? " [local]" : ""} (async)\n` +
        `pane ${paneId} · workspace ${workspaceId} · label ${label}\n` +
        `reason: ${resolved.reason}` +
        `${nudgedEnter ? " · Enter nudged" : ""}\n` +
        `Monitor will inject a herd-result follow-up when done.\n` +
        (outputRel ? `output=${outputRel}` : ""),
      details: {
        handle,
        ticketId,
        nudgedEnter,
        scaffold: false,
      },
      handle,
    };
  } catch (err) {
    if (ticketId) monitor.releaseTicket(ticketId);
    if (localHeld && jobId) localLock.release(jobId);
    if (jobId) state.activeMonitors.delete(jobId);
    throw err;
  }
}

export { formatHerdResultMessage };
