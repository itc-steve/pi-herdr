/**
 * Full herd spawn: prepare → create/boot pane → submit ACK → monitor or wait.
 */

import type { HerdConfig, ManagedJob } from "../types.ts";
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
import { bootCommand, resolveRole } from "../config.ts";
import { hasPrivateMarker } from "../private.ts";

export class SpawnError extends Error {}

export type SpawnParams = {
  task: string;
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
  /** Idempotent redaction hook for collected replies (private spawn). */
  sanitizeReply?: (text: string) => string;
}): Promise<SpawnResult> {
  const { config, params, state, localLock, herdr, monitor } = opts;
  const task = params.task?.trim();
  if (!task) throw new SpawnError("task is required");

  // Private contract — reject BEFORE any seat claim / reserveSlot / boot.
  // Prompt instructions are not a security boundary: private workers cannot fan out.
  if (process.env.PI_HERD_PRIVATE === "1") {
    throw new SpawnError("private workers cannot spawn further jobs.");
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

  try {
    // Job id first so the local-seat claim has a stable holder key before any async work.
    const { runId, runDir } = requireActiveOrRef(config.sessionDir, params.run);
    jobId = nextJobId(runDir);
    const label = params.label?.trim() || jobId;
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

    // Per-model seat keyed by exact provider/model (e.g. grok-cli/grok-4.5).
    ticketId = await monitor.reserveSlot(opts.parentSignal, {
      model: resolved.model,
      jobId,
      owns,
      forbid,
      brief,
      thinking: resolved.thinking,
      local: resolved.local,
      role: resolved.role,
      slotMax: config.think.some((e) => e.model === resolved.model)
        ? THINK_PER_MODEL
        : undefined,
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
    });

    const baseBootCmd = bootCommand(
      resolved.model,
      resolved.thinking,
      sessionFile,
    );
    // Nested-spawn marker inherited by the child process.
    const bootCmd = isPrivate
      ? `env PI_HERD_PRIVATE=1 ${baseBootCmd}`
      : baseBootCmd;
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
        const collected = await collectReply({
          herdr,
          handle,
          signal: opts.parentSignal,
          sanitize: opts.sanitizeReply,
        });
        appendJournal(runDir, {
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
            `Spawned ${jobId} [${resolved.role}] ${resolved.model}:${resolved.thinking}` +
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

    // Async monitor outlives this tool call. Tool-batch cancellation must not
    // abort it and release a local seat while the pane is still working.
    const onDoneLocal = localHeld;
    const monJob = monitor.attachAndWatch({
      ticketId,
      handle,
      timeoutMs: timeoutMs || DEFAULT_DISPATCH_TIMEOUT_MS,
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
        `pane ${paneId} · workspace ${workspaceId} · label ${label}\n` +
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
    if (ticketId) monitor.releaseTicket(ticketId);
    if (jobId) monitor.releaseThinkHold(jobId);
    if (localHeld && jobId) localLock.release(jobId);
    if (jobId) state.activeMonitors.delete(jobId);
    throw err;
  }
}

export { formatHerdResultMessage };
