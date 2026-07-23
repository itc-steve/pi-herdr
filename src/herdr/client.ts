import type {
  AgentInfo,
  AgentStatus,
  HerdrJsonEnvelope,
  PaneInfo,
  WorkspaceInfo,
} from "../types.ts";

export type HerdrExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};

export type HerdrExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal },
) => Promise<HerdrExecResult>;

export type TabInfo = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
};

export type SplitDirection = "right" | "down";

export type PaneLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PaneLayoutSnapshot = {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  focused_pane_id: string;
  area: PaneLayoutRect;
  panes: Array<{ pane_id: string; focused: boolean; rect: PaneLayoutRect }>;
  splits: Array<{
    id: string;
    direction: SplitDirection;
    ratio: number;
    rect: PaneLayoutRect;
  }>;
};

export function isHerdrEnv(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
}

function parseHerdrError(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as HerdrJsonEnvelope;
    return value.error?.message || value.error?.code || trimmed;
  } catch {
    return trimmed;
  }
}

export function normalizeStatus(raw: string | undefined): AgentStatus {
  if (
    raw === "idle" ||
    raw === "working" ||
    raw === "blocked" ||
    raw === "done" ||
    raw === "unknown"
  ) {
    return raw;
  }
  return "unknown";
}

export function agentDisplayName(agent: AgentInfo): string {
  return agent.name || agent.display_agent || agent.agent || agent.pane_id;
}

export function paneHasAgent(pane: PaneInfo | null | undefined): boolean {
  return !!pane?.agent;
}

