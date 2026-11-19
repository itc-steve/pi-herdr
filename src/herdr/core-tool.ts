import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { normalizeStatus, statusMatches } from "./client.ts";
import type { CoreClient, CorePane, CoreTerminal } from "./core.ts";

const actions = ["list", "current", "pane_get", "agent_list", "agent_get", "read", "run", "send", "stop", "watch", "wait_agent"] as const;
const status = Type.Enum(["idle", "done", "working", "blocked"] as const, { type: "string" });
const schema = Type.Object({
  action: Type.Enum(actions, { type: "string" }),
  pane: Type.Optional(Type.String({ minLength: 1, description: "Existing local terminal ID or unique ovis.pane label" })),
  agent: Type.Optional(Type.String({ minLength: 1, description: "For agent_get/wait_agent: existing terminal ID or unique ovis.pane label, not an app name" })),
  command: Type.Optional(Type.String({ description: "run: text submitted with Enter via terminal.send" })),
  keys: Type.Optional(Type.String({ minLength: 1, description: "send: space-separated keys, e.g. C-c Enter; no literal text" })),
  lines: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "History lines above the screen, default 0; not a total output cap" })),
  match: Type.Optional(Type.String({ minLength: 1, description: "watch: literal substring only, not regex" })),
  status: Type.Optional(status),
  statuses: Type.Optional(Type.Array(status, { minItems: 1 })),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000, description: "watch/wait_agent wall-clock deadline in milliseconds, default 10000, maximum 600000" })),
}, { additionalProperties: false });

const allowed: Record<typeof actions[number], readonly string[]> = {
  list: [], current: [], pane_get: ["pane"], agent_list: [], agent_get: ["pane", "agent"],
  read: ["pane", "lines"], run: ["pane", "command"], send: ["pane", "keys"], stop: ["pane"],
  watch: ["pane", "lines", "match", "timeout"], wait_agent: ["pane", "agent", "status", "statuses", "timeout"],
};
function summarize(t: CoreTerminal): CorePane {
  return { pane_id: t.address, label: t.labels["ovis.pane"], cwd: t.cwd, state: t.state,
    agent: t.state === "live" ? t.status?.app : undefined,
    agent_status: t.state === "live" ? normalizeStatus(t.status?.state) : "unknown", reported_status: t.status?.state };
}

