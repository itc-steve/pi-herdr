/**
 * Background monitors for async herd spawns.
 * Completion: wait idle + output → collect → onComplete (parent follow-up).
 */

import type { AgentStatus, CatalogEntry } from "../types.ts";
import { pickDoEntry, pickThinkEntry, THINK_PER_MODEL } from "../resolve-model.ts";
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
  stopAgentInPane,
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
  onBlocked?: (jobId: string, paneId: string) => void;
  onComplete: MonitorCompleteHandler;
  sanitizeReply?: (text: string) => string;
}) {
  const jobs = new Map<string, MonitorJob>();
  const controllers = new Map<string, AbortController>();
  // Live prompt state is separate from queue dependency/cleanup blocking.
  const blockedPanes = new Map<string, string>();

  function setPaneStatus(jobId: string, paneId: string, status: AgentStatus): void {
    const previous = blockedPanes.get(jobId);
    if (status === "blocked") {
      blockedPanes.set(jobId, paneId);
      if (previous === paneId) return;
      notifyChange();
      opts.onBlocked?.(jobId, paneId);
    } else if (blockedPanes.delete(jobId)) {
      notifyChange();
    }
  }

  function blockedJobs(): Array<{ jobId: string; paneId: string }> {
    return [...blockedPanes].map(([jobId, paneId]) => ({ jobId, paneId }));
  }
  const pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** ticketId → model currently holding a per-model seat */
  const slotModel = new Map<string, string>();
  const slotsByModel = new Map<string, Set<string>>();
  const slotWaiters: Array<{
    ticketId: string;
    model: string;
    max: number;
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

  /** jobId → model held for think pick before reserveSlot. */
  const thinkHolds = new Map<string, string>();
  /** Next think[] index (second opinion / second think task → the other model). */
  let thinkCursor = 0;
  /** Next do-pool extra index — advances only on extra picks; local head is
   *  always preferred while seats remain (separate from thinkCursor). */
  let doCursor = 0;
  /** ticketId → per-model cap used to grant that slot (think=1, else maxModelConcurrent). */
  const slotCap = new Map<string, number>();

  function thinkLoad(model: string): number {
    let extra = 0;
    for (const m of thinkHolds.values()) {
      if (m === model) extra += 1;
    }
    return modelInUse(model) + extra;
  }

  function claimThinkPick(
    catalog: CatalogEntry[],
    max: number,
    jobId: string,
  ): { entry: CatalogEntry; queued: boolean } {
    const existing = thinkHolds.get(jobId);
    if (existing) {
      const entry =
        catalog.find((e) => e.model === existing) ?? catalog[0]!;
      return { entry, queued: false };
    }
    const cap = Math.min(max, THINK_PER_MODEL);
    const picked = pickThinkEntry(catalog, thinkLoad, cap, thinkCursor);
    if (!picked.queued) {
      thinkHolds.set(jobId, picked.entry.model);
      thinkCursor = picked.nextStart;
    }
    return picked;
  }

  function releaseThinkHold(jobId: string) {
    thinkHolds.delete(jobId);
  }

  function claimDoPick(
    catalog: CatalogEntry[],
    localModel: string,
    localInUse: number,
    localMax: number,
    localEnabled: boolean,
    jobId: string,
  ): { entry: CatalogEntry; queued: boolean } {
    const existing = thinkHolds.get(jobId);
    if (existing) {
      const entry =
        catalog.find((e) => e.model === existing) ?? catalog[0]!;
      return { entry, queued: false };
    }
    const picked = pickDoEntry(
      catalog,
      { localModel, localInUse, localMax, localEnabled, load: thinkLoad },
      doCursor,
    );
    if (!picked.queued) {
      thinkHolds.set(jobId, picked.entry.model);
      doCursor = picked.nextStart;
    }
    return picked;
  }

  function tryGrantSlot(ticketId: string, model: string, max?: number): boolean {
    const cap = Math.max(1, max ?? opts.getMaxConcurrent());
    if (slotModel.has(ticketId)) return true;
    if (modelInUse(model) >= cap) return false;
    let set = slotsByModel.get(model);
    if (!set) {
      set = new Set();
      slotsByModel.set(model, set);
    }
    set.add(ticketId);
    slotModel.set(ticketId, model);
    slotCap.set(ticketId, cap);
    return true;
  }

  function releaseSlot(ticketId: string) {
    const model = slotModel.get(ticketId);
    if (!model) return;
    slotModel.delete(ticketId);
    slotsByModel.get(model)?.delete(ticketId);
    slotCap.delete(ticketId);
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
      const max = next.max;
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
    max?: number,
  ): Promise<void> {
    const cap = Math.max(1, max ?? opts.getMaxConcurrent());
    if (signal?.aborted) throw new Error("Aborted");
    if (tryGrantSlot(ticketId, model, cap)) {
      const job = jobs.get(ticketId);
      if (job) job.slotHeld = true;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const entry = { ticketId, model, max: cap, resolve, reject, signal };
      slotWaiters.push(entry);
      const onAbort = () => {
        const idx = slotWaiters.indexOf(entry);
        if (idx !== -1) slotWaiters.splice(idx, 1);
        reject(new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    if (signal?.aborted) throw new Error("Aborted");
    if (!tryGrantSlot(ticketId, model, cap)) {
      // Race: another waiter got the seat; re-queue once more via acquire.
      return acquireSlot(ticketId, model, signal, cap);
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
      role?: string;
      slotMax?: number;
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
        role: lane?.role ?? "",
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
      const controllerSignal = controllers.get(ticketId)!.signal;
      const slotSignal = signal
        ? AbortSignal.any([signal, controllerSignal])
        : controllerSignal;
      await acquireSlot(ticketId, model, slotSignal, lane?.slotMax);
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
    mailboxFinished?: () => boolean;
  }): MonitorJob {
    const herdr = opts.herdr();
    if (!herdr) {
      throw new Error("herdr client unavailable for monitor; cleanup must succeed before releasing its ticket");
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
          mailboxFinished: optsWatch.mailboxFinished,
          signal: ac.signal,
          onStatus: status => setPaneStatus(job.handle.jobId, job.handle.paneId, status),
        });

        if (ac.signal.aborted) throw new Error("Aborted");

        const collected = await collectReply({
          herdr,
          handle: optsWatch.handle,
          signal: ac.signal,
          sanitize: opts.sanitizeReply,
        });

        setPaneStatus(job.handle.jobId, job.handle.paneId, "done");
        job.status = "done";
        job.reply = collected.reply;
        notifyChange();
      } catch (err) {
        const aborted = ac.signal.aborted || isAbortError(err);
        const message = err instanceof Error ? err.message : String(err);
        setPaneStatus(job.handle.jobId, job.handle.paneId, "unknown");
        // A timeout/cancel is not evidence that the pane stopped using its lanes.
        try {
          await stopAgentInPane({ herdr, paneId: job.handle.paneId, signal: AbortSignal.timeout(35_000) });
        } catch {
          try {
            await herdr.closePane(job.handle.paneId, AbortSignal.timeout(10_000));
          } catch {
            job.error = `${message} Could not stop pane ${job.handle.paneId}; capacity and lanes remain held. Stop it, then herd close jobId=${job.handle.jobId}.`;
            notifyChange();
            return;
          }
        }
        job.status = aborted ? "aborted" : "failed";
        job.error = message;
        notifyChange();
      } finally {
        if (job.status === "done" || job.status === "failed" || job.status === "aborted") {
          try {
            await opts.onComplete({ job, status: job.status, reply: job.reply, error: job.error });
          } catch (err) {
            job.error = `Completion notification failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          releaseSlot(job.id);
          controllers.delete(job.id);
          schedulePrune(job.id);
          notifyChange();
        }
      }
    })();

    return job;
  }

  function releaseTicket(ticketId: string): void {
    const job = jobs.get(ticketId);
    if (job) setPaneStatus(job.handle.jobId, job.handle.paneId, "unknown");
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
          setPaneStatus(job.handle.jobId, job.handle.paneId, "unknown");
          controllers.get(id)?.abort();
          const waiterIndex = slotWaiters.findIndex((w) => w.ticketId === id);
          if (waiterIndex !== -1) {
            slotWaiters.splice(waiterIndex, 1)[0]?.reject(new Error("Aborted"));
          }
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
    setPaneStatus,
    blockedJobs,
    attachAndWatch,
    releaseTicket,
    abort,
    dispose,
    listJobs,
    formatStatusLines,
    inFlightLaneClaims,
    activeCount: () => slotModel.size,
    modelInUse,
    thinkLoad,
    claimThinkPick,
    claimDoPick,
    releaseThinkHold,
  };
}

export type HerdMonitor = ReturnType<typeof createHerdMonitor>;
