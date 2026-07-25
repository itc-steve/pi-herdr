import type { HerdConfig } from "../types.ts";
import { ensureHerdConfigFile, sessionDirAbs } from "../config.ts";
import { formatModelsList } from "../resolve-model.ts";
import {
  createRun,
  formatRunInfo,
  formatRunList,
  requireActiveOrRef,
  setActiveRun,
} from "../runs.ts";
import { appendJournal, completedJobIds } from "../journal.ts";
import { spawnJob, type SpawnParams } from "./spawn.ts";
import type { LocalStreamLock } from "../local-lock.ts";
import { formatStatus, type HerdState } from "../state.ts";
import type { ModelProbeFn } from "../local/preflight.ts";
import type { HerdrClient } from "../herdr/client.ts";
import type { HerdMonitor } from "./monitor.ts";
import {
  collectReply,
  stopAgentInPane,
  waitForJobIdle,
  DEFAULT_DISPATCH_TIMEOUT_MS,
} from "./boot.ts";
import { countSessionEntries } from "../readback.ts";

export type HerdActionParams = {
  action: string;
  task?: string;
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
  modelProbe?: ModelProbeFn;
};

export async function executeHerd(
  runtime: HerdRuntime,
  params: HerdActionParams,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const action = params.action;
  const config = runtime.getConfig();

  if (action === "models") {
    ensureHerdConfigFile();
    const text = formatModelsList(
      config,
      runtime.localLock.inUse(),
      runtime.localLock.queued(),
    );
    return { text, details: { action } };
  }

  if (action === "status") {
    const monLines = runtime.monitor.formatStatusLines();
    const base = formatStatus(
      runtime.state,
      runtime.localLock.inUse(),
      runtime.localLock.maxStreamsCount(),
      runtime.monitor.activeCount(),
      config.maxModelConcurrent,
    );
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
    return spawnJob({
      config,
      params: params as SpawnParams,
      state: runtime.state,
      localLock: runtime.localLock,
      herdr,
      monitor: runtime.monitor,
      modelProbe: runtime.modelProbe,
      parentSignal: signal,
    });
  }

  if (action === "abort") {
    const aborted = runtime.monitor.abort({
      jobId: params.jobId,
      all: params.all === true,
    });
    // Esc interrupt on panes
    const herdr = runtime.herdr();
    if (herdr && params.jobId) {
      const job = runtime.state.jobs[params.jobId];
      if (job) {
        try {
          await herdr.sendKeys(job.paneId, ["Escape"], signal);
        } catch {
          // ignore
        }
      }
    } else if (herdr && params.all) {
      for (const id of runtime.state.activeMonitors) {
        const job = runtime.state.jobs[id];
        if (!job) continue;
        try {
          await herdr.sendKeys(job.paneId, ["Escape"], signal);
        } catch {
          // ignore
        }
      }
    }
    return {
      text: aborted.length
        ? `Aborted monitors: ${aborted.join(", ")}`
        : "No matching active monitors to abort",
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
    await waitForJobIdle({
      herdr,
      paneId: job.paneId,
      timeoutMs: params.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
      allowIdleWithoutBusy: true,
      sessionFile: job.sessionFile,
      watermark: job.watermark ?? 0,
      outputPath: job.outputPath,
      signal,
    });
    return {
      text: `Job ${jobId} is idle`,
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
      owns: job.owns,
      forbid: job.forbid,
      model: job.model,
      thinking: job.thinking,
      local: job.local,
      difficulty: job.difficulty,
    };
    const collected = await collectReply({ herdr, handle, signal });
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
    try {
      await stopAgentInPane({ herdr, paneId: job.paneId, signal });
    } catch {
      // still try close
    }
    await herdr.closePane(job.paneId, signal);
    runtime.state.activeMonitors.delete(jobId);
    runtime.localLock.release(jobId);
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
