/**
 * Background monitors for async herd spawns.
 * Completion: wait idle + output → collect → onComplete (parent follow-up).
 */

import type { HerdrClient } from "../herdr/client.ts";
import {
  assertLaneAvailable,
  assertMultiWriterOwns,
  type LaneClaim,
} from "../lanes.ts";
import {
  collectReply,
  DEFAULT_DISPATCH_TIMEOUT_MS,
  waitForJobIdle,
  type JobHandle,
} from "./boot.ts";

export type MonitorStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "aborted";

export interface MonitorJob {
  id: string;
  handle: JobHandle;
  startedAt: number;
  brief: string;
  status: MonitorStatus;
  error?: string;
  reply?: string;
  slotHeld: boolean;
}

export type MonitorCompleteEvent = {
  job: MonitorJob;
  status: "done" | "failed" | "aborted";
  reply?: string;
  error?: string;
};

export type MonitorCompleteHandler = (
  event: MonitorCompleteEvent,
) => void | Promise<void>;

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error &&
      (err.message === "Aborted" || err.name === "AbortError")) ||
    (typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name?: string }).name === "AbortError")
  );
}

let jobSeq = 0;

function nextTicketId(key: string): string {
  jobSeq += 1;
  return `${key}-${jobSeq}-${Date.now().toString(36)}`;
}

