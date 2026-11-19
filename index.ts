import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertNoCompetingPackages,
  CompetingPackageError,
} from "./src/conflict.ts";
import { ensureHerdConfigFile, loadHerdConfig } from "./src/config.ts";
import {
  createPrivateKeyContinuationTracker,
  hasPrivateMarker,
  isPrivateKeyPath,
  isSshConfigPath,
  redactContextMessages,
  redactForCloud,
  redactProviderPayload,
} from "./src/private.ts";
import { createHerdState } from "./src/state.ts";
import { formatWorkers } from "./src/workers.ts";
import { executeHerd } from "./src/herd/actions.ts";
import { createWorkerPolicyCheck } from "./src/herd/worker-policy.ts";
import { herdRenderCall, herdRenderResult, registerHerdMessageRenderers } from "./src/herd/render.ts";
import {
  getHerdSlashCompletions,
  HERD_SLASH_HELP,
  HerdSlashHelpError,
  parseHerdSlashArgs,
} from "./src/herd/slash.ts";
import { registerHerdrTool } from "./src/herdr/tool.ts";
import { createTerminalClient } from "./src/herdr/runtime.ts";
import { createHerdMonitor, type MonitorCompleteEvent } from "./src/herd/monitor.ts";
import { createJobQueue, type JobQueue } from "./src/herd/queue.ts";
import { bindWorkerMailbox } from "./src/herd/mailbox-worker.ts";
import { formatHerdResultMessage } from "./src/herd/boot.ts";
import { appendJournal } from "./src/journal.ts";
import { requireActiveOrRef } from "./src/runs.ts";
import {
  createPiHolder,
  refreshPiHolder,
  safeSendDisplay,
  safeSendFollowUp,
  shouldTriggerParentTurn,
} from "./src/harness/pi-holder.ts";
import {
  createHerdUiBinder,
  ensureHerdToolsActive,
} from "./src/harness/ui-bind.ts";
import {
  errorText,
  isAbortError,
  softToolResult,
} from "./src/harness/errors.ts";
import {
  getOrCreateLocalLock,
  replaceHarnessDispose,
} from "./src/harness/reload.ts";

const ActionEnum = Type.Enum(
  [
    "models",
    "status",
    "run",
    "spawn",
    "accept",
    "steer",
    "peers",
    "message",
    "messages",
    "abort",
    "wait",
    "collect",
    "reset",
    "close",
    "journal",
  ] as const,
  {
    type: "string",
    description:
      "Agent-chosen workers. Spawn queues immediately; choose worker= using herd models. " +
      "Declare owns= for edits, after= for accepted dependencies. Accept verified completed jobs to release dependents.",
  },
);

const RunActionEnum = Type.Enum(["create", "list", "use", "show"] as const, {
  type: "string",
  description: "When action=run: create|list|use|show handoff folders.",
});

const HerdParams = Type.Object({
  action: ActionEnum,
  task: Type.Optional(Type.String({ description: "Short kick for spawn/steer" })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Advisory note for message; target jobId=. No private data. Limited to 4096 UTF-8 bytes." })),
  worker: Type.Optional(Type.String({ description: "Choose a configured worker from the tool guidance or herd models. No default; private=true implies local." })),
  after: Type.Optional(Type.String({ description: "Comma-separated existing job IDs. Run only after parent accepts every dependency." })),
  model: Type.Optional(
    Type.String({
      description: "Optional exact provider/model escape hatch",
    }),
  ),
  thinking: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ description: "Two-word worker label (TUI tab or core terminal; task or agent role)" })),
  run: Type.Optional(Type.String({ description: "Handoff run id" })),
  runAction: Type.Optional(RunActionEnum),
  name: Type.Optional(Type.String({ description: "For run create/use/show" })),
  goal: Type.Optional(Type.String()),
  reads: Type.Optional(Type.String()),
  output: Type.Optional(
    Type.String({
      description: "Required for async spawn — artifact under the run dir",
    }),
  ),
  owns: Type.Optional(Type.String({ description: "Comma-separated project-relative files/directories this job may edit. Omit for report-only. Conflicting jobs queue." })),
  forbid: Type.Optional(Type.String()),
  waitForReply: Type.Optional(Type.Boolean()),
  private: Type.Optional(
    Type.Boolean({
      description:
        "Route customer information, PII, or secrets to local. Requires private.enabled. No cloud fallback; return only sanitized findings.",
    }),
  ),
  jobId: Type.Optional(Type.String()),
  all: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Number({ description: "Max ms to block on spawn(waitForReply)/wait/close. Omit for the 10-minute default. A timeout never cancels the job — it keeps running; wait again with a larger budget." })),
  cwd: Type.Optional(Type.String()),
});

