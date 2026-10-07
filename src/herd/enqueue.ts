import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createMailbox } from "./mailbox.ts";
import type { HerdRuntime, HerdActionParams } from "./actions.ts";
import { resolveWorker } from "../workers.ts";
import { assertLaneAvailable, parsePathList } from "../lanes.ts";
import { assertOutputName, ensureJobSessionFile, resolveHandoffPath } from "../handoff.ts";
import { nextJobId, requireActiveOrRef } from "../runs.ts";
import { hasPrivateMarker } from "../private.ts";
import { shortTabLabel } from "./boot.ts";
import { spawnJob } from "./spawn.ts";

export async function enqueueSpawn(runtime: HerdRuntime, params: HerdActionParams, signal?: AbortSignal) {
  if (process.env.PI_HERD_PRIVATE === "1" || process.env.PI_HERD_WORKER === "1") throw new Error("Workers cannot spawn further jobs; return blockers to the parent.");
  signal?.throwIfAborted();
  if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1)) throw new Error("timeoutMs must be a positive integer");
  const config = runtime.getConfig();
  const worker = resolveWorker(config, params);
  const task = params.task?.trim();
  if (!task) throw new Error("task is required");
  if (config.private.enabled && !params.private && [task, params.reads ?? ""].some(hasPrivateMarker)) throw new Error("Private marker found; retry with private=true.");
  const herdr = runtime.herdr();
  if (!herdr) throw new Error("herd spawn requires running inside Herdr (HERDR_ENV=1).");
  const owns = parsePathList(params.owns);
  const forbid = parsePathList(params.forbid);
  assertLaneAvailable({ key: "new", owns, forbid, inFlight: [] });
  const after = [...new Set((params.after ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  for (const id of after) if (!runtime.queue.get(id)) throw new Error(`Unknown dependency '${id}'`);
  const output = params.output?.trim() ? assertOutputName(params.output) : undefined;
  if (!output && !params.waitForReply && config.defaults.requireOutput) throw new Error("Async spawn requires output=");
  const { runId, runDir } = requireActiveOrRef(config.sessionDir, params.run);
  const outputPath = output ? resolveHandoffPath(runDir, output) : undefined;
  if (outputPath && runtime.queue.list().some((j) => j.output === outputPath)) throw new Error("Each queued job needs a unique output= artifact; previous results must remain reviewable.");
  const cwd = realpathSync(resolve(params.cwd?.trim() || process.cwd()));
  const jobId = `${runId}-${nextJobId(runDir)}`;
  const label = shortTabLabel(params.label || task);
  const sessionFile = ensureJobSessionFile(runDir, jobId);
  if (!params.private && !runtime.state.mailboxes.has(runId)) {
    runtime.state.mailboxes.set(runId, createMailbox(join(runDir, ".mailboxes", randomUUID())));
  }
  const mailbox = params.private ? undefined : runtime.state.mailboxes.get(runId);
  mailbox?.register(jobId, label);
  runtime.state.jobs[jobId] = {
    jobId, label, paneId: "", workspaceId: "", sessionFile,
    model: worker.model, thinking: worker.thinking, local: worker.local === true,
    role: "do", runId, outputPath, private: params.private,
    owns, forbid, launchedAt: 0,
  };
  runtime.state.order.push(jobId);
  const job = runtime.queue.enqueue({
    id: jobId, group: worker.group, maxConcurrent: worker.maxConcurrent, cwd, owns, output: outputPath, after,
    run: async (jobSignal) => {
      try { return await spawnJob({
      config,
      params: { ...params, label, task, cwd, output, model: worker.model, thinking: worker.thinking,
        role: "do", difficulty: undefined, readOnly: owns.length === 0, waitForReply: true },
      prepared: { jobId, runId, runDir }, slotMax: worker.maxConcurrent, mailbox,
      state: runtime.state, localLock: runtime.localLock, herdr, monitor: runtime.monitor,
      modelProbe: runtime.modelProbe, sanitizeReply: runtime.sanitizeForCloud, parentSignal: jobSignal,
      }); } finally {
        // Never mask JobCleanupError: the queue must keep a live worker's lanes held.
        try { mailbox?.finish(jobId); } catch { console.error("Could not close job mailbox"); }
      }
    },
  });
  if (params.waitForReply) {
    // Cancellation of a waiting parent does not cancel an already admitted background job.
    await waitForQueuedJob(job.finished, params.timeoutMs, signal);
    return { text: `Job ${jobId}: ${job.status}\n${runtime.sanitizeForCloud?.(job.error ?? "") ?? job.error ?? ""}\n${outputPath ? `output=${outputPath}` : (job.result as { text?: string })?.text ?? ""}`, details: { jobId, status: job.status, outputPath } };
  }
  return {
    text: `Queued ${jobId} · worker=${worker.name} · ${worker.model}:${worker.thinking}\n${owns.length ? `owns=${owns.join(",")}` : "Report-only (no project edits)"}${after.length ? `\nafter=${after.join(",")} (parent acceptance required)` : ""}\n${outputPath ? `output=${outputPath}\n` : ""}Completion will be reported. Read the result, verify it, then herd accept jobId=${jobId}.`,
    details: { jobId, status: job.status, worker: worker.name, outputPath },
  };
}

export async function waitForQueuedJob(finished: Promise<void>, timeoutMs = 600_000, signal?: AbortSignal) {
  const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(combined.reason);
    combined.addEventListener("abort", abort, { once: true });
    void finished.then(() => { combined.removeEventListener("abort", abort); resolve(); });
  });
}
