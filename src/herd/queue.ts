import { resolve } from "node:path";
import { findOverlappingPath } from "../lanes.ts";

export type QueueStatus = "queued" | "running" | "completed" | "accepted" | "failed" | "aborted" | "blocked";
export type QueuedJob = {
  id: string;
  group: string;
  maxConcurrent: number;
  cwd: string;
  owns: string[];
  output?: string;
  after: string[];
  run: (signal: AbortSignal) => Promise<unknown>;
  status: QueueStatus;
  controller: AbortController;
  result?: unknown;
  error?: string;
  held: boolean;
  finished: Promise<void>;
};

/** A failed stop must not release capacity or write lanes under a live worker. */
export class JobCleanupError extends Error {}

export function createJobQueue(opts: {
  onChange?: () => void;
  onComplete?: (job: QueuedJob) => void | Promise<void>;
} = {}) {
  // ponytail: session-local queue, not a durable workflow engine. Reload cancels it;
  // use a persisted scheduler only if restart/resume becomes a requirement.
  const jobs = new Map<string, QueuedJob>();
  const settled = new Map<string, () => void>();
  let disposed = false;
  let pumping = false;

  function conflicts(a: QueuedJob, b: QueuedJob): boolean {
    if (a.output && a.output === b.output) return true;
    const rootsOverlap = findOverlappingPath([a.cwd], [b.cwd]);
    if (!rootsOverlap) return false;
    // No owns = report-only. Conservatively keep reviews stable across the whole tree.
    if (!a.owns.length || !b.owns.length) return a.owns.length + b.owns.length > 0;
    return !!findOverlappingPath(
      a.owns.map((p) => resolve(a.cwd, p)), b.owns.map((p) => resolve(b.cwd, p)),
    );
  }

  function complete(job: QueuedJob) {
    settled.get(job.id)?.();
    settled.delete(job.id);
    // Reporting failures must not turn a completed task into a failed task or leak seats.
    void Promise.resolve().then(() => opts.onComplete?.(job)).catch((err) => {
      console.error("herd completion delivery failed:", err instanceof Error ? err.message : String(err));
    });
    opts.onChange?.();
  }

  function pump() {
    if (disposed || pumping) return;
    pumping = true;
    try {
      const ordered = [...jobs.values()];
      for (let i = 0; i < ordered.length; i++) {
        const job = ordered[i]!;
        if (job.status !== "queued") continue;
        const dependencies = job.after.map((id) => jobs.get(id)!);
        const failed = dependencies.find((j) => ["failed", "aborted", "blocked"].includes(j.status));
        if (failed) {
          job.status = "blocked";
          job.error = `Dependency ${failed.id} is ${failed.status}; parent must assign a replacement task.`;
          complete(job);
          continue;
        }
        if (dependencies.some((j) => j.status !== "accepted")) continue;
        const running = ordered.filter((j) => j.held);
        const groupJobs = running.filter((j) => j.group === job.group);
        const cap = Math.min(job.maxConcurrent, ...groupJobs.map((j) => j.maxConcurrent));
        if (groupJobs.length >= cap) continue;
        if (running.some((j) => conflicts(job, j))) continue;
        // Earlier conflicting jobs retain ordering, even while waiting on acceptance/capacity.
        if (ordered.slice(0, i).some((j) => j.status === "queued" && conflicts(job, j))) continue;
        job.status = "running";
        job.held = true;
        opts.onChange?.();
        void (async () => {
          try {
            job.result = await job.run(job.controller.signal);
            job.status = job.controller.signal.aborted ? "aborted" : "completed";
          } catch (err) {
            job.status = err instanceof JobCleanupError ? "blocked" : job.controller.signal.aborted ? "aborted" : "failed";
            job.error = err instanceof Error ? err.message : String(err);
            if (err instanceof JobCleanupError) {
              complete(job); // keep lanes/capacity held until parent explicitly closes the pane
              pump();
              return;
            }
          }
          job.held = false;
          complete(job);
          pump();
        })();
      }
    } finally { pumping = false; }
  }

  function enqueue(input: Omit<QueuedJob, "status" | "controller" | "held" | "finished">) {
    if (disposed) throw new Error("Queue disposed; reload before spawning.");
    if (jobs.has(input.id)) throw new Error(`Duplicate job ${input.id}`);
    if (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1) throw new Error("maxConcurrent must be a positive integer");
    for (const id of input.after) {
      if (!jobs.has(id)) throw new Error(`Unknown dependency '${id}'; dependencies must already be submitted.`);
    }
    const finished = new Promise<void>((r) => settled.set(input.id, r));
    const job: QueuedJob = { ...input, cwd: resolve(input.cwd), status: "queued", controller: new AbortController(), held: false, finished };
    jobs.set(job.id, job);
    pump();
    opts.onChange?.();
    return job;
  }

  function accept(id: string) {
    const job = jobs.get(id);
    if (!job || !["completed", "accepted"].includes(job.status)) throw new Error(`Job '${id}' must be completed before acceptance.`);
    job.status = "accepted";
    pump();
    opts.onChange?.();
  }

  function abort(id?: string): string[] {
    const aborted: string[] = [];
    for (const job of jobs.values()) {
      if (id && job.id !== id) continue;
      if (job.status !== "queued" && job.status !== "running") continue;
      job.controller.abort();
      aborted.push(job.id);
      if (job.status === "queued") { job.status = "aborted"; complete(job); }
    }
    pump();
    return aborted;
  }

  return {
    enqueue, accept, abort,
    get: (id: string) => jobs.get(id),
    list: () => [...jobs.values()],
    releaseBlocked: (id: string) => {
      const job = jobs.get(id);
      if (job?.status === "blocked") { job.held = false; pump(); }
    },
    dispose: () => { disposed = true; abort(); },
  };
}
export type JobQueue = ReturnType<typeof createJobQueue>;
