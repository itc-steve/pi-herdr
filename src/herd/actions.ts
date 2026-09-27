import type { HerdConfig } from "../types.ts";
import { ensureHerdConfigFile, sessionDirAbs } from "../config.ts";
import { formatWorkers } from "../workers.ts";
import { enqueueSpawn, waitForQueuedJob } from "./enqueue.ts";
import type { JobQueue } from "./queue.ts";
import {
  createRun,
  formatRunInfo,
  formatRunList,
  requireActiveOrRef,
  setActiveRun,
} from "../runs.ts";
import { completedJobIds } from "../journal.ts";
import type { LocalStreamLock } from "../local-lock.ts";
import type { HerdState } from "../state.ts";
import type { ModelProbeFn } from "../local/preflight.ts";
import type { HerdrClient } from "../herdr/client.ts";
import type { HerdMonitor } from "./monitor.ts";
import {
  collectReply,
  stopAgentInPane,
} from "./boot.ts";
import { countSessionEntries } from "../readback.ts";
import { formatMessages } from "./mailbox.ts";
import type { WorkerMailbox } from "./mailbox-worker.ts";

export type HerdActionParams = {
  action: string;
  task?: string;
  text?: string;
  worker?: string;
  after?: string;
  role?: string;
  difficulty?: string;
  model?: string;
  thinking?: string;
  label?: string;
  run?: string;
  runAction?: string;
  name?: string;
  goal?: string;
  reads?: string;
  output?: string;
  owns?: string;
  forbid?: string;
  waitForReply?: boolean;
  /** Force local private worker (secret-dependent op). Requires private.enabled. */
  private?: boolean;
  jobId?: string;
  all?: boolean;
  timeoutMs?: number;
  cwd?: string;
};

export type HerdRuntime = {
  getConfig: () => HerdConfig;
  state: HerdState;
  localLock: LocalStreamLock;
  herdr: () => HerdrClient | null;
  monitor: HerdMonitor;
  queue: JobQueue;
  modelProbe?: ModelProbeFn;
  workerMailbox?: WorkerMailbox;
  /** Redaction for cloud parents; set by index.ts. Identity when absent. */
  sanitizeForCloud?: (text: string) => string;
};