/** Register only verified local core terminal capabilities; never mutate Ovis layout or focus. */
export function registerCoreHerdrTool(pi: ExtensionAPI, coreClient: CoreClient): void {
  pi.registerTool({
    name: "herdr", label: "herdr",
    description: "Inspect/control existing local herdr-core terminals. No workspace/tab/layout/focus/creation APIs. " +
      "read returns screen plus requested history and complete/how/why metadata, not TUI sources or raw output. " +
      "run submits text with Enter; send accepts keys only. Single-terminal literal watch and reported-agent waits are bounded. " +
      `Output is tail-truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES} bytes.`,
    promptSnippet: "Inspect/control existing core terminals (no layout/focus/creation); jobs → herd",
    promptGuidelines: [
      "Use herdr list to discover existing local core terminal IDs or unique ovis.pane labels; never invent IDs. Core has no workspace/tab/layout/focus/creation actions; preserve current UI focus.",
      "Use herd spawn for worker assignments, not herdr run. Use herdr run for text plus Enter; herdr send is keys only, never literal text. No bulk closures or stopping the current parent terminal.",
      "Use herdr read for screen plus requested history lines (above the screen), with complete/how/why metadata; core has no TUI source/raw semantics. Output may be truncated separately.",
      "Use herdr watch for a literal substring on one terminal, or herdr wait_agent only for live reported agents. idle/done are equivalent settled states; errors or finished terminals are not successful completion. Both waits honor timeout and cancellation.",
      "Do not stop terminals you did not create unless the user explicitly asks.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      if (!params || typeof params !== "object" || !actions.includes(params.action)) throw new Error("Unsupported core herdr action; no layout/focus/workspace/tab/creation APIs");
      for (const key of Object.keys(params)) {
        if (key !== "action" && !allowed[params.action].includes(key)) throw new Error(`Core ${params.action}: unsupported parameter ${key}`);
      }
      if (!Value.Check(schema, params)) throw new Error("Invalid core herdr parameters");
      if (params.pane !== undefined && params.agent !== undefined) throw new Error("Specify pane or agent, not both");
      const action = params.action;
      const waiting = action === "watch" || action === "wait_agent";
      const deadline = waiting ? AbortSignal.timeout(params.timeout ?? 10_000) : undefined;
      const activeSignal = deadline ? (signal ? AbortSignal.any([signal, deadline]) : deadline) : signal;
      async function resolveTarget(required = false): Promise<string> {
        const ref = params.pane ?? params.agent;
        if (ref === undefined) {
          if (required) throw new Error(`Core ${action}: pane is required`);
          return (await coreClient.getCurrentTerminal(activeSignal)).address;
        }
        const terminals = await coreClient.listTerminals({ all: true }, activeSignal);
        const exact = terminals.find(t => t.address === ref);
        if (exact) return exact.address;
        const matches = terminals.filter(t => t.labels["ovis.pane"] === ref);
        if (matches.length > 1) throw new Error(`Ambiguous core pane label: ${ref}`);
        if (!matches.length) throw new Error(`Core pane not found: ${ref}`);
        return matches[0].address;
      }
      function result(data: Record<string, unknown>, output = JSON.stringify(data, null, 2)) {
        const truncated = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        const metadata = typeof data.complete === "boolean" ? `${JSON.stringify({ pane_id: data.pane_id, complete: data.complete, how: data.how, why: data.why })}\n` : "";
        return { content: [{ type: "text" as const, text: metadata + truncated.content + (truncated.truncated ? "\n[Output truncated to Pi tail limits; request fewer history lines or inspect the terminal directly.]" : "") }],
          details: { ...data, ...(typeof data.text === "string" ? { text: truncateTail(data.text).content } : {}), truncated: truncated.truncated } };
      }
      try {
        if (action === "list" || action === "agent_list") {
          const panes = (await coreClient.listTerminals({ all: true }, activeSignal)).map(summarize);
          return result(action === "list" ? { panes } : { agents: panes.filter(p => p.state === "live" && p.agent && p.reported_status) });
        }
        if (action === "current") return result(summarize(await coreClient.getCurrentTerminal(activeSignal)));
        if (action === "run" && params.command === undefined) throw new Error("Core run: command is required");
        if (action === "send" && !params.keys?.trim()) throw new Error("Core send: keys are required; literal text is unsupported");
        if (action === "watch" && !params.match) throw new Error("Core watch: literal match is required");
        if (action === "wait_agent" && params.status !== undefined && params.statuses !== undefined) throw new Error("Specify status or statuses, not both");
        const id = await resolveTarget(["run", "send", "stop", "agent_get", "wait_agent"].includes(action));
        if (action === "stop") {
          if (id === (await coreClient.getCurrentTerminal(activeSignal)).address) throw new Error("Cannot stop the current parent terminal");
          await coreClient.closePane(id, activeSignal);
          return result({ pane_id: id, stopped: true });
        }
        if (action === "run") {
          await coreClient.runInPane(id, params.command!, activeSignal);
          return result({ pane_id: id, submitted: true });
        }
        if (action === "send") {
          await coreClient.sendKeys(id, params.keys!.trim().split(/\s+/), activeSignal);
          return result({ pane_id: id, keys_sent: true });
        }
        do {
          activeSignal?.throwIfAborted();
          if (action === "read" || action === "watch") {
            const read = await coreClient.readTerminal(id, { lines: params.lines ?? 0 }, activeSignal);
            if (action === "read" || read.text.includes(params.match!)) {
              const data = { pane_id: id, ...read, ...(action === "watch" ? { matched: true } : {}) };
              return result(data, read.text);
            }
          } else {
            const pane = await coreClient.getPaneInfo(id, activeSignal);
            if (!pane) throw new Error(`Core pane not found: ${id}`);
            if (action === "pane_get") return result(pane);
            if (pane.state !== "live") throw new Error("Core terminal finished; not successful agent completion");
            if (!pane.agent || !pane.reported_status) throw new Error("Core terminal has no reported agent");
            if (action === "agent_get") return result(pane);
            if (pane.reported_status === "error") throw new Error("Core reported agent error; not successful completion");
            if (statusMatches(pane.agent_status, params.statuses ?? [params.status ?? "idle"])) return result(pane);
          }
          await sleep(100, undefined, { signal: activeSignal });
        } while (waiting);
        throw new Error(`Unsupported core action: ${action}`);
      } catch (error) {
        if (signal?.aborted) throw new Error(`Core ${action} aborted`);
        if (deadline?.aborted) throw new Error(`Core ${action} timed out`);
        throw error;
      }
    },
  });
}
