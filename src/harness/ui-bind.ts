/** Bind a one-line below-editor chip to a live ExtensionContext. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UiHandle = Pick<ExtensionContext, "ui" | "hasUI">;

const STATUS_KEY = "herd";
const WIDGET_KEY = "herd";
const LEGACY_WIDGET_KEY = "herd-tasks";

export type HerdUiBinder = {
  /** Capture live UI from session_start / tool / command. */
  bind(ctx: UiHandle): void;
  /** Compact chip above the Pi footer. Pass undefined to hide. */
  setStatus(text: string | undefined): void;
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

  function paint(text: string | undefined) {
    if (!canUi()) return;
    try {
      const ui = boundCtx!.ui;
      // undefined deletes the key. "" stays in the map and becomes a blank footer line.
      ui.setStatus(STATUS_KEY, undefined);
      ui.setWidget(LEGACY_WIDGET_KEY, undefined);
      if (!text) {
        ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      ui.setWidget(WIDGET_KEY, [text], { placement: "belowEditor" });
    } catch {
      /* stale ui after reload */
    }
  }

  return {
    bind(ctx) {
      boundCtx = ctx;
    },
    bound: () => boundCtx,
    setStatus(text) {
      paint(text?.trim() ? text : undefined);
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
      paint(undefined);
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