export async function executeHerd(
  runtime: HerdRuntime,
  params: HerdActionParams,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const action = params.action;
  const config = runtime.getConfig();

  if (["peers", "message", "messages"].includes(action)) {
    if (process.env.PI_HERD_PRIVATE === "1") throw new Error("Private workers cannot use peer mailboxes; return sanitized findings through the assigned report.");
    const worker = runtime.workerMailbox;
    if (process.env.PI_HERD_WORKER === "1" && !worker) throw new Error("This worker has no mailbox; report blockers to the parent.");
    if (worker && params.run) throw new Error("Workers cannot select another run's mailbox");
    if (action === "message" && (!params.jobId?.trim() || typeof params.text !== "string")) throw new Error("message requires jobId= and text=");
    const target = params.jobId ? runtime.state.jobs[params.jobId] : undefined;
    if (!worker && action === "message" && (!target || target.private)) throw new Error("Unknown or private target; peer messaging is unavailable");
    const runId = worker ? undefined : target?.runId ?? requireActiveOrRef(config.sessionDir, params.run).runId;
    if (!worker && target && params.run && requireActiveOrRef(config.sessionDir, params.run).runId !== target.runId) throw new Error("Target belongs to another run");
    const box = worker?.box ?? runtime.state.mailboxes.get(runId!);
    if (!box) return { text: "No mailbox workers in this run.", details: { action } };
    if (action === "peers") {
      const peers = box.peers().filter((p) => p.id !== worker?.jobId);
      return { text: peers.map((p) => `${p.id} [${p.status}] ${p.label}`).join("\n") || "No peers in this run.", details: { action, peers } };
    }
    if (action === "messages") return { text: formatMessages(box.messages(worker?.jobId)), details: { action } };
    const message = box.send(worker?.jobId ?? "parent", params.jobId!.trim(), params.text!);
    return { text: `Message ${message.id}: ${message.status}.` + (message.status === "recipient-finished" ? " Recipient will not restart. Report this blocker to the parent; the note remains in herd messages." : " Delivery occurs at the recipient's next turn boundary. Do not wait indefinitely or send acknowledgement-only replies."), details: { action, messageId: message.id, status: message.status } };
  }

  if (action === "models") {
    ensureHerdConfigFile();
    const text = formatWorkers(config);
    return { text, details: { action } };
  }

  if (action === "status") {
    const monLines = runtime.queue.list().map((j) => `${j.id} ${j.status}${j.held ? " [capacity/lanes held]" : ""} group=${j.group}${j.after.length ? ` after=${j.after.join(",")}` : ""}${j.error ? ` · ${runtime.sanitizeForCloud?.(j.error) ?? j.error}` : ""}`);
    const base = `herd status\nlocal seats: ${runtime.localLock.inUse()}/${runtime.localLock.maxStreamsCount()}\ntracked jobs: ${runtime.queue.list().length}`;
    const text = monLines.length
      ? `${base}\n\n${monLines.join("\n")}`
      : base;
    return { text, details: { action } };
  }

  if (action === "run") {
    ensureHerdConfigFile();
    const ra = params.runAction ?? "list";
    if (ra === "create") {
      if (!params.name?.trim()) {
        throw new Error("run create requires name=");
      }
      const { runId, runDir } = createRun(
        config.sessionDir,
        params.name,
        params.goal,
      );
      return {
        text: `Created run ${runId}\n${runDir}`,
        details: { action, runAction: ra, runId, runDir },
      };
    }
    if (ra === "list") {
      return {
        text: formatRunList(config.sessionDir),
        details: { action, runAction: ra },
      };
    }
    if (ra === "use") {
      const id = params.run?.trim() || params.name?.trim();
      if (!id) throw new Error("run use requires run= or name=");
      const { runId } = requireActiveOrRef(config.sessionDir, id);
      setActiveRun(config.sessionDir, runId);
      return {
        text: `Active run set to ${runId}`,
        details: { action, runAction: ra, runId },
      };
    }
    if (ra === "show") {
      const id = params.run?.trim() || params.name?.trim();
      if (!id) throw new Error("run show requires run= or name=");
      return {
        text: formatRunInfo(config.sessionDir, id),
        details: { action, runAction: ra, runId: id },
      };
    }
    throw new Error(`Unknown runAction=${ra}`);
  }

  if (action === "journal") {
    ensureHerdConfigFile();
    const { runId, runDir } = requireActiveOrRef(config.sessionDir, params.run);
    const done = completedJobIds(runDir);
    return {
      text:
        `journal for ${runId}\n` +
        `completed ok: ${done.length ? done.join(", ") : "(none)"}\n` +
        `(soft resume — parent should skip these job goals)`,
      details: { action, runId, completed: done },
    };
  }

  if (action === "spawn") {
    const herdr = runtime.herdr();
    if (!herdr) {
      throw new Error(
        "herd spawn requires running inside Herdr (HERDR_ENV=1). Start pi from a herdr pane.",
      );
    }
    return enqueueSpawn(runtime, params, signal);
  }

  if (action === "accept") {
    if (!params.jobId) throw new Error("accept requires jobId=");
    runtime.queue.accept(params.jobId);
    return { text: `Accepted ${params.jobId}; eligible dependents may now run.`, details: { action, jobId: params.jobId } };
  }

  if (action === "abort") {
    if (!params.jobId && !params.all) throw new Error("abort requires jobId= or all=true");
    const aborted = runtime.queue.abort(params.all ? undefined : params.jobId);
    // Esc interrupt on panes
    const herdr = runtime.herdr();
    if (herdr && params.jobId) {
      const job = runtime.state.jobs[params.jobId];
      if (job?.paneId) {
        try {
          await herdr.sendKeys(job.paneId, ["Escape"], signal);
        } catch {
          // ignore
        }
      }
    } else if (herdr && params.all) {
      for (const id of runtime.state.activeMonitors) {
        const job = runtime.state.jobs[id];
        if (!job?.paneId) continue;
        try {
          await herdr.sendKeys(job.paneId, ["Escape"], signal);
        } catch {
          // ignore
        }
      }
    }
    return {
      text: aborted.length
        ? `Cancellation requested: ${aborted.join(", ")}`
        : "No matching queued or running jobs to abort",
      details: { action, aborted },
    };
  }

  if (action === "steer") {
    const herdr = runtime.herdr();
    if (!herdr) throw new Error("herd steer requires Herdr");
    const jobId = params.jobId?.trim();
    const task = params.task?.trim();
    if (!jobId || !task) throw new Error("steer requires jobId= and task=");
    const job = runtime.state.jobs[jobId];
    if (!job) throw new Error(`Unknown job '${jobId}'`);
    if (runtime.queue.get(jobId)?.status !== "running" || !job.paneId) throw new Error("Steer only a running, booted job. For corrections, spawn a new job with owns= and after=.");
    const watermark = countSessionEntries(job.sessionFile);
    const { submitTaskToPane } = await import("./boot.ts");
    await submitTaskToPane({
      herdr,
      paneId: job.paneId,
      task,
      sessionFile: job.sessionFile,
      watermark,
      signal,
    });
    return {
      text: `Steered ${jobId} on pane ${job.paneId}`,
      details: { action, jobId },
    };
  }

  if (action === "wait") {
    const herdr = runtime.herdr();
    if (!herdr) throw new Error("herd wait requires Herdr");
    const jobId = params.jobId?.trim();
    if (!jobId) throw new Error("wait requires jobId=");
    const job = runtime.state.jobs[jobId];
    if (!job) throw new Error(`Unknown job '${jobId}'`);
    const queued = runtime.queue.get(jobId);
    if (!queued) throw new Error(`No queued job '${jobId}'`);
    await waitForQueuedJob(queued.finished, params.timeoutMs, signal);
    return {
      text: `Job ${jobId}: ${queued.status}${queued.error ? ` · ${runtime.sanitizeForCloud?.(queued.error) ?? queued.error}` : ""}`,
      details: { action, jobId },
    };
  }

  if (action === "collect") {
    const herdr = runtime.herdr();
    if (!herdr) throw new Error("herd collect requires Herdr");
    const jobId = params.jobId?.trim();
    if (!jobId) throw new Error("collect requires jobId=");
    const job = runtime.state.jobs[jobId];
    if (!job) throw new Error(`Unknown job '${jobId}'`);
    const queued = runtime.queue.get(jobId);
    if (queued && !["completed", "accepted"].includes(queued.status)) throw new Error(`Job ${jobId} is ${queued.status}; no completed result to collect.`);
    const handle = {
      jobId: job.jobId,
      label: job.label,
      paneId: job.paneId,
      workspaceId: job.workspaceId,
      sessionFile: job.sessionFile,
      watermark: job.watermark ?? 0,
      taskPreview: "",
      runId: job.runId ?? undefined,
      outputPath: job.outputPath,
      outputBaselineBytes: job.outputBaselineBytes,
      owns: job.owns,
      forbid: job.forbid,
      model: job.model,
      thinking: job.thinking,
      local: job.local,
      role: job.role,
      private: job.private,
    };
    const collected = await collectReply({ herdr, handle, signal, sanitize: runtime.sanitizeForCloud });
    return {
      text: collected.reply,
      details: { action, jobId, source: collected.source },
    };
  }

  if (action === "close") {
    const herdr = runtime.herdr();
    if (!herdr) throw new Error("herd close requires Herdr");
    const jobId = params.jobId?.trim();
    if (!jobId) throw new Error("close requires jobId=");
    const job = runtime.state.jobs[jobId];
    if (!job) throw new Error(`Unknown job '${jobId}'`);
    const queued = runtime.queue.get(jobId);
    if (queued?.status === "queued" || queued?.status === "running") {
      runtime.queue.abort(jobId);
      await waitForQueuedJob(queued.finished, params.timeoutMs, signal);
    }
    if (!job.paneId) return { text: `Cancelled ${jobId} before boot`, details: { action, jobId } };
    try {
      await stopAgentInPane({ herdr, paneId: job.paneId, signal });
    } catch {
      // still try close
    }
    await herdr.closePane(job.paneId, signal);
    runtime.state.activeMonitors.delete(jobId);
    runtime.localLock.release(jobId);
    for (const entry of runtime.monitor.listJobs()) if (entry.handle.jobId === jobId) runtime.monitor.releaseTicket(entry.id);
    runtime.queue.releaseBlocked(jobId);
    return {
      text: `Closed pane for ${jobId}`,
      details: { action, jobId },
    };
  }

  if (action === "reset") {
    return {
      text:
        "herd reset: use herd close + herd spawn with a fresh job (per-job sessions are already fresh).",
      details: { action, scaffold: true },
    };
  }

  throw new Error(`Unknown herd action '${action}'`);
}

export function herdSessionRoot(config: HerdConfig): string {
  return sessionDirAbs(config);
}