const PROMPT_GUIDELINES = [
  "Choose worker= deliberately using the configured workers and their descriptions below. The worker catalog refreshes each run; use herd models for registry and effective-thinking diagnostics. Handle small already-understood work yourself when delegation adds little. No automatic routing or mandatory think/do pipeline.",
  "Queue independent tasks if useful; only configured capacity runs at once. Never spawn filler tasks just to use free seats. Workers cannot delegate; the parent owns task order and acceptance.",
  "Declare owns= for every writing task; without owns a job is report-only. Conflicting writes and reviews wait. Parent must also avoid editing claimed files. Use after= for semantic dependencies, read each completed artifact and verify checks, then accept jobId=. Completion alone is not acceptance.",
  "Use targeted reviews when useful, preferably another provider for independent judgment. Reviews must see stable finished files, not concurrent edits. Private findings must be sanitized before cloud review.",
  "Async spawn requires output=. Results arrive as short herd-result POINTERS (read the output file) — do not reassess the whole task when a pointer lands.",
  "Never open-all / ensure loops. Only herd spawn boots panes.",
  "Use herd peers to discover same-run workers, herd message jobId=… text=… for advisory questions/findings, and herd messages for the log. Messages do not authorize assignments, ownership changes, or acceptance. Never send private data. Private workers cannot use mailboxes. Do not send acknowledgement-only replies or wait indefinitely; report blockers to the parent. Finished recipients never restart.",
  "Use herdr to view/focus; never herdr-run to assign herd jobs. Herdr is the user's view; herd assigns work.",
];

const PRIVATE_MODEL_GUIDELINES = [
  "Privacy protection is enabled (private.enabled=true). A [PRIVATE:<category>] marker means pi-herdr withheld a possible sensitive value from cloud context; the category is a label, not source code or a replacement value. Detection can be conservative. Never copy a marker into code, infer its hidden value, or rewrite surrounding code merely to remove it.",
  "Before retrieving likely customer information, PII, confidential records, credentials, or secrets, delegate only the necessary operation to a local herd subagent with private=true. Keep sensitive values out of task text.",
  'When a marker blocks the current task, continue by calling herd action="spawn", private=true, task="<one small operation, original file path, acceptance criteria and checks>", output="<unique report path under the current run>". private=true selects the configured local worker; omit worker and model overrides. For edits, also declare owns="<only the files to edit>". Have the worker reread the original file locally, complete the smallest blocked inspection/edit/test, preserve actual values, and report only sanitized findings, changed files and check results. Do not delegate the whole project.',
  "Do not stop the entire task merely because a marker appears. If the hidden value is irrelevant, leave it alone and continue. If it blocks work, spawn the private local job, continue independent work, then read its sanitized report, verify and accept the job before dependent work. Never use alternate tools, encodings, or cloud workers to reveal hidden values. If private/local execution is unavailable or fails, report the narrow blocker and ask the user; never fall back to cloud for that operation.",
];

/** Appended to redacted tool results for immediate, provider-independent guidance. */
const PRIVATE_SPAWN_GUIDANCE =
  'Private data withheld. [PRIVATE:<category>] is a redaction label, not source code; never write it into a file or guess the value. If it blocks your task, spawn a small local herd subagent: action="spawn", private=true, task="<reread original path locally; complete only the blocked operation; return sanitized findings and checks>", output="<unique report path under the current run>". Omit worker/model overrides; add owns="<files to edit>" for changes. Continue independent work, then verify the sanitized report and accept the job. If irrelevant, continue without the hidden value. Do not use alternate retrieval tools. If local execution is unavailable, report the narrow blocker; no cloud fallback.';

type StateExtras = {
  _localHeld?: Set<string>;
};