export function createHerdMonitor(opts: {
  getMaxConcurrent: () => number;
  herdr: () => HerdrClient | null;
  onChange?: () => void;
  onComplete: MonitorCompleteHandler;
}) {
  const jobs = new Map<string, MonitorJob>();
  const controllers = new Map<string, AbortController>();
  const pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** ticketId → model currently holding a per-model seat */
  const slotModel = new Map<string, string>();
  const slotsByModel = new Map<string, Set<string>>();
  const slotWaiters: Array<{
    ticketId: string;
    model: string;
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
  }> = [];

  function clearPrune(jobId: string) {
    const t = pruneTimers.get(jobId);
    if (t) {
      clearTimeout(t);
      pruneTimers.delete(jobId);
    }
  }

  function schedulePrune(jobId: string) {
    clearPrune(jobId);
    const t = setTimeout(() => {
      pruneTimers.delete(jobId);
      const cur = jobs.get(jobId);
      if (
        cur &&
        (cur.status === "done" ||
          cur.status === "failed" ||
          cur.status === "aborted")
      ) {
        jobs.delete(jobId);
        notifyChange();
      }
    }, 60_000);
    t.unref?.();
    pruneTimers.set(jobId, t);
  }

  function notifyChange() {
    opts.onChange?.();
  }

  function listJobs(): MonitorJob[] {
    return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  function inFlightLaneClaims(exceptKey?: string): LaneClaim[] {
    return listJobs()
      .filter(
        (j) =>
          (j.status === "running" || j.status === "queued") &&
          (j.handle.owns?.length ?? 0) > 0 &&
          (!exceptKey || j.handle.jobId !== exceptKey),
      )
      .map((j) => ({
        key: j.handle.jobId,
        owns: j.handle.owns ?? [],
      }));
  }

  function modelInUse(model: string): number {
    return slotsByModel.get(model)?.size ?? 0;
  }

  function tryGrantSlot(ticketId: string, model: string): boolean {
    const max = Math.max(1, opts.getMaxConcurrent());
    if (slotModel.has(ticketId)) return true;
    if (modelInUse(model) >= max) return false;
    let set = slotsByModel.get(model);
    if (!set) {
      set = new Set();
      slotsByModel.set(model, set);
    }
    set.add(ticketId);
    slotModel.set(ticketId, model);
    return true;
  }

  function releaseSlot(ticketId: string) {
    const model = slotModel.get(ticketId);
    if (!model) return;
    slotModel.delete(ticketId);
    slotsByModel.get(model)?.delete(ticketId);
    const job = jobs.get(ticketId);
    if (job) job.slotHeld = false;

    // Wake the oldest waiter for this model (or any waiter whose model has room).
    for (let i = 0; i < slotWaiters.length; i++) {
      const next = slotWaiters[i]!;
      if (next.signal?.aborted) {
        slotWaiters.splice(i, 1);
        next.reject(new Error("Aborted"));
        i -= 1;
        continue;
      }
      const max = Math.max(1, opts.getMaxConcurrent());
      if (modelInUse(next.model) >= max) continue;
      slotWaiters.splice(i, 1);
      next.resolve();
      break;
    }
  }

  async function acquireSlot(
    ticketId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new Error("Aborted");
    if (tryGrantSlot(ticketId, model)) {
      const job = jobs.get(ticketId);
      if (job) job.slotHeld = true;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const entry = { ticketId, model, resolve, reject, signal };
      slotWaiters.push(entry);
      const onAbort = () => {
        const idx = slotWaiters.indexOf(entry);
        if (idx !== -1) slotWaiters.splice(idx, 1);
        reject(new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    if (signal?.aborted) throw new Error("Aborted");
    if (!tryGrantSlot(ticketId, model)) {
      // Race: another waiter got the seat; re-queue once more via acquire.
      return acquireSlot(ticketId, model, signal);
    }
    const job = jobs.get(ticketId);
    if (job) {
      job.slotHeld = true;
      job.status = "running";
    }
    notifyChange();
  }

  async function reserveSlot(
    signal?: AbortSignal,
    lane?: {
      model: string;
      jobId?: string;
      owns?: string[];
      forbid?: string[];
      brief?: string;
      thinking?: string;
      local?: boolean;
      difficulty?: string;
    },
  ): Promise<string> {
    const model = lane?.model?.trim();
    if (!model) {
      throw new Error("reserveSlot requires model= for per-model concurrency");
    }
    const ticketId = nextTicketId("slot");
    const owns = lane?.owns ?? [];
    const forbid = lane?.forbid ?? [];
    const key = lane?.jobId ?? "(pending)";

    const placeholder: MonitorJob = {
      id: ticketId,
      handle: {
        jobId: key,
        label: key,
        paneId: "",
        workspaceId: "",
        sessionFile: "",
        watermark: 0,
        taskPreview: lane?.brief ?? "(pending)",
        owns: owns.length ? owns : undefined,
        forbid: forbid.length ? forbid : undefined,
        model,
        thinking: lane?.thinking ?? "",
        local: lane?.local ?? false,
        difficulty: lane?.difficulty ?? "",
      },
      startedAt: Date.now(),
      brief: lane?.brief ?? "(queued)",
      status: "queued",
      slotHeld: false,
    };
    jobs.set(ticketId, placeholder);
    controllers.set(ticketId, new AbortController());

    try {
      assertMultiWriterOwns({ owns, inFlight: inFlightLaneClaims(key) });
      if (owns.length) {
        assertLaneAvailable({
          key,
          owns,
          forbid,
          inFlight: inFlightLaneClaims(key),
        });
      }
    } catch (err) {
      jobs.delete(ticketId);
      controllers.delete(ticketId);
      notifyChange();
      throw err;
    }

    notifyChange();
    try {
      await acquireSlot(ticketId, model, signal);
      placeholder.status = "running";
      notifyChange();
      return ticketId;
    } catch (err) {
      jobs.delete(ticketId);
      controllers.delete(ticketId);
      notifyChange();
      throw err;
    }
  }

  function attachAndWatch(optsWatch: {
    ticketId: string;
    handle: JobHandle;
    timeoutMs?: number;
    parentSignal?: AbortSignal;
  }): MonitorJob {
    const herdr = opts.herdr();
    if (!herdr) {
      releaseSlot(optsWatch.ticketId);
      jobs.delete(optsWatch.ticketId);
      controllers.delete(optsWatch.ticketId);
      throw new Error("herdr client unavailable for monitor");
    }

    const existing = jobs.get(optsWatch.ticketId);
    const job: MonitorJob = {
      id: optsWatch.ticketId,
      handle: optsWatch.handle,
      startedAt: existing?.startedAt ?? Date.now(),
      brief: optsWatch.handle.taskPreview,
      status: "running",
      slotHeld: true,
    };
    jobs.set(job.id, job);

    const ac = controllers.get(job.id) ?? new AbortController();
    controllers.set(job.id, ac);

    if (optsWatch.parentSignal) {
      if (optsWatch.parentSignal.aborted) ac.abort();
      else {
        optsWatch.parentSignal.addEventListener("abort", () => ac.abort(), {
          once: true,
        });
      }
    }

    notifyChange();

    void (async () => {
      const timeoutMs = optsWatch.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
      try {
        await waitForJobIdle({
          herdr,
          paneId: optsWatch.handle.paneId,
          timeoutMs,
          allowIdleWithoutBusy: true,
          sessionFile: optsWatch.handle.sessionFile,
          watermark: optsWatch.handle.watermark,
          outputPath: optsWatch.handle.outputPath,
          outputBaselineBytes: optsWatch.handle.outputBaselineBytes,
          signal: ac.signal,
        });

        if (ac.signal.aborted) throw new Error("Aborted");

        const collected = await collectReply({
          herdr,
          handle: optsWatch.handle,
          signal: ac.signal,
        });

        job.status = "done";
        job.reply = collected.reply;
        notifyChange();
        await opts.onComplete({
          job,
          status: "done",
          reply: collected.reply,
        });
      } catch (err) {
        const aborted = ac.signal.aborted || isAbortError(err);
        const message = err instanceof Error ? err.message : String(err);
        job.status = aborted ? "aborted" : "failed";
        job.error = message;
        notifyChange();
        await opts.onComplete({
          job,
          status: aborted ? "aborted" : "failed",
          error: message,
        });
      } finally {
        releaseSlot(job.id);
        controllers.delete(job.id);
        schedulePrune(job.id);
        notifyChange();
      }
    })();

    return job;
  }

  function releaseTicket(ticketId: string): void {
    releaseSlot(ticketId);
    jobs.delete(ticketId);
    controllers.delete(ticketId);
    clearPrune(ticketId);
    notifyChange();
  }

  function abort(optsAbort: {
    jobId?: string;
    ticketId?: string;
    all?: boolean;
  }): string[] {
    const aborted: string[] = [];
    for (const [id, job] of jobs) {
      if (
        optsAbort.all ||
        (optsAbort.ticketId && optsAbort.ticketId === id) ||
        (optsAbort.jobId && optsAbort.jobId === job.handle.jobId)
      ) {
        if (job.status === "running" || job.status === "queued") {
          controllers.get(id)?.abort();
          aborted.push(id);
        }
      }
    }
    return aborted;
  }

  /** Abort in-flight work and clear timers — used on reload / session_shutdown. */
  function dispose(): void {
    abort({ all: true });
    for (const id of [...pruneTimers.keys()]) clearPrune(id);
    while (slotWaiters.length > 0) {
      const w = slotWaiters.shift();
      w?.reject(new Error("Aborted"));
    }
  }

  function formatStatusLines(): string[] {
    const active = listJobs().filter(
      (j) => j.status === "running" || j.status === "queued",
    );
    if (!active.length) return [];
    const max = opts.getMaxConcurrent();
    const lines = [
      `herd monitors (${active.length} active, max ${max}/provider-model)`,
    ];
    for (const j of active) {
      const elapsed = Math.round((Date.now() - j.startedAt) / 1000);
      const owns = j.handle.owns?.length
        ? ` owns=${j.handle.owns.join(",")}`
        : "";
      const model = j.handle.model ? ` ${j.handle.model}` : "";
      lines.push(
        `  ${j.handle.jobId}  ${j.status}  ${elapsed}s${model}  ${j.brief}${owns}`,
      );
    }
    return lines;
  }

  return {
    reserveSlot,
    attachAndWatch,
    releaseTicket,
    abort,
    dispose,
    listJobs,
    formatStatusLines,
    inFlightLaneClaims,
    activeCount: () => slotModel.size,
    modelInUse,
  };
}

export type HerdMonitor = ReturnType<typeof createHerdMonitor>;
