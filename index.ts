import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  assertNoCompetingPackages,
  CompetingPackageError,
} from "./src/conflict.ts";
import { ensureHerdConfigFile, loadHerdConfig } from "./src/config.ts";
import { createHerdState } from "./src/state.ts";
import { executeHerd } from "./src/herd/actions.ts";
import {
  getHerdSlashCompletions,
  HERD_SLASH_HELP,
  HerdSlashHelpError,
  parseHerdSlashArgs,
} from "./src/herd/slash.ts";
import { registerHerdrTool } from "./src/herdr/tool.ts";
import { createHerdrClient, isHerdrEnv } from "./src/herdr/client.ts";
import { createHerdMonitor } from "./src/herd/monitor.ts";
import { formatHerdResultMessage } from "./src/herd/boot.ts";
import { appendJournal } from "./src/journal.ts";
import { requireActiveOrRef } from "./src/runs.ts";
import {
  createPiHolder,
  refreshPiHolder,
  safeSendDisplay,
  safeSendFollowUp,
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

const ActionEnum = StringEnum(
  [
    "models",
    "status",
    "run",
    "spawn",
    "steer",
    "abort",
    "wait",
    "collect",
    "reset",
    "close",
    "journal",
  ] as const,
  {
    description:
      "Herd action. Prefer many spawn calls with difficulty= + output=. " +
      "Scale bottom-up: easy (local first) → medium (bulk build) → hard (review/think only). " +
      "Never one hard job for a whole project. Herdr is view-only.",
  },
);

const RunActionEnum = StringEnum(["create", "list", "use", "show"] as const, {
  description: "When action=run: create|list|use|show handoff folders.",
});

const HerdParams = Type.Object({
  action: ActionEnum,
  task: Type.Optional(Type.String({ description: "Short kick for spawn/steer" })),
  difficulty: Type.Optional(
    Type.String({
      description:
        "Required for spawn: easy|medium|hard. easy=local-first narrow work; " +
        "medium=bulk implement; hard=review/think/VERIFY only — not default builder",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional exact provider/model; still requires difficulty=",
    }),
  ),
  thinking: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ description: "Herdr pane/space label" })),
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
  owns: Type.Optional(Type.String()),
  forbid: Type.Optional(Type.String()),
  waitForReply: Type.Optional(Type.Boolean()),
  jobId: Type.Optional(Type.String()),
  all: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Number()),
  cwd: Type.Optional(Type.String()),
});

