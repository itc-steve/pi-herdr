/**
 * Local vLLM stream slots — configurable maxStreams (default 1).
 * Separate from maxModelConcurrent (per exact provider/model API seats).
 */

export function createLocalStreamLock(maxStreams = 1) {
  let max = Math.max(1, Math.floor(maxStreams));
  const holders = new Set<string>();
  const waiters: Array<{
    jobId: string;
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  function setMaxStreams(n: number) {
    max = Math.max(1, Math.floor(n));
    pump();
  }

  function inUse(): number {
    return holders.size;
  }

  function maxStreamsCount(): number {
    return max;
  }

  function isFull(): boolean {
    return holders.size >= max;
  }

  function queued(): number {
    return waiters.length;
  }

  function tryAcquire(jobId: string): boolean {
    if (holders.has(jobId)) return false;
    if (holders.size >= max) return false;
    holders.add(jobId);
    return true;
  }

  /** Wait for a free local seat (whenFull=queue). */
  function acquire(jobId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Aborted"));
    if (tryAcquire(jobId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const entry: (typeof waiters)[number] = { jobId, resolve, reject, signal };
      const onAbort = () => {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error("Aborted"));
      };
      entry.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(entry);
    });
  }

  function pump() {
    let i = 0;
    while (i < waiters.length) {
      const next = waiters[i]!;
      if (next.signal?.aborted) {
        waiters.splice(i, 1);
        if (next.onAbort && next.signal) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.reject(new Error("Aborted"));
        continue;
      }
      if (holders.has(next.jobId)) {
        waiters.splice(i, 1);
        if (next.onAbort && next.signal) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.resolve();
        continue;
      }
      if (holders.size >= max) {
        i += 1;
        continue;
      }
      waiters.splice(i, 1);
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      holders.add(next.jobId);
      next.resolve();
    }
  }

  function release(jobId: string) {
    holders.delete(jobId);
    pump();
  }

  function abortWaiters(reason = "Aborted") {
    while (waiters.length) {
      const w = waiters.shift()!;
      if (w.onAbort && w.signal) {
        w.signal.removeEventListener("abort", w.onAbort);
      }
      w.reject(new Error(reason));
    }
  }

  function snapshot() {
    return {
      holders: [...holders],
      max,
      queued: waiters.map((w) => w.jobId),
    };
  }

  function restore(snap: { holders?: string[]; max?: number }) {
    holders.clear();
    if (typeof snap.max === "number" && snap.max >= 1) max = Math.floor(snap.max);
    for (const h of snap.holders ?? []) holders.add(h);
    pump();
  }

  return {
    inUse,
    maxStreamsCount,
    isFull,
    queued,
    tryAcquire,
    acquire,
    release,
    abortWaiters,
    snapshot,
    restore,
    setMaxStreams,
  };
}

export type LocalStreamLock = ReturnType<typeof createLocalStreamLock>;

/**
 * Per-model monitor concurrency — maxModelConcurrent seats for each exact
 * provider/model string (e.g. grok-cli/grok-build vs grok-cli/grok-4.5).
 */
export function createMonitorSlots(maxPerModel = 2) {
  let max = Math.max(1, Math.floor(maxPerModel));
  /** model → jobIds currently holding a seat */
  const byModel = new Map<string, Set<string>>();
  /** jobId → model (for release) */
  const jobModel = new Map<string, string>();
  const waiters: Array<{
    jobId: string;
    model: string;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  function setMax(n: number) {
    max = Math.max(1, Math.floor(n));
    pump();
  }

  function modelCount(model: string): number {
    return byModel.get(model)?.size ?? 0;
  }

  function inUse(): number {
    return jobModel.size;
  }

  function inUseFor(model: string): number {
    return modelCount(model);
  }

  function tryAcquire(jobId: string, model: string): boolean {
    if (jobModel.has(jobId)) return false;
    if (modelCount(model) >= max) return false;
    let set = byModel.get(model);
    if (!set) {
      set = new Set();
      byModel.set(model, set);
    }
    set.add(jobId);
    jobModel.set(jobId, model);
    return true;
  }

  function acquire(jobId: string, model: string): Promise<void> {
    if (tryAcquire(jobId, model)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      waiters.push({ jobId, model, resolve, reject });
    });
  }

  function release(jobId: string) {
    const model = jobModel.get(jobId);
    if (!model) return;
    jobModel.delete(jobId);
    byModel.get(model)?.delete(jobId);
    pump();
  }

  function pump() {
    let i = 0;
    while (i < waiters.length) {
      const next = waiters[i]!;
      if (jobModel.has(next.jobId)) {
        waiters.splice(i, 1);
        next.resolve();
        continue;
      }
      if (modelCount(next.model) >= max) {
        i += 1;
        continue;
      }
      waiters.splice(i, 1);
      let set = byModel.get(next.model);
      if (!set) {
        set = new Set();
        byModel.set(next.model, set);
      }
      set.add(next.jobId);
      jobModel.set(next.jobId, next.model);
      next.resolve();
    }
  }

  function abortAll(reason = "Aborted") {
    while (waiters.length) {
      waiters.shift()!.reject(new Error(reason));
    }
  }

  function snapshot() {
    const holders: Record<string, string[]> = {};
    for (const [m, set] of byModel) holders[m] = [...set];
    return {
      holders,
      max,
      queued: waiters.map((w) => `${w.model}:${w.jobId}`),
    };
  }

  return {
    inUse,
    inUseFor,
    tryAcquire,
    acquire,
    release,
    abortAll,
    snapshot,
    setMax,
  };
}

export type MonitorSlots = ReturnType<typeof createMonitorSlots>;
