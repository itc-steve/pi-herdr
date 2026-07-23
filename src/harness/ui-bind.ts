/**
 * Bind footer status + below-editor widget to a live ExtensionContext.
 *
 * Patterns from:
 * - pi-dynamic-workflows display.ts (hasUI guards, re-set widget to refresh)
 * - pi-task widget.ts (string[] widgets + setStatus chip)
 *
 * Never call UI APIs at module load — only after session_start binds a ctx.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UiHandle = Pick<ExtensionContext, "ui" | "hasUI">;

const STATUS_KEY = "herd";
const WIDGET_KEY = "herd-tasks";

export type HerdUiBinder = {
  /** Capture live UI from session_start / tool / command. */
  bind(ctx: UiHandle): void;
  /** Footer chip. Pass undefined when not in Herdr / nothing to show policy. */
  setStatus(text: string | undefined): void;
  /** Multi-line panel below the editor. Empty clears. */
  setWidgetLines(lines: string[]): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  clear(): void;
  /** Last bound ctx, if any. */
  bound(): UiHandle | undefined;
};

export function createHerdUiBinder(): HerdUiBinder {
  let boundCtx: UiHandle | undefined;

  function canUi(): boolean {
    return Boolean(boundCtx?.hasUI && boundCtx.ui);
  }

  return {
    bind(ctx) {
      boundCtx = ctx;
    },
    bound: () => boundCtx,
    setStatus(text) {
      if (!canUi()) return;
      try {
        // Empty string clears the chip (Pi TUI); undefined can leave a stale label.
        boundCtx!.ui.setStatus(STATUS_KEY, text ?? "");
      } catch {
        /* stale ui after reload */
      }
    },
    setWidgetLines(lines) {
      if (!canUi()) return;
      try {
        if (!lines.length) {
          boundCtx!.ui.setWidget(WIDGET_KEY, undefined);
          return;
        }
        // Re-set the same key to force a re-render (dynamic-workflows pattern).
        boundCtx!.ui.setWidget(WIDGET_KEY, lines, {
          placement: "belowEditor",
        });
      } catch {
        /* ignore */
      }
    },
    notify(message, type = "info") {
      if (!canUi()) return;
      try {
        boundCtx!.ui.notify(message, type);
      } catch {
        /* ignore */
      }
    },
    clear() {
      if (!canUi()) return;
      try {
        boundCtx!.ui.setStatus(STATUS_KEY, "");
        boundCtx!.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Keep herd + herdr tools armed after reload / tool pruning. */
export function ensureHerdToolsActive(
  pi: {
    getActiveTools?: () => string[];
    setActiveTools?: (tools: string[]) => void;
  },
  toolNames: string[] = ["herd", "herdr"],
): void {
  const get = pi.getActiveTools?.bind(pi);
  const set = pi.setActiveTools?.bind(pi);
  if (!get || !set) return;
  try {
    const active = get();
    const missing = toolNames.filter((n) => !active.includes(n));
    if (missing.length) set([...active, ...missing]);
  } catch {
    /* older pi without these APIs */
  }
}