export function createHerdrClient(exec: HerdrExecFn) {
  async function execHerdr(
    args: string[],
    signal?: AbortSignal,
  ): Promise<HerdrExecResult> {
    const result = await exec("herdr", args, { signal });
    if (signal?.aborted || result.killed) {
      throw new Error("Aborted");
    }
    if (result.code !== 0) {
      const message =
        parseHerdrError(result.stderr) ||
        parseHerdrError(result.stdout) ||
        `herdr ${args.join(" ")} failed with exit code ${result.code}`;
      throw new Error(message);
    }
    return result;
  }

  async function execHerdrJson<T = HerdrJsonEnvelope>(
    args: string[],
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await execHerdr(args, signal);
    const stdout = result.stdout.trim();
    if (!stdout) {
      throw new Error(`Expected JSON output from herdr ${args.join(" ")}`);
    }
    let value: HerdrJsonEnvelope;
    try {
      value = JSON.parse(stdout) as HerdrJsonEnvelope;
    } catch {
      throw new Error(`Failed to parse JSON from herdr ${args.join(" ")}`);
    }
    if (value.error) {
      throw new Error(
        value.error.message ||
          value.error.code ||
          `herdr ${args.join(" ")} failed`,
      );
    }
    return value as T;
  }

  async function execHerdrText(
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await execHerdr(args, signal);
    return result.stdout;
  }

  async function getAgentList(signal?: AbortSignal): Promise<AgentInfo[]> {
    const response = await execHerdrJson<{ result: { agents: AgentInfo[] } }>(
      ["agent", "list"],
      signal,
    );
    return response.result?.agents || [];
  }

  async function getPaneInfo(
    paneId: string,
    signal?: AbortSignal,
  ): Promise<PaneInfo | null> {
    try {
      const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(
        ["pane", "get", paneId],
        signal,
      );
      return response.result?.pane ?? null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  async function getCurrentPaneInfo(signal?: AbortSignal): Promise<PaneInfo> {
    const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(
      ["pane", "current", "--current"],
      signal,
    );
    return response.result!.pane;
  }

  async function getPaneList(
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<PaneInfo[]> {
    const args = ["pane", "list"];
    if (workspaceId) args.push("--workspace", workspaceId);
    const response = await execHerdrJson<{ result: { panes: PaneInfo[] } }>(
      args,
      signal,
    );
    return response.result?.panes || [];
  }

  async function getAllPanes(signal?: AbortSignal): Promise<PaneInfo[]> {
    const workspaces = await getWorkspaceList(signal);
    const panes: PaneInfo[] = [];
    for (const workspace of workspaces) {
      const listed = await getPaneList(workspace.workspace_id, signal);
      panes.push(...listed);
    }
    return panes;
  }

  async function getWorkspaceList(
    signal?: AbortSignal,
  ): Promise<WorkspaceInfo[]> {
    const response = await execHerdrJson<{
      result: { workspaces: WorkspaceInfo[] };
    }>(["workspace", "list"], signal);
    return response.result?.workspaces || [];
  }

  async function getWorkspaceInfo(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceInfo> {
    const response = await execHerdrJson<{
      result: { workspace: WorkspaceInfo };
    }>(["workspace", "get", workspaceId], signal);
    return response.result!.workspace;
  }

  async function getTabList(
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<TabInfo[]> {
    const args = ["tab", "list"];
    if (workspaceId) args.push("--workspace", workspaceId);
    const response = await execHerdrJson<{ result: { tabs: TabInfo[] } }>(
      args,
      signal,
    );
    return response.result?.tabs || [];
  }

  async function getPaneLayout(
    paneId: string,
    signal?: AbortSignal,
  ): Promise<PaneLayoutSnapshot> {
    const response = await execHerdrJson<{
      result: { layout: PaneLayoutSnapshot };
    }>(["pane", "layout", "--pane", paneId], signal);
    return response.result!.layout;
  }

  async function createWorkspace(
    opts: { label: string; cwd: string },
    signal?: AbortSignal,
  ): Promise<{ workspace: WorkspaceInfo; paneId: string }> {
    const response = await execHerdrJson<{
      result: { workspace: WorkspaceInfo; root_pane?: PaneInfo };
    }>(
      [
        "workspace",
        "create",
        "--label",
        opts.label,
        "--cwd",
        opts.cwd,
        "--no-focus",
      ],
      signal,
    );
    const workspace = response.result?.workspace;
    if (!workspace?.workspace_id) {
      throw new Error("herdr workspace create returned no workspace");
    }
    let paneId = response.result?.root_pane?.pane_id;
    if (!paneId) {
      const panes = await getPaneList(workspace.workspace_id, signal);
      paneId = panes[0]?.pane_id;
    }
    if (!paneId) {
      throw new Error(
        `herdr workspace create '${opts.label}' returned no root pane`,
      );
    }
    return { workspace, paneId };
  }

  async function renamePane(
    paneId: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await execHerdr(["pane", "rename", paneId, label], signal);
  }

  async function runInPane(
    paneId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await execHerdr(["pane", "run", paneId, command], signal);
  }

  async function sendKeys(
    paneId: string,
    keys: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!keys.length) return;
    await execHerdr(["pane", "send-keys", paneId, ...keys], signal);
  }

  async function closePane(
    paneId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await execHerdr(["pane", "close", paneId], signal);
  }

  async function readPane(
    paneId: string,
    options: { source?: string; lines?: number } = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const args = ["pane", "read", paneId];
    if (options.source) args.push("--source", options.source);
    if (options.lines != null) args.push("--lines", String(options.lines));
    return execHerdrText(args, signal);
  }

  async function waitAgentStatus(
    paneId: string,
    status: AgentStatus,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const ms = Math.max(1, Math.floor(timeoutMs));
    await execHerdr(
      [
        "wait",
        "agent-status",
        paneId,
        "--status",
        status,
        "--timeout",
        String(ms),
      ],
      signal,
    );
  }

  async function waitOutput(
    paneId: string,
    options: {
      match: string;
      regex?: boolean;
      source?: string;
      lines?: number;
      timeoutMs: number;
      raw?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const args = [
      "wait",
      "output",
      paneId,
      "--match",
      options.match,
      "--timeout",
      String(Math.max(1, Math.floor(options.timeoutMs))),
    ];
    if (options.source) args.push("--source", options.source);
    if (options.lines != null) args.push("--lines", String(options.lines));
    if (options.regex) args.push("--regex");
    if (options.raw) args.push("--raw");
    await execHerdr(args, signal);
  }

  return {
    execHerdr,
    execHerdrJson,
    execHerdrText,
    getAgentList,
    getPaneInfo,
    getCurrentPaneInfo,
    getPaneList,
    getAllPanes,
    getWorkspaceList,
    getWorkspaceInfo,
    getTabList,
    getPaneLayout,
    createWorkspace,
    renamePane,
    runInPane,
    sendKeys,
    closePane,
    readPane,
    waitAgentStatus,
    waitOutput,
  };
}

export type HerdrClient = ReturnType<typeof createHerdrClient>;