const PROMPT_GUIDELINES = [
  "Scale bottom-up with many herd spawn calls — never one hard job for a whole project.",
  "DEFAULT single discrete tasks to difficulty=easy (local first). Local is free, private, maxStreams=1, clean per-job context — use it for every single-file / single-question / summary / scaffold job.",
  "medium = multi-file bulk implementation. Local is still preferred when free (preferOn). whenFull=queue waits for the local seat serially instead of burning paid remote — do not escalate to hard because local is busy.",
  "hard = frontier only: orchestration thinking, architecture, critique, VERIFY — not the default implementer. Parent/orchestrator stays on the frontier model.",
  "Local seat is one stream: spawn many jobs; herd queues extras on local (whenFull=queue) or overflows (whenFull=overflow). Never force model=local on more than maxStreams jobs.",
  "Async spawn requires difficulty= + output=. Results arrive as short herd-result POINTERS (read the output file) — do not reassess the whole task when a pointer lands.",
  "Never open-all / ensure loops. Only herd spawn boots panes.",
  "Shared context is run markdown only — panes do not chat to each other.",
  "Use herdr to view/focus; never herdr-run to assign herd jobs. Herdr is the user's view; herd assigns work.",
];

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
  // Survive /reload so local GPU seats aren't double-booked across factory runs.
  const localLock = getOrCreateLocalLock(config.local.maxStreams);
  const state = createHerdState() as ReturnType<typeof createHerdState> &
    StateExtras;
  state._localHeld = new Set();

  function refreshConfig() {
    config = loadHerdConfig();
    localLock.setMaxStreams(config.local.maxStreams);
  }

  // Always dispatch herdr via the refreshable holder (stale pi after reload).
  const herdrClient = isHerdrEnv()
    ? createHerdrClient((command, args, options) =>
        holder.pi.exec(command, args, options),
      )
    : null;

  let monitor!: ReturnType<typeof createHerdMonitor>;

  function refreshSurfaces(ctx?: Pick<ExtensionContext, "ui" | "hasUI">) {
    if (ctx) ui.bind(ctx);
    if (!isHerdrEnv()) {
      ui.clear();
      return;
    }
    const mon = monitor?.activeCount() ?? 0;
    const local = localLock.inUse();
    // Footer only while active (like fortigate ON / tldraw server-up) — hide when idle.
    if (!mon && !local) {
      ui.setStatus(undefined);
    } else {
      ui.setStatus(
        `herd: ${mon} mon` + (local ? ` +local ${local}` : ""),
      );
    }
    ui.setWidgetLines(monitor?.formatStatusLines() ?? []);
  }

  /** Buffer pointers until the in-flight wave is quiet — one parent turn, not N. */
  const pendingResults: string[] = [];
  let resultFlushTimer: ReturnType<typeof setTimeout> | null = null;

  monitor = createHerdMonitor({
    getMaxConcurrent: () => {
      refreshConfig();
      return config.maxModelConcurrent;
    },
    herdr: () => herdrClient,
    onChange: () => {
      refreshSurfaces();
    },
    onComplete: async (event) => {
      const h = event.job.handle;
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
            difficulty: h.difficulty as "easy" | "medium" | "hard",
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
      const content = formatHerdResultMessage({
        jobId: h.jobId,
        label: h.label,
        status: event.status,
        difficulty: h.difficulty,
        model: h.model,
        thinking: h.thinking,
        taskPreview: h.taskPreview,
        runId: h.runId,
        outputPath: h.outputPath,
        owns: h.owns,
        reply: event.reply,
        error: event.error,
        resultDelivery: config.defaults.resultDelivery,
      });

      pendingResults.push(content);
      // Mid-wave: buffer only (footer shows active monitors). One parent message
      // when the last in-flight job finishes — avoids N reassess turns.
      if (state.activeMonitors.size > 0) return;
      if (resultFlushTimer) return;

      // Defer so we never deliver mid-tool-turn bookkeeping; coalesce concurrent finishes.
      resultFlushTimer = setTimeout(() => {
        resultFlushTimer = null;
        if (!pendingResults.length) return;
        const batch = pendingResults.splice(0).join("\n\n──\n\n");
        const triggerTurn = config.defaults.triggerTurnOnResult;
        if (triggerTurn) {
          safeSendFollowUp(holder, batch, {
            customType: "herd-result",
            triggerTurn: true,
            details: { batched: true },
          });
        } else {
          safeSendDisplay(holder, batch, {
            customType: "herd-result",
            details: { batched: true },
          });
        }
      }, 0);
    },
  });

  replaceHarnessDispose(() => {
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
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshPiHolder(holder, pi);
    // Only arm tools that this factory actually registered.
    ensureHerdToolsActive(
      pi,
      isHerdrEnv() ? ["herd", "herdr"] : ["herd"],
    );
    refreshSurfaces(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    refreshSurfaces(ctx);
  });

  pi.on("session_shutdown", async () => {
    monitor.dispose();
    ui.clear();
  });

  registerHerdrTool(pi);

  pi.registerTool({
    name: "herd",
    label: "herd",
    description:
      "Difficulty-routed Herdr subagents. Scale bottom-up: many easy/medium spawns; " +
      "hard for review/think only. Easy prefers local vLLM when free.",
    promptSnippet:
      "Subagent herd: easy/medium→local first (queue or overflow), hard=review. Results as batched herd-result pointers.",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: HerdParams,
    // Parallel: async spawn returns quickly; wait/collect still share the same tool.
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      refreshSurfaces(ctx);
      try {
        const result = await executeHerd(
          runtime,
          params as Parameters<typeof executeHerd>[1],
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
          action: (params as { action?: string }).action,
        });
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
        const result = await executeHerd(runtime, params);
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