export default function (pi: ExtensionAPI) {
  try {
    assertNoCompetingPackages();
  } catch (err) {
    if (err instanceof CompetingPackageError) {
      console.error(err.message);
      pi.registerCommand("herd", {
        description: "BLOCKED — competing herdr package installed",
        handler: async (_args, ctx) => {
          ctx.ui.notify(
            "pi-herdr blocked: remove competing herdr package",
            "error",
          );
          pi.sendMessage({
            customType: "herd-blocked",
            content: err.message,
            display: true,
          });
        },
      });
      return;
    }
    throw err;
  }

  const holder = createPiHolder(pi);
  const ui = createHerdUiBinder();

  let config = loadHerdConfig();
  const checkWorkerPolicy = createWorkerPolicyCheck();
  pi.on("tool_call", (event, ctx) => {
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      return checkWorkerPolicy(event, ctx);
    }
  });
  // Tool metadata is visible at startup; replace only our contributions each run.
  let catalog = config.private.enabled ? redactForCloud(formatWorkers(config)).redacted : formatWorkers(config);
  const startupCatalog = catalog;
  // Survive /reload so local GPU seats aren't double-booked across factory runs.
  const localLock = getOrCreateLocalLock(config.maxModelConcurrent);
  const state = createHerdState() as ReturnType<typeof createHerdState> &
    StateExtras;
  state._localHeld = new Set();
  const workerMailbox = bindWorkerMailbox(pi);
  function closeMailboxes() {
    for (const box of state.mailboxes.values()) {
      try { box.close(); } catch { console.error("Could not close herd mailbox admission"); }
    }
    try { workerMailbox?.dispose(); } catch { console.error("Could not close worker mailbox"); }
  }

  function refreshConfig() {
    config = loadHerdConfig();
    localLock.setMaxStreams(config.maxModelConcurrent);
  }

  // ── Private mode: cloud-parent redaction ─────────────────────────────
  // Local model = identity. Cloud parent = redact before anything reaches the
  // provider. Identity tracks the parent model from ctx on agent_start and
  // tool/command execution.
  let currentModelIdentity: string | undefined;
  const privateKeyTracker = createPrivateKeyContinuationTracker();

  function cloudIdentity(ctx?: Pick<ExtensionContext, "model">): string | undefined {
    const m = ctx?.model;
    return m?.provider && m?.id ? `${m.provider}/${m.id}` : undefined;
  }

  function noteModelIdentity(ctx?: Pick<ExtensionContext, "model">): void {
    if (ctx) currentModelIdentity = cloudIdentity(ctx);
  }

  function isCloudIdentity(identity: string | undefined): boolean {
    // Unknown identity fail-closed: only the configured local model bypasses.
    return config.private.enabled && (!config.local.enabled || identity !== config.local.model);
  }

  /** Identity when feature off or local parent; redacts otherwise. Idempotent. */
  function sanitizeForCloud(text: string): string {
    if (!isCloudIdentity(currentModelIdentity)) return text;
    return redactForCloud(text).redacted;
  }

  // Always dispatch herdr via the refreshable holder (stale pi after reload).
  const herdrClient = createTerminalClient((command, args, options) =>
    holder.pi.exec(command, args, options),
  );
  const promptGuidelines = herdrClient?.kind === "core"
    ? [...PROMPT_GUIDELINES.slice(0, -1), "Use herdr to inspect/control existing core terminals; no workspace/tab/layout/focus actions. Use herd spawn for worker assignments, never herdr run. Preserve current UI focus."]
    : PROMPT_GUIDELINES;

  let monitor!: ReturnType<typeof createHerdMonitor>;
  let queue: JobQueue;

  function refreshSurfaces(ctx?: Pick<ExtensionContext, "ui" | "hasUI">) {
    if (disposed) return;
    if (ctx) ui.bind(ctx);
    if (!herdrClient) {
      ui.clear();
      return;
    }
    const jobs = queue?.list() ?? [];
    const count = (status: string) => jobs.filter((j) => j.status === status).length;
    const blocked = monitor?.blockedJobs() ?? [];
    ui.setStatus(jobs.length || blocked.length ? `herd ● ${count("running")} · queued ${count("queued")} · accept ${count("completed")} · ✓ ${count("accepted")} · failed ${count("failed") + count("aborted") + count("blocked")}${blocked.length ? ` · waiting for user ${blocked.map((j) => `${j.jobId}/${j.paneId}`).join(", ")}` : ""}` : undefined);
  }

  /** Coalesce nearby completion pointers without delaying acceptance-dependent jobs. */
  const pendingResults: string[] = [];
  let resultFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Parent session idle? Captured at job complete so a busy turn isn't followed by a second one. */
  let parentIdle = true;
  let parentAborted = false;
  let cancellation = 0;
  let disposed = false;

  const onComplete = async (event: MonitorCompleteEvent) => {
      // Capture before journal I/O — parent may settle in that window.
      const parentIdleAtComplete = parentIdle;
      const cancellationAtComplete = cancellation;
      const h = event.job.handle;
      const mailbox = !h.private && h.runId ? state.mailboxes.get(h.runId) : undefined;
      let missed = 0;
      try {
        mailbox?.finish(h.jobId);
        missed = mailbox?.messages().filter((m) => m.to === h.jobId && m.status === "recipient-finished").length ?? 0;
      } catch { console.error("Could not read job mailbox completion status"); }
      state.activeMonitors.delete(h.jobId);
      if (state._localHeld?.has(h.jobId)) {
        localLock.release(h.jobId);
        state._localHeld.delete(h.jobId);
      }
      refreshSurfaces();

      if (h.runId && event.status === "done") {
        try {
          const { runDir } = requireActiveOrRef(config.sessionDir, h.runId);
          appendJournal(runDir, {
            jobId: h.jobId,
            model: h.model,
            thinking: h.thinking,
            role: h.role as "do" | "think",
            taskPreview: h.taskPreview,
            output: h.outputPath,
            status: "ok",
            finishedAt: new Date().toISOString(),
          });
        } catch {
          // ignore journal errors
        }
      }

      refreshConfig();
      // Cloud parent: redact before the 4000-char truncation inside
      // formatHerdResultMessage (truncation cannot see what was redacted).
      const reply = event.reply != null ? sanitizeForCloud(event.reply) : event.reply;
      const error = event.error != null ? sanitizeForCloud(event.error) : event.error;
      const content = formatHerdResultMessage({
        jobId: h.jobId,
        label: h.label,
        status: event.status,
        role: h.role,
        model: h.model,
        thinking: h.thinking,
        taskPreview: h.taskPreview,
        runId: h.runId,
        outputPath: h.outputPath,
        owns: h.owns,
        reply,
        error,
        resultDelivery: config.defaults.resultDelivery,
      });

      if (disposed) return;
      pendingResults.push(content + (missed ? `\n${missed} undelivered peer note(s). Inspect herd messages run=${h.runId}; resolve blockers without restarting this completed worker.` : "") + (event.status === "done" ? `\nAwaiting parent acceptance: inspect result and checks, then herd accept jobId=${h.jobId}.` : ""));
      // Deliver promptly: dependencies may be waiting on parent acceptance.
      // Batch only same-tick completions, not the whole queue (which can deadlock).
      if (resultFlushTimer) return;

      // Defer so we never deliver mid-tool-turn bookkeeping; coalesce concurrent finishes.
      resultFlushTimer = setTimeout(() => {
        resultFlushTimer = null;
        if (!pendingResults.length) return;
        const batch = pendingResults.splice(0).join("\n\n──\n\n");
        // triggerTurn false → append only. Display-only sendMessage while
        // streaming would steer (pi treats missing triggerTurn as true).
        safeSendFollowUp(holder, batch, {
          customType: "herd-result",
          triggerTurn: shouldTriggerParentTurn(
            config.defaults.triggerTurnOnResult,
            parentIdleAtComplete && parentIdle && !parentAborted && cancellationAtComplete === cancellation,
          ),
          details: { batched: true },
        });
      }, 0);
  };

  monitor = createHerdMonitor({
    getMaxConcurrent: () => config.maxModelConcurrent,
    herdr: () => herdrClient,
    sanitizeReply: sanitizeForCloud,
    onChange: () => refreshSurfaces(),
    onBlocked: (jobId, paneId) => ui.notify(`herd ${jobId} (${paneId}) is waiting for user input`, "warning"),
    onComplete,
  });
  queue = createJobQueue({
    onChange: () => refreshSurfaces(),
    onComplete: async (job) => {
      const managed = state.jobs[job.id];
      if (!managed) return;
      const result = job.result as { handle?: import("./src/herd/boot.ts").JobHandle; text?: string } | undefined;
      const handle = result?.handle ?? { ...managed, runId: managed.runId ?? undefined, watermark: managed.watermark ?? 0, taskPreview: managed.label };
      const status = job.status === "completed" || job.status === "accepted" ? "done" : job.status === "aborted" ? "aborted" : "failed";
      await onComplete({ job: { id: job.id, handle, startedAt: managed.launchedAt, brief: handle.taskPreview, status, slotHeld: job.held }, status, reply: result?.text, error: job.error });
    },
  });

  replaceHarnessDispose(() => {
    disposed = true;
    queue.dispose();
    closeMailboxes();
    if (resultFlushTimer) clearTimeout(resultFlushTimer);
    monitor.dispose();
    ui.clear();
  });

  const runtime = {
    getConfig: () => {
      refreshConfig();
      return config;
    },
    state,
    localLock,
    herdr: () => herdrClient,
    monitor,
    queue,
    workerMailbox,
    sanitizeForCloud,
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshPiHolder(holder, pi);
    noteModelIdentity(ctx);
    parentIdle = ctx.isIdle?.() !== false;
    // Only arm tools that this factory actually registered.
    ensureHerdToolsActive(
      pi,
      herdrClient ? ["herd", "herdr"] : ["herd"],
    );
    refreshSurfaces(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    parentAborted = false;
    parentIdle = false;
    noteModelIdentity(ctx);
    refreshSurfaces(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    noteModelIdentity(ctx);
  });

  pi.on("agent_settled", async (event, ctx) => {
    parentAborted = event.aborted;
    if (event.aborted) cancellation++;
    parentIdle = !event.aborted;
    refreshSurfaces(ctx);
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    if (resultFlushTimer) clearTimeout(resultFlushTimer);
    queue.dispose();
    closeMailboxes();
    monitor.dispose();
    ui.clear();
  });

  // Mutate structured contributions, never replace another extension's prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    refreshConfig();
    noteModelIdentity(ctx);
    const options = event.systemPromptOptions;
    const owned = new Set([...PROMPT_GUIDELINES, ...promptGuidelines, ...PRIVATE_MODEL_GUIDELINES, startupCatalog, catalog]);
    const keepOther = (rules: string[]) => rules.filter((rule) => !owned.has(rule));
    options.promptGuidelines = keepOther(options.promptGuidelines);
    options.toolGuidelines.herd = keepOther(options.toolGuidelines.herd ?? []);
    catalog = sanitizeForCloud(formatWorkers(config, ctx.modelRegistry));
    options.toolGuidelines.herd.push(...promptGuidelines, catalog);
    if (isCloudIdentity(cloudIdentity(ctx))) {
      options.promptGuidelines.push(...PRIVATE_MODEL_GUIDELINES);
    }
  });

  // Cloud parent: redact tool results before they enter LLM context. Feature
  // off or local model → identity (early return, zero overhead).
  pi.on("tool_result", async (event, ctx) => {
    if (!isCloudIdentity(cloudIdentity(ctx))) return;
    const input = event.input as Record<string, unknown>;
    const path = typeof input.path === "string" ? input.path : undefined;
    const command = typeof input.command === "string" ? input.command : "";
    const commandReadsPrivateKey = command
      .split(/\s+/)
      .some((part) => isPrivateKeyPath(part.replace(/^[<>()'\"]+|[<>()'\";|&]+$/g, "")));
    const forcePrivateKey =
      isPrivateKeyPath(path) ||
      commandReadsPrivateKey ||
      (event.toolName === "read" && privateKeyTracker.forcePrivateKey(path));
    const forceSshConfig = isSshConfigPath(path);

    let total = 0;
    let forcePK = forcePrivateKey;
    const content = event.content.map((block) => {
      if (block.type !== "text") return block; // images untouched
      const r = redactForCloud(block.text, {
        forceSshConfig: forceSshConfig || undefined,
        forcePrivateKey: forcePK || undefined,
      });
      if (event.toolName === "read") {
        privateKeyTracker.noteChunk(path, block.text);
        forcePK = privateKeyTracker.forcePrivateKey(path);
      }
      if (r.count === 0) return block;
      total += r.count;
      let text = r.redacted;
      if (
        !hasPrivateMarker(block.text) &&
        hasPrivateMarker(text) &&
        !text.includes("Private data withheld.")
      ) {
        text = `${text}\n\n${PRIVATE_SPAWN_GUIDANCE}`;
      }
      return { ...block, text };
    });

    if (total === 0) return;
    return { content };
  });

  // Cloud parent: redact session history before each LLM call (also covers
  // local→cloud model switch — context fires on a copy every call).
  pi.on("context", async (event, ctx) => {
    if (!isCloudIdentity(cloudIdentity(ctx))) return;
    if (!redactContextMessages(event.messages)) return;
    return { messages: event.messages };
  });

  // Compaction and branch summarization bypass the context event. Redact the
  // final wire payload so every cloud-provider request is covered.
  pi.on("before_provider_request", async (event, ctx) => {
    if (!isCloudIdentity(cloudIdentity(ctx))) return;
    if (!redactProviderPayload(event.payload)) return;
    return event.payload;
  });

  if (herdrClient) registerHerdrTool(pi, herdrClient.kind === "core" ? herdrClient : undefined);
  registerHerdMessageRenderers(pi);

  pi.registerTool({
    name: "herd",
    label: "herd",
    description:
      "Agent-chosen configured workers. Nonblocking queue, write lanes, accepted dependencies, private-local operations, and run-scoped peer messages.",
    promptSnippet:
      "Choose worker=; declare owns= for edits and after= for dependencies. Inspect completed results, then accept. private=true routes sensitive tasks locally.",
    promptGuidelines: [...promptGuidelines, catalog],
    renderCall: herdRenderCall,
    renderResult: herdRenderResult,
    parameters: HerdParams,
    // Parallel: async spawn returns quickly; wait/collect still share the same tool.
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      refreshSurfaces(ctx);
      noteModelIdentity(ctx);
      let progress: ReturnType<typeof setInterval> | undefined;
      try {
        if (onUpdate && (params.action === "wait" || params.action === "collect" || (params.action === "spawn" && params.waitForReply))) {
          progress = setInterval(() => {
            const jobs = queue.list();
            const count = (status: string) => jobs.filter((job) => job.status === status).length;
            onUpdate({ content: [{ type: "text", text: `herd: ${count("running")} running · ${count("queued")} queued · ${count("completed")} awaiting acceptance · ${monitor.blockedJobs().length} waiting for user` }], details: { action: params.action } });
          }, 1000);
        }
        const result = await executeHerd(
          { ...runtime, modelRegistry: ctx.modelRegistry },
          params,
          signal,
        );
        refreshSurfaces(ctx);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: result.details,
        };
      } catch (err) {
        // Hard-cancel on Esc so the harness marks the tool aborted.
        if (isAbortError(err, signal)) throw err;
        refreshSurfaces(ctx);
        return softToolResult(errorText(err), {
          action: params.action,
        });
      } finally {
        if (progress) clearInterval(progress);
      }
    },
  });

  pi.registerCommand("herd", {
    description:
      "Herd ops. /herd help — models, status, run, spawn, abort, journal",
    getArgumentCompletions: (prefix: string) => getHerdSlashCompletions(prefix),
    handler: async (args, ctx) => {
      refreshPiHolder(holder, pi);
      refreshSurfaces(ctx);
      noteModelIdentity(ctx);
      try {
        let params;
        try {
          params = parseHerdSlashArgs(args ?? "");
        } catch (err) {
          const text =
            err instanceof HerdSlashHelpError
              ? HERD_SLASH_HELP
              : err instanceof Error
                ? `${err.message}\n\n${HERD_SLASH_HELP}`
                : String(err);
          safeSendDisplay(holder, text, { customType: "herd-slash" });
          ui.notify(
            err instanceof HerdSlashHelpError ? "herd help" : "herd usage error",
            err instanceof HerdSlashHelpError ? "info" : "warning",
          );
          return;
        }

        // Slash starts may kick async monitors; executeHerd returns once spawn
        // is queued / wait completes — never hold the command for onComplete.
        const result = await executeHerd({ ...runtime, modelRegistry: ctx.modelRegistry }, params);
        refreshSurfaces(ctx);
        safeSendDisplay(holder, result.text, {
          customType: "herd-slash",
          details: result.details,
        });
        const firstLine =
          result.text.split("\n").find((l) => l.trim()) ?? "herd done";
        ui.notify(
          firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine,
          "info",
        );
      } catch (err) {
        const message = errorText(err);
        safeSendDisplay(holder, message, { customType: "herd-slash" });
        ui.notify(message.slice(0, 80), "error");
      }
    },
  });

  // Config file is created lazily on models/run — not on import.
  void ensureHerdConfigFile;
}
