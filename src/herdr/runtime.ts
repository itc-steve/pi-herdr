import { createHerdrClient, type HerdrExecFn } from "./client.ts";
import { createCoreClient } from "./core.ts";

export const TERMINAL_RUNTIME_REQUIRED = "Terminal operations require Herdr TUI (HERDR_ENV=1 and HERDR_PANE_ID) or herdr-core/Ovis (HC_TERMINAL_ID and HC_TERMINAL_SOCKET, or explicit HC_SOCKET). HC_SESSION alone is insufficient; do not spoof runtime flags.";

export type TerminalRuntime =
  | { kind: "herdr"; paneId: string }
  | { kind: "core"; terminalId: string; socketPath: string };

/** Never derive a different core's endpoint from a session name or default path. */
export function detectTerminalRuntime(env: NodeJS.ProcessEnv = process.env): TerminalRuntime | null {
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV === "1" && paneId?.trim()) return { kind: "herdr", paneId };
  const terminalId = env.HC_TERMINAL_ID;
  const socketPath = env.HC_TERMINAL_SOCKET || env.HC_SOCKET;
  if (terminalId?.trim() && socketPath?.trim()) return { kind: "core", terminalId, socketPath };
  return null;
}

export function createTerminalClient(exec: HerdrExecFn, env: NodeJS.ProcessEnv = process.env) {
  const runtime = detectTerminalRuntime(env);
  if (!runtime) return null;
  return runtime.kind === "herdr"
    ? createHerdrClient(exec)
    : createCoreClient({ socketPath: runtime.socketPath, terminalId: runtime.terminalId });
}
