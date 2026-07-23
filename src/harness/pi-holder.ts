/**
 * Refreshable ExtensionAPI handle + safe message delivery.
 *
 * Pattern from pi-dynamic-workflows result delivery:
 * - keep a mutable `{ pi }` so /reload can refresh the active API
 * - swallow sync + async send failures (stale ctx after reload)
 * - background results use followUp + triggerTurn (never interrupt a busy turn)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type PiHolder = {
  pi: ExtensionAPI;
};

export type FollowUpOptions = {
  /** When true (default), start a turn if idle so the host model can act. */
  triggerTurn?: boolean;
  /** Custom message type for the host transcript. */
  customType?: string;
  details?: Record<string, unknown>;
};

export function createPiHolder(pi: ExtensionAPI): PiHolder {
  return { pi };
}

/** Refresh the live API after session_start / reload. */
export function refreshPiHolder(holder: PiHolder, pi: ExtensionAPI): void {
  holder.pi = pi;
}

/**
 * Deliver a background result into the conversation without interrupting
 * an in-flight turn. Failures are swallowed — the artifact still lives on disk
 * / in /herd status.
 */
export function safeSendFollowUp(
  holder: PiHolder,
  content: string,
  opts: FollowUpOptions = {},
): void {
  const customType = opts.customType ?? "herd-result";
  const triggerTurn = opts.triggerTurn !== false;
  try {
    const ret = holder.pi.sendMessage(
      {
        customType,
        content,
        display: true,
        ...(opts.details ? { details: opts.details } : {}),
      },
      { deliverAs: "followUp", triggerTurn },
    );
    void Promise.resolve(ret).catch(() => {
      /* stale API after /reload */
    });
  } catch {
    /* sync stale-ctx failure */
  }
}

/** Display-only message (no turn). Still swallows delivery failures. */
export function safeSendDisplay(
  holder: PiHolder,
  content: string,
  opts: { customType?: string; details?: Record<string, unknown> } = {},
): void {
  try {
    const ret = holder.pi.sendMessage({
      customType: opts.customType ?? "herd-slash",
      content,
      display: true,
      ...(opts.details ? { details: opts.details } : {}),
    });
    void Promise.resolve(ret).catch(() => {});
  } catch {
    /* ignore */
  }
}
