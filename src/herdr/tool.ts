import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolvePaneRefByLabel, resolveTabRef, resolveWorkspaceRef } from "./resolve.ts";
import {
	createHerdrClient,
	type PaneLayoutSnapshot,
	type SplitDirection,
	type TabInfo,
} from "./client.ts";
import type { AgentInfo, AgentStatus, PaneInfo, WorkspaceInfo } from "../types.ts";

type ReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

interface PaneReadResult {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	source: "visible" | "recent" | "recent_unwrapped";
	text: string;
	revision: number;
	truncated: boolean;
}

interface ManagedPane {
	paneId: string;
	workspaceId: string;
}

interface HerdrToolDetails {
	action?: string;
	aliases: Record<string, ManagedPane>;
	aliasOrder: string[];
	[key: string]: unknown;
}

const ActionEnum = StringEnum(
	[
		"list",
		"current",
		"workspace_list",
		"workspace_create",
		"workspace_focus",
		"workspace_rename",
		"workspace_close",
		"tab_list",
		"tab_create",
		"tab_focus",
		"tab_rename",
		"tab_close",
		"focus",
		"pane_get",
		"pane_rename",
		"pane_split",
		"pane_layout",
		"pane_zoom",
		"pane_move",
		"agent_list",
		"agent_get",
		"run",
		"read",
		"watch",
		"wait_agent",
		"send",
		"stop",
		"notify",
		"worktree_list",
		"worktree_create",
		"worktree_open",
		"worktree_remove",
	] as const,
	{ description: "Action to perform" },
);

const StatusEnum = StringEnum(["idle", "working", "blocked", "done", "unknown"] as const, {
	description: "Agent status to wait for",
});

const SourceEnum = StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const, {
	description: "Read source for read/watch; detection is valid for read only",
});

const DirectionEnum = StringEnum(["right", "down"] as const, {
	description: "Split direction for pane_split / pane_move. When omitted for pane_split, Herdr chooses from the source pane geometry.",
});

const ZoomModeEnum = StringEnum(["toggle", "on", "off"] as const, {
	description: "Zoom mode for pane_zoom (default toggle)",
});

const MoveTargetEnum = StringEnum(["tab", "new-tab", "new-workspace"] as const, {
	description: "Where pane_move sends the pane",
});

const ListScopeEnum = StringEnum(["current", "workspace", "all"] as const, {
	description:
		"list scope: current (caller workspace, default), workspace (requires workspace id/label), or all (every space — use to inspect terminals outside the herd)",
});

const WaitModeEnum = StringEnum(["all", "any"] as const, {
	description: "How multi-pane waits should resolve",
});

const NotifyPositionEnum = StringEnum(
	["top-left", "top-right", "bottom-left", "bottom-right"] as const,
	{ description: "Notification corner" },
);

const NotifySoundEnum = StringEnum(["none", "done", "request"] as const, {
	description: "Notification sound",
});

/** Register the structured `herdr` tool. No-op outside a Herdr-managed pane. */
export function registerHerdrTool(pi: ExtensionAPI): void {
	const herdrEnv = process.env.HERDR_ENV;
	const currentPaneTargetEnv = process.env.HERDR_PANE_ID;
	if (!herdrEnv || !currentPaneTargetEnv) {
		return;
	}
	const managedPanes = new Map<string, ManagedPane>();
	const aliasOrder: string[] = [];
	const client = createHerdrClient((command, args, options) =>
		pi.exec(command, args, options),
	);
	const {
		execHerdr,
		execHerdrJson,
		getAgentList,
		getAllPanes,
		getCurrentPaneInfo,
		getPaneInfo,
		getPaneLayout,
		getTabList,
		getWorkspaceList,
		readPane: clientReadPane,
	} = client;

	async function getWorkspacePanes(workspaceId: string, signal?: AbortSignal): Promise<PaneInfo[]> {
		return client.getPaneList(workspaceId, signal);
	}

	function snapshotAliases(): Record<string, ManagedPane> {
		return Object.fromEntries(managedPanes.entries());
	}

	function withSnapshot(details: Omit<HerdrToolDetails, "aliases" | "aliasOrder">): HerdrToolDetails {
		return {
			...details,
			aliases: snapshotAliases(),
			aliasOrder: [...aliasOrder],
		};
	}

	function setAliases(aliases: Record<string, ManagedPane>, order: string[]) {
		managedPanes.clear();
		aliasOrder.length = 0;
		for (const [alias, managed] of Object.entries(aliases)) {
			managedPanes.set(alias, managed);
		}
		for (const alias of order) {
			if (managedPanes.has(alias)) aliasOrder.push(alias);
		}
		for (const alias of managedPanes.keys()) {
			if (!aliasOrder.includes(alias)) aliasOrder.push(alias);
		}
	}

	function reconstructState(ctx: ExtensionContext) {
		let aliases: Record<string, ManagedPane> = {};
		let order: string[] = [];

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "herdr") continue;
			const details = message.details as HerdrToolDetails | undefined;
			if (!details?.aliases) continue;
			aliases = details.aliases;
			order = Array.isArray(details.aliasOrder) ? details.aliasOrder : Object.keys(details.aliases);
		}

		setAliases(aliases, order);
	}

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	function recordAlias(alias: string, paneId: string, workspaceId: string) {
		managedPanes.set(alias, { paneId, workspaceId });
		const existingIndex = aliasOrder.indexOf(alias);
		if (existingIndex !== -1) aliasOrder.splice(existingIndex, 1);
		aliasOrder.push(alias);
	}

	function forgetAlias(alias: string) {
		managedPanes.delete(alias);
		const index = aliasOrder.indexOf(alias);
		if (index !== -1) aliasOrder.splice(index, 1);
	}

	function isAbortError(error: unknown, signal?: AbortSignal): boolean {
		return signal?.aborted === true || (error instanceof Error && error.message === "Aborted");
	}

	async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Aborted");
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timeout);
				reject(new Error("Aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async function readPane(
		paneId: string,
		options: { source?: ReadSource; lines?: number; raw?: boolean },
		signal?: AbortSignal,
	): Promise<string> {
		if (options.raw) {
			const args = ["pane", "read", paneId, "--raw"];
			if (options.source) args.push("--source", options.source);
			if (options.lines != null) args.push("--lines", String(options.lines));
			const result = await execHerdr(args, signal);
			return result.stdout;
		}
		return clientReadPane(
			paneId,
			{ source: options.source, lines: options.lines },
			signal,
		);
	}

	function chooseSplitDirection(layout: PaneLayoutSnapshot, paneId: string): SplitDirection {
		const pane = layout.panes.find((candidate) => candidate.pane_id === paneId);
		if (!pane) return "right";
		return pane.rect.width >= 80 && pane.rect.width >= pane.rect.height * 2 ? "right" : "down";
	}

	async function resolvePaneRef(
		ref: string,
		signal?: AbortSignal,
		workspaceHint?: string,
	): Promise<{ pane: PaneInfo; alias?: string } | null> {
		const managed = managedPanes.get(ref);
		if (managed) {
			const pane = await getPaneInfo(managed.paneId, signal);
			if (!pane) {
				forgetAlias(ref);
				return null;
			}
			managed.workspaceId = pane.workspace_id;
			return { pane, alias: ref };
		}

		const pane = await getPaneInfo(ref, signal);
		if (pane) {
			const alias = [...managedPanes.entries()].find(([, managedPane]) => managedPane.paneId === pane.pane_id)?.[0];
			return { pane, alias };
		}

		// Label resolve: scoped workspace first, then all workspaces (terminals outside herd).
		let panes: PaneInfo[];
		if (workspaceHint) {
			const workspace = await requireWorkspaceRef(workspaceHint, signal);
			panes = await getWorkspacePanes(workspace.workspace_id, signal);
		} else {
			panes = await getAllPanes(signal);
		}
		try {
			const byLabel = resolvePaneRefByLabel(ref, panes);
			const alias = [...managedPanes.entries()].find(([, managedPane]) => managedPane.paneId === byLabel.pane_id)?.[0];
			return { pane: byLabel, alias };
		} catch (error) {
			if (error instanceof Error && /Ambiguous pane label/.test(error.message)) {
				throw error;
			}
			return null;
		}
	}

	async function requirePaneRef(
		ref: string,
		signal?: AbortSignal,
		workspaceHint?: string,
	): Promise<{ pane: PaneInfo; alias?: string }> {
		const hadAlias = managedPanes.has(ref);
		const resolved = await resolvePaneRef(ref, signal, workspaceHint);
		if (resolved) return resolved;
		if (hadAlias) {
			throw new Error(`Pane alias '${ref}' no longer points to a live pane and was removed.`);
		}
		throw new Error(
			`Pane '${ref}' not found as alias, id, or unique label.` +
				(workspaceHint ? ` Scoped to workspace '${workspaceHint}'.` : " Try herdr list with scope=all."),
		);
	}

	function formatReadOutput(output: string): string {
		const truncation = truncateTail(output, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		let text = truncation.content;
		if (truncation.truncated) {
			text = `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${text}`;
		}
		return text;
	}

	function summarizePane(pane: PaneInfo, alias?: string, currentPaneId?: string): string {
		const name = alias || pane.label || pane.pane_id;
		const flags = [
			pane.pane_id === currentPaneId || pane.focused ? "current" : null,
			pane.agent ? pane.agent : null,
			pane.agent_status !== "unknown" ? pane.agent_status : null,
		]
			.filter(Boolean)
			.join(", ");
		const cwd = pane.cwd ? ` ${pane.cwd}` : "";
		return `${name}: [${pane.pane_id}]${flags ? ` (${flags})` : ""}${cwd}`;
	}

	function formatPaneInventory(
		groups: Array<{ workspace: WorkspaceInfo; panes: PaneInfo[] }>,
		currentPaneId: string,
		aliasByPaneId: Map<string, string>,
	): string {
		if (!groups.length) return "No panes.";
		const blocks: string[] = [];
		for (const { workspace, panes } of groups) {
			const header = summarizeWorkspace(workspace);
			if (!panes.length) {
				blocks.push(`${header}\n  (no panes)`);
				continue;
			}
			const lines = panes.map((pane) =>
				`  ${summarizePane(pane, aliasByPaneId.get(pane.pane_id), currentPaneId)}`,
			);
			blocks.push(`${header}\n${lines.join("\n")}`);
		}
		return blocks.join("\n");
	}

	function agentDisplayName(agent: AgentInfo): string {
		return agent.name || agent.display_agent || agent.agent || agent.pane_id;
	}

	function summarizeAgent(agent: AgentInfo): string {
		const name = agentDisplayName(agent);
		const flags = [agent.focused ? "focused" : null, agent.agent_status].filter(Boolean).join(", ");
		const cwd = agent.cwd ? ` ${agent.cwd}` : "";
		return `${name}: [${agent.pane_id}] (${flags})${cwd}`;
	}

	function summarizeTab(tab: TabInfo): string {
		const flags = [tab.focused ? "focused" : null, tab.agent_status !== "unknown" ? tab.agent_status : null]
			.filter(Boolean)
			.join(", ");
		const name = tab.label?.trim() ? ` ${tab.label}` : "";
		return `[${tab.tab_id}]${name}${flags ? ` (${flags})` : ""}`;
	}

	function summarizeWorkspace(workspace: WorkspaceInfo): string {
		const flags = [workspace.focused ? "focused" : null, workspace.agent_status !== "unknown" ? workspace.agent_status : null]
			.filter(Boolean)
			.join(", ");
		const name = workspace.label?.trim() ? ` ${workspace.label}` : "";
		return `[${workspace.workspace_id}]${name}${flags ? ` (${flags})` : ""}`;
	}

	async function requireWorkspaceRef(
		ref: string,
		signal?: AbortSignal,
	): Promise<WorkspaceInfo> {
		const workspaces = await getWorkspaceList(signal);
		return resolveWorkspaceRef(ref, workspaces);
	}

	async function requireTabRef(
		ref: string,
		workspaceRef: string | undefined,
		signal?: AbortSignal,
	): Promise<TabInfo> {
		const workspaceId = workspaceRef
			? (await requireWorkspaceRef(workspaceRef, signal)).workspace_id
			: undefined;
		const tabs = await getTabList(workspaceId, signal);
		return resolveTabRef(ref, tabs);
	}

	function rejectUnexpectedParams(
		action: string,
		params: { workspace?: string; tab?: string },
		unexpected: Array<"workspace" | "tab">,
	) {
		const present = unexpected.filter((key) => params[key] != null);
		if (!present.length) return;
		throw new Error(
			`${action} targets panes, not ${present.join(" or ")}. Use a pane alias or pane id from list, or the root pane returned by tab_create/workspace_create.`,
		);
	}

	function formatStatusList(statuses: AgentStatus[]): string {
		return statuses.join("|");
	}

	function throwIfAborted(signal: AbortSignal | undefined, action: string) {
		if (signal?.aborted) {
			throw new Error(`${action} canceled.`);
		}
	}

	function sleepWithSignal(ms: number, signal: AbortSignal | undefined) {
		if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
		if (signal.aborted) return Promise.reject(new Error("wait_agent canceled."));
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				reject(new Error("wait_agent canceled."));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	function statusDot(theme: any, status: AgentStatus): string {
		switch (status) {
			case "blocked":
				return theme.fg("warning", "●");
			case "working":
				return theme.fg("accent", "●");
			case "done":
				return theme.fg("success", "●");
			case "idle":
				return theme.fg("muted", "○");
			default:
				return theme.fg("dim", "·");
		}
	}

	pi.registerTool({
		name: "herdr",
		label: "herdr",
		description:
			"Full structured control of Herdr: workspaces, tabs, panes, agents, worktrees, and notifications. " +
			"Discover and read terminals in any space (including outside the herd), create/split/move panes, run commands, wait on output or agent status, and close panes you own. " +
			"For herd jobs use the herd tool (spawn by difficulty) — never herdr-run to assign herd work.",
		promptSnippet:
			"Inspect and control Herdr terminals — workspaces, tabs, panes, agents, worktrees (jobs → herd tool)",
		promptGuidelines: [
			"Use `herdr` when the user mentions Herdr or asks to inspect/control terminals, panes, tabs, workspaces, or non-herd agents. Prefer the structured herdr tool over raw `herdr` bash for toolized actions.",
			"To see terminals outside the current space or outside the herd: `herdr list` with scope=all (or workspace=<id|label>). Then `herdr read` / `herdr pane_get` with the pane id or unique label.",
			"Herd jobs: use `herd` spawn with difficulty= (and output= for async). Do not herdr-run or pane_split to assign herd work — `herd spawn` boots panes.",
			"Do not loop workspace_focus/tab_list to \"open\" every herd pane; only one workspace can be UI-focused at a time.",
			"When starting a one-off agent or command, default to a sibling pane in the current tab and cwd. Create another tab, workspace, or cwd only when the user requests that topology.",
			"Preserve the current UI focus by default. Set focus only when the user explicitly asks to switch context.",
			"Use `herdr` run to submit a command or agent prompt because text and Enter are sent atomically. Use `herdr` send only for literal text or key injection without command submission semantics.",
			"Use `herdr` watch for normal command output and `herdr` wait_agent only for recognized coding agents.",
			"Treat both `idle` and `done` as completed agent states when inspecting status. `done` means the completed result is unseen; `idle` means it is seen.",
			"Use `recent-unwrapped` for logs and transcripts, and `detection` only when agent-detection evidence is needed.",
			"Pane actions accept friendly aliases, opaque pane ids, or unique pane labels. Workspace/tab params accept opaque ids OR labels. Prefer ids from list/ensure output; never invent ids.",
			"When pane_split omits direction, the `herdr` tool chooses right or down from the source pane geometry.",
			"Use friendly aliases such as `server`, `tests`, or `codex` for panes created by pane_split, tab_create, or workspace_create (not for herd jobs).",
			"Do not close workspaces, tabs, or panes you did not create unless the user explicitly asked.",
		],
		parameters: Type.Object({
			action: ActionEnum,
			pane: Type.Optional(Type.String({ description: "Friendly pane alias, explicit pane id, or unique pane label. For pane_split, omit to split the agent's own pane." })),
			panes: Type.Optional(Type.Array(Type.String(), { description: "Pane aliases or pane ids for multi-pane waits" })),
			workspace: Type.Optional(
				Type.String({
					description:
						"Workspace id (e.g. w1K) or label (e.g. local-model / main) for workspace/tab/list/worktree actions",
				}),
			),
			tab: Type.Optional(
				Type.String({
					description:
						"Tab id (e.g. w1K:t1) or label for tab actions / focus(tab) / pane_move. Pane actions must use pane ids, aliases, or labels.",
				}),
			),
			scope: Type.Optional(ListScopeEnum),
			label: Type.Optional(Type.String({ description: "Label for create, rename, pane_split, worktree, or notify title" })),
			newPane: Type.Optional(Type.String({ description: "Alias to remember for the pane created by pane_split" })),
			direction: Type.Optional(DirectionEnum),
			moveTo: Type.Optional(MoveTargetEnum),
			zoom: Type.Optional(ZoomModeEnum),
			agent: Type.Optional(Type.String({ description: "Agent name, terminal id, or pane id for agent_get" })),
			command: Type.Optional(Type.String({ description: "Line to submit atomically with Enter (for run action)" })),
			match: Type.Optional(Type.String({ description: "Text or regex to wait for (for watch action)" })),
			regex: Type.Optional(Type.Boolean({ description: "Treat match as a regex (for watch action)" })),
			status: Type.Optional(StatusEnum),
			statuses: Type.Optional(Type.Array(StatusEnum, { description: "Accepted agent statuses for wait_agent" })),
			mode: Type.Optional(WaitModeEnum),
			timeout: Type.Optional(Type.Number({ description: "Timeout in ms (for watch or wait_agent action)" })),
			lines: Type.Optional(Type.Number({ description: "Scrollback lines to capture or inspect" })),
			source: Type.Optional(SourceEnum),
			raw: Type.Optional(Type.Boolean({ description: "Disable ANSI stripping for read/watch" })),
			text: Type.Optional(Type.String({ description: "Literal text to send without Enter (for send action), or notification body (notify)" })),
			keys: Type.Optional(
				Type.String({
					description: "Keys to send, space-separated (for send action). Examples: C-c, Enter, q, y",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for workspace_create, tab_create, pane_split, and worktree actions" })),
			path: Type.Optional(Type.String({ description: "Filesystem path for worktree open/create" })),
			branch: Type.Optional(Type.String({ description: "Git branch for worktree create/open" })),
			base: Type.Optional(Type.String({ description: "Base ref for worktree create" })),
			force: Type.Optional(Type.Boolean({ description: "Force worktree remove" })),
			title: Type.Optional(Type.String({ description: "Notification title (notify); falls back to label" })),
			position: Type.Optional(NotifyPositionEnum),
			sound: Type.Optional(NotifySoundEnum),
			focus: Type.Optional(Type.Boolean({ description: "Explicitly change focus for create/focus/move actions. Defaults should preserve current focus." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const currentPane = await getCurrentPaneInfo(signal);
			const currentPaneId = currentPane.pane_id;
			const currentWorkspaceId = currentPane.workspace_id;

			switch (params.action) {
				case "list": {
					const scope = params.scope ?? (params.workspace ? "workspace" : "current");
					const aliasByPaneId = new Map<string, string>();
					for (const [alias, managed] of managedPanes.entries()) {
						aliasByPaneId.set(managed.paneId, alias);
					}

					const workspaces = await getWorkspaceList(signal);
					let groups: Array<{ workspace: WorkspaceInfo; panes: PaneInfo[] }> = [];

					if (scope === "all") {
						for (const workspace of workspaces) {
							const panes = await getWorkspacePanes(workspace.workspace_id, signal);
							groups.push({ workspace, panes });
						}
					} else if (scope === "workspace") {
						if (!params.workspace) throw new Error("'workspace' is required when scope=workspace");
						const workspace = resolveWorkspaceRef(params.workspace, workspaces);
						const panes = await getWorkspacePanes(workspace.workspace_id, signal);
						groups = [{ workspace, panes }];
					} else {
						const workspace =
							workspaces.find((w) => w.workspace_id === currentWorkspaceId) ??
							({
								workspace_id: currentWorkspaceId,
								number: 0,
								label: "",
								focused: true,
								pane_count: 0,
								tab_count: 0,
								active_tab_id: currentPane.tab_id,
								agent_status: currentPane.agent_status,
							} satisfies WorkspaceInfo);
						const panes = await getWorkspacePanes(currentWorkspaceId, signal);
						groups = [{ workspace, panes }];
					}

					const flatPanes = groups.flatMap((g) => g.panes);
					const text =
						scope === "all" || scope === "workspace"
							? formatPaneInventory(groups, currentPaneId, aliasByPaneId)
							: flatPanes.length
								? flatPanes
										.map((pane) => summarizePane(pane, aliasByPaneId.get(pane.pane_id), currentPaneId))
										.join("\n")
								: "No panes in current workspace.";

					return {
						content: [{ type: "text", text }],
						details: withSnapshot({
							action: "list",
							scope,
							panes: flatPanes,
							groups: groups.map((g) => ({
								workspaceId: g.workspace.workspace_id,
								label: g.workspace.label,
								paneIds: g.panes.map((p) => p.pane_id),
							})),
							currentPaneId,
							workspaceId: scope === "current" ? currentWorkspaceId : params.workspace,
							paneAliases: Object.fromEntries(aliasByPaneId),
						}),
					};
				}

				case "current": {
					return {
						content: [{ type: "text", text: summarizePane(currentPane, undefined, currentPaneId) }],
						details: withSnapshot({ action: "current", pane: currentPane }),
					};
				}

				case "workspace_list": {
					const workspaces = await getWorkspaceList(signal);
					const text = workspaces.length
						? workspaces.map(summarizeWorkspace).join("\n")
						: "No workspaces.";
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "workspace_list", workspaces }),
					};
				}

				case "workspace_create": {
					const args = ["workspace", "create"];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson<{
						result: { workspace: WorkspaceInfo; root_pane?: PaneInfo };
					}>(args, signal);
					const workspace = response.result.workspace;
					const rootPane =
						response.result.root_pane ?? (await getWorkspacePanes(workspace.workspace_id, signal))[0] ?? null;
					if (params.pane && rootPane) {
						recordAlias(params.pane, rootPane.pane_id, workspace.workspace_id);
					}
					const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
					const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
					return {
						content: [{
							type: "text",
							text: `Created workspace '${workspace.label}' (${workspace.workspace_id})${rootPaneText}`,
						}],
						details: withSnapshot({
							action: "workspace_create",
							workspace,
							rootPaneId: rootPane?.pane_id,
							pane: params.pane,
						}),
					};
				}

				case "workspace_focus": {
					const workspaceRef = params.workspace;
					if (!workspaceRef) throw new Error("'workspace' is required for workspace_focus");
					const workspace = await requireWorkspaceRef(workspaceRef, signal);
					const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
						"workspace",
						"focus",
						workspace.workspace_id,
					], signal);
					return {
						content: [{
							type: "text",
							text: `Focused workspace '${response.result.workspace.label}' (${response.result.workspace.workspace_id})`,
						}],
						details: withSnapshot({ action: "workspace_focus", workspace: response.result.workspace }),
					};
				}

				case "workspace_rename": {
					const workspaceRef = params.workspace;
					if (!workspaceRef) throw new Error("'workspace' is required for workspace_rename");
					if (!params.label) throw new Error("'label' is required for workspace_rename");
					const workspace = await requireWorkspaceRef(workspaceRef, signal);
					const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
						"workspace",
						"rename",
						workspace.workspace_id,
						params.label,
					], signal);
					return {
						content: [{
							type: "text",
							text: `Renamed workspace ${workspace.workspace_id} → '${params.label}'`,
						}],
						details: withSnapshot({ action: "workspace_rename", workspace: response.result.workspace }),
					};
				}

				case "workspace_close": {
					const workspaceRef = params.workspace;
					if (!workspaceRef) throw new Error("'workspace' is required for workspace_close");
					const workspace = await requireWorkspaceRef(workspaceRef, signal);
					if (workspace.workspace_id === currentWorkspaceId) {
						throw new Error("Refusing to close the workspace pi is running in.");
					}
					await execHerdr(["workspace", "close", workspace.workspace_id], signal);
					return {
						content: [{
							type: "text",
							text: `Closed workspace '${workspace.label || workspace.workspace_id}' (${workspace.workspace_id})`,
						}],
						details: withSnapshot({ action: "workspace_close", workspaceId: workspace.workspace_id }),
					};
				}

				case "tab_list": {
					const workspaceId = params.workspace
						? (await requireWorkspaceRef(params.workspace, signal)).workspace_id
						: currentWorkspaceId;
					const tabs = await getTabList(workspaceId, signal);
					const text = tabs.length ? tabs.map(summarizeTab).join("\n") : "No tabs.";
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "tab_list", tabs, workspaceId }),
					};
				}

				case "tab_create": {
					const workspaceId = params.workspace
						? (await requireWorkspaceRef(params.workspace, signal)).workspace_id
						: currentWorkspaceId;
					const args = ["tab", "create", "--workspace", workspaceId];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson<{ result: { tab: TabInfo; root_pane?: PaneInfo } }>(args, signal);
					const tab = response.result.tab;
					const rootPane =
						response.result.root_pane ??
						(await getWorkspacePanes(tab.workspace_id, signal)).find((pane) => pane.tab_id === tab.tab_id) ??
						null;
					if (params.pane && rootPane) {
						recordAlias(params.pane, rootPane.pane_id, tab.workspace_id);
					}
					const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
					const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
					return {
						content: [{ type: "text", text: `Created tab '${tab.label}' (${tab.tab_id})${rootPaneText}` }],
						details: withSnapshot({
							action: "tab_create",
							tab,
							rootPaneId: rootPane?.pane_id,
							pane: params.pane,
						}),
					};
				}

				case "tab_focus": {
					const tabRef = params.tab;
					if (!tabRef) throw new Error("'tab' is required for tab_focus");
					const tab = await requireTabRef(tabRef, params.workspace, signal);
					const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", tab.tab_id], signal);
					return {
						content: [{
							type: "text",
							text: `Focused tab '${response.result.tab.label}' (${response.result.tab.tab_id})`,
						}],
						details: withSnapshot({ action: "tab_focus", tab: response.result.tab }),
					};
				}

				case "tab_rename": {
					const tabRef = params.tab;
					if (!tabRef) throw new Error("'tab' is required for tab_rename");
					if (!params.label) throw new Error("'label' is required for tab_rename");
					const tab = await requireTabRef(tabRef, params.workspace, signal);
					const response = await execHerdrJson<{ result: { tab: TabInfo } }>(
						["tab", "rename", tab.tab_id, params.label],
						signal,
					);
					return {
						content: [{ type: "text", text: `Renamed tab ${tab.tab_id} → '${params.label}'` }],
						details: withSnapshot({ action: "tab_rename", tab: response.result.tab }),
					};
				}

				case "tab_close": {
					const tabRef = params.tab;
					if (!tabRef) throw new Error("'tab' is required for tab_close");
					const tab = await requireTabRef(tabRef, params.workspace, signal);
					if (tab.tab_id === currentPane.tab_id) {
						throw new Error("Refusing to close the tab pi is running in.");
					}
					await execHerdr(["tab", "close", tab.tab_id], signal);
					return {
						content: [{ type: "text", text: `Closed tab '${tab.label || tab.tab_id}' (${tab.tab_id})` }],
						details: withSnapshot({ action: "tab_close", tabId: tab.tab_id }),
					};
				}

				case "focus": {
					if (params.tab) {
						const tab = await requireTabRef(params.tab, params.workspace, signal);
						const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", tab.tab_id], signal);
						return {
							content: [{
								type: "text",
								text: `Focused tab '${response.result.tab.label}' (${response.result.tab.tab_id})`,
							}],
							details: withSnapshot({ action: "focus", target: "tab", tab: response.result.tab }),
						};
					}
					if (params.workspace) {
						const workspace = await requireWorkspaceRef(params.workspace, signal);
						const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
							"workspace",
							"focus",
							workspace.workspace_id,
						], signal);
						return {
							content: [{
								type: "text",
								text: `Focused workspace '${response.result.workspace.label}' (${response.result.workspace.workspace_id})`,
							}],
							details: withSnapshot({ action: "focus", target: "workspace", workspace: response.result.workspace }),
						};
					}
					if (params.pane) {
						const resolved = await requirePaneRef(params.pane, signal);
						const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(
							["agent", "focus", resolved.pane.pane_id],
							signal,
						);
						return {
							content: [{ type: "text", text: `Focused pane '${resolved.alias || resolved.pane.pane_id}'` }],
							details: withSnapshot({ action: "focus", target: "pane", agent: response.result.agent }),
						};
					}
					throw new Error("'workspace', 'tab', or 'pane' is required for focus");
				}

				case "pane_get": {
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for pane_get");
					const resolved = await requirePaneRef(paneRef, signal, params.workspace);
					const pane = resolved.pane;
					const text = [
						summarizePane(pane, resolved.alias, currentPaneId),
						`workspace=${pane.workspace_id} tab=${pane.tab_id}`,
						pane.terminal_id ? `terminal=${pane.terminal_id}` : null,
						pane.title ? `title=${pane.title}` : null,
						`revision=${pane.revision}`,
					]
						.filter(Boolean)
						.join("\n");
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "pane_get", pane, alias: resolved.alias }),
					};
				}

				case "pane_rename": {
					rejectUnexpectedParams("pane_rename", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for pane_rename");
					if (!params.label) throw new Error("'label' is required for pane_rename");
					const resolved = await requirePaneRef(paneRef, signal);
					const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(
						["pane", "rename", resolved.pane.pane_id, params.label],
						signal,
					);
					return {
						content: [{ type: "text", text: `Renamed pane '${resolved.alias || paneRef}' to '${params.label}'` }],
						details: withSnapshot({ action: "pane_rename", pane: response.result.pane, alias: resolved.alias }),
					};
				}

				case "pane_split": {
					rejectUnexpectedParams("pane_split", params, ["workspace", "tab"]);
					const paneRef = params.pane ?? currentPaneId;
					const sourcePane = await requirePaneRef(paneRef, signal);
					const direction = params.direction ?? chooseSplitDirection(
						await getPaneLayout(sourcePane.pane.pane_id, signal),
						sourcePane.pane.pane_id,
					);
					const args = ["pane", "split", sourcePane.pane.pane_id, "--direction", direction];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.focus !== true) args.push("--no-focus");

					const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(args, signal);
					const splitPane = response.result.pane;
					const paneLabel = params.label ?? params.newPane;
					if (paneLabel) {
						await execHerdrJson(["pane", "rename", splitPane.pane_id, paneLabel], signal);
					}
					if (params.newPane) {
						recordAlias(params.newPane, splitPane.pane_id, splitPane.workspace_id);
					}

					const sourceLabel = sourcePane.alias || paneRef;
					const aliasText = params.newPane ? `, aliased as '${params.newPane}'` : "";
					return {
						content: [{
							type: "text",
							text: `Created pane '${splitPane.pane_id}' by splitting '${sourceLabel}' ${direction}${aliasText}`,
						}],
						details: withSnapshot({
							action: "pane_split",
							pane: sourceLabel,
							paneId: sourcePane.pane.pane_id,
							newPane: params.newPane || splitPane.pane_id,
							newPaneId: splitPane.pane_id,
							direction,
							workspaceId: splitPane.workspace_id,
						}),
					};
				}

				case "pane_layout": {
					const paneRef = params.pane ?? currentPaneId;
					const resolved = await requirePaneRef(paneRef, signal, params.workspace);
					const layout = await getPaneLayout(resolved.pane.pane_id, signal);
					const lines = [
						`layout for ${resolved.alias || resolved.pane.pane_id}`,
						`workspace=${layout.workspace_id} tab=${layout.tab_id} zoomed=${layout.zoomed}`,
						`focused=${layout.focused_pane_id} area=${layout.area.width}x${layout.area.height}`,
						...layout.panes.map(
							(p) =>
								`  ${p.pane_id}${p.focused ? " (focused)" : ""} @ ${p.rect.x},${p.rect.y} ${p.rect.width}x${p.rect.height}`,
						),
					];
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: withSnapshot({ action: "pane_layout", layout, paneId: resolved.pane.pane_id }),
					};
				}

				case "pane_zoom": {
					const paneRef = params.pane ?? currentPaneId;
					const resolved = await requirePaneRef(paneRef, signal, params.workspace);
					const zoom = params.zoom ?? "toggle";
					const args = ["pane", "zoom", resolved.pane.pane_id];
					if (zoom === "on") args.push("--on");
					else if (zoom === "off") args.push("--off");
					else args.push("--toggle");
					const response = await execHerdrJson<{ result: { layout?: PaneLayoutSnapshot; zoomed?: boolean } }>(
						args,
						signal,
					);
					const zoomed = response.result?.zoomed ?? response.result?.layout?.zoomed;
					return {
						content: [{
							type: "text",
							text: `Zoom ${zoom} on pane '${resolved.alias || resolved.pane.pane_id}'${zoomed != null ? ` (zoomed=${zoomed})` : ""}`,
						}],
						details: withSnapshot({
							action: "pane_zoom",
							paneId: resolved.pane.pane_id,
							zoom,
							zoomed,
						}),
					};
				}

				case "pane_move": {
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for pane_move");
					const moveTo = params.moveTo ?? (params.tab ? "tab" : undefined);
					if (!moveTo) throw new Error("'moveTo' is required for pane_move (tab | new-tab | new-workspace)");
					const resolved = await requirePaneRef(paneRef, signal, params.workspace);
					if (resolved.pane.pane_id === currentPaneId) {
						throw new Error("Refusing to move the pane pi is running in.");
					}
					const args = ["pane", "move", resolved.pane.pane_id];
					if (moveTo === "tab") {
						if (!params.tab) throw new Error("'tab' is required when moveTo=tab");
						const tab = await requireTabRef(params.tab, params.workspace, signal);
						const direction = params.direction ?? "right";
						args.push("--tab", tab.tab_id, "--split", direction);
					} else if (moveTo === "new-tab") {
						args.push("--new-tab");
						if (params.workspace) {
							const workspace = await requireWorkspaceRef(params.workspace, signal);
							args.push("--workspace", workspace.workspace_id);
						}
						if (params.label) args.push("--label", params.label);
					} else {
						args.push("--new-workspace");
						if (params.label) args.push("--label", params.label);
					}
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson<{ result: { pane?: PaneInfo; workspace?: WorkspaceInfo; tab?: TabInfo } }>(
						args,
						signal,
					);
					const moved = response.result?.pane;
					if (moved && resolved.alias) {
						recordAlias(resolved.alias, moved.pane_id, moved.workspace_id);
					}
					return {
						content: [{
							type: "text",
							text: `Moved pane '${resolved.alias || paneRef}' → ${moveTo}` +
								(moved ? ` (now ${moved.pane_id})` : ""),
						}],
						details: withSnapshot({
							action: "pane_move",
							moveTo,
							paneId: moved?.pane_id ?? resolved.pane.pane_id,
							alias: resolved.alias,
							result: response.result,
						}),
					};
				}

				case "agent_list": {
					const agents = await getAgentList(signal);
					return {
						content: [{ type: "text", text: agents.length ? agents.map(summarizeAgent).join("\n") : "No agents." }],
						details: withSnapshot({ action: "agent_list", agents }),
					};
				}

				case "agent_get": {
					let target = params.agent ?? params.pane;
					if (!target) throw new Error("'agent' or 'pane' is required for agent_get");
					if (managedPanes.has(target)) {
						target = (await requirePaneRef(target, signal)).pane.pane_id;
					}
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(["agent", "get", target], signal);
					return {
						content: [{ type: "text", text: summarizeAgent(response.result.agent) }],
						details: withSnapshot({ action: "agent_get", agent: response.result.agent }),
					};
				}

				case "run": {
					rejectUnexpectedParams("run", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					const command = params.command;
					if (!paneRef) throw new Error("'pane' is required for run");
					if (!command) throw new Error("'command' is required for run");

					const targetPane = await requirePaneRef(paneRef, signal);
					await execHerdr(["pane", "run", targetPane.pane.pane_id, command], signal);

					await sleep(800, signal);
					const initialOutput = await readPane(
						targetPane.pane.pane_id,
						{
							source: params.source ?? "recent",
							lines: params.lines ?? 20,
							raw: params.raw,
						},
						signal,
					);

					const paneLabel = targetPane.alias || paneRef;
					return {
						content: [
							{
								type: "text",
								text: `Started '${command}' in pane '${paneLabel}' (${targetPane.pane.pane_id})\n\n${formatReadOutput(initialOutput)}`,
							},
						],
						details: withSnapshot({
							action: "run",
							pane: paneLabel,
							paneId: targetPane.pane.pane_id,
							command,
							workspaceId: targetPane.pane.workspace_id,
						}),
					};
				}

				case "read": {
					rejectUnexpectedParams("read", params, ["tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for read");

					const resolved = await requirePaneRef(paneRef, signal, params.workspace);

					const output = await readPane(
						resolved.pane.pane_id,
						{
							source: params.source ?? "recent",
							lines: params.lines ?? 20,
							raw: params.raw,
						},
						signal,
					);

					return {
						content: [{ type: "text", text: formatReadOutput(output) }],
						details: withSnapshot({
							action: "read",
							pane: resolved.alias || paneRef,
							paneId: resolved.pane.pane_id,
							source: params.source ?? "recent",
						}),
					};
				}

				case "watch": {
					rejectUnexpectedParams("watch", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					const match = params.match;
					if (!paneRef) throw new Error("'pane' is required for watch");
					if (!match) throw new Error("'match' is required for watch");
					if (params.source === "detection") throw new Error("watch does not support the detection source; use read");

					const resolved = await requirePaneRef(paneRef, signal);
					const paneLabel = resolved.alias || paneRef;
					const startTime = Date.now();

					const publishWatchUpdate = () => {
						onUpdate?.({
							content: [{ type: "text", text: `Watching ${paneLabel}...` }],
							details: withSnapshot({
								action: "watch",
								pane: paneLabel,
								paneId: resolved.pane.pane_id,
								match,
								elapsed: Math.floor((Date.now() - startTime) / 1000),
							}),
						});
					};

					publishWatchUpdate();
					const updateTimer = onUpdate ? setInterval(publishWatchUpdate, 1000) : null;

					try {
						const args = ["wait", "output", resolved.pane.pane_id, "--match", match];
						if (params.source) args.push("--source", params.source);
						if (params.lines != null) args.push("--lines", String(params.lines));
						if (params.timeout != null) args.push("--timeout", String(params.timeout));
						if (params.regex) args.push("--regex");
						if (params.raw) args.push("--raw");

						const response = await execHerdrJson<{
							result: {
								type: string;
								pane_id: string;
								revision: number;
								matched_line: string;
								read: PaneReadResult;
							};
						}>(args, signal);
						const matched = response.result;
						const text = matched.read?.text ? formatReadOutput(matched.read.text) : matched.matched_line;

						return {
							content: [{ type: "text", text: `Matched: ${matched.matched_line}\n\n${text}` }],
							details: withSnapshot({
								action: "watch",
								pane: paneLabel,
								paneId: resolved.pane.pane_id,
								matchedLine: matched.matched_line,
								elapsed: Math.floor((Date.now() - startTime) / 1000),
							}),
						};
					} finally {
						if (updateTimer) clearInterval(updateTimer);
					}
				}

				case "wait_agent": {
					rejectUnexpectedParams("wait_agent", params, ["workspace", "tab"]);
					throwIfAborted(signal, "wait_agent");
					const paneRefs = params.panes?.length ? params.panes : params.pane ? [params.pane] : [];
					const statuses = params.statuses?.length ? params.statuses : params.status ? [params.status] : [];
					const mode = params.mode ?? "all";
					if (!paneRefs.length) throw new Error("'pane' or 'panes' is required for wait_agent");
					if (!statuses.length) throw new Error("'status' or 'statuses' is required for wait_agent");

					const resolvedPanes: Array<{ pane: PaneInfo; aliasOrRef: string }> = [];
					for (const paneRef of paneRefs) {
						throwIfAborted(signal, "wait_agent");
						const resolved = await requirePaneRef(paneRef, signal);
						resolvedPanes.push({
							pane: resolved.pane,
							aliasOrRef: resolved.alias || paneRef,
						});
					}

					const deadline = params.timeout != null ? Date.now() + params.timeout : null;
					let snapshot: Array<{
						pane: string;
						paneId: string;
						status: AgentStatus;
						agent?: string;
					}> = [];

					while (true) {
						throwIfAborted(signal, "wait_agent");
						snapshot = [];
						for (const resolved of resolvedPanes) {
							throwIfAborted(signal, "wait_agent");
							const pane = await getPaneInfo(resolved.pane.pane_id, signal);
							if (!pane) throw new Error(`Pane '${resolved.aliasOrRef}' no longer exists.`);
							snapshot.push({
								pane: resolved.aliasOrRef,
								paneId: pane.pane_id,
								status: pane.agent_status,
								agent: pane.agent,
							});
						}

						const satisfied =
							mode === "all"
								? snapshot.every((item) => statuses.includes(item.status))
								: snapshot.some((item) => statuses.includes(item.status));
						if (satisfied) break;
						if (deadline != null && Date.now() >= deadline) {
							throw new Error(
								`Timed out waiting for panes [${snapshot.map((item) => item.pane).join(", ")}] to reach ${mode} of statuses '${formatStatusList(statuses)}'. Last statuses: ${snapshot.map((item) => `${item.pane}=${item.status}`).join(", ")}`,
							);
						}
						await sleepWithSignal(250, signal);
					}

					const summary = snapshot.map((item) => `${item.pane}=${item.status}`).join(", ");
					return {
						content: [{
							type: "text",
							text: `wait_agent satisfied (${mode}: ${formatStatusList(statuses)})\n\n${summary}`,
						}],
						details: withSnapshot({
							action: "wait_agent",
							pane: paneRefs.length === 1 ? resolvedPanes[0]?.aliasOrRef : undefined,
							panes: snapshot.map((item) => item.pane),
							paneIds: snapshot.map((item) => item.paneId),
							status: paneRefs.length === 1 && statuses.length === 1 ? snapshot[0]?.status : undefined,
							statuses,
							mode,
							agents: snapshot.map((item) => item.agent).filter(Boolean),
							snapshot,
						}),
					};
				}

				case "send": {
					rejectUnexpectedParams("send", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for send");
					if (!params.text && !params.keys) throw new Error("'text' or 'keys' is required for send");

					const resolved = await requirePaneRef(paneRef, signal);

					if (params.text) {
						await execHerdr(["pane", "send-text", resolved.pane.pane_id, params.text], signal);
					}
					if (params.keys) {
						const keys = params.keys.split(/\s+/).filter(Boolean);
						await execHerdr(["pane", "send-keys", resolved.pane.pane_id, ...keys], signal);
					}

					const desc = [params.text && `"${params.text}"`, params.keys].filter(Boolean).join(" + ");
					return {
						content: [{ type: "text", text: `Sent ${desc} to pane '${resolved.alias || paneRef}'` }],
						details: withSnapshot({
							action: "send",
							pane: resolved.alias || paneRef,
							paneId: resolved.pane.pane_id,
							text: params.text,
							keys: params.keys,
						}),
					};
				}

				case "stop": {
					rejectUnexpectedParams("stop", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for stop");

					const resolved = await requirePaneRef(paneRef, signal);
					if (resolved.pane.pane_id === currentPaneId) {
						throw new Error("Refusing to close the pane pi is running in.");
					}

					await execHerdr(["pane", "close", resolved.pane.pane_id], signal);
					if (resolved.alias) forgetAlias(resolved.alias);

					return {
						content: [{ type: "text", text: `Closed pane '${resolved.alias || paneRef}'` }],
						details: withSnapshot({
							action: "stop",
							pane: resolved.alias || paneRef,
							paneId: resolved.pane.pane_id,
						}),
					};
				}

				case "notify": {
					const title = params.title ?? params.label;
					if (!title) throw new Error("'title' or 'label' is required for notify");
					const args = ["notification", "show", title];
					if (params.text) args.push("--body", params.text);
					if (params.position) args.push("--position", params.position);
					if (params.sound) args.push("--sound", params.sound);
					await execHerdr(args, signal);
					return {
						content: [{ type: "text", text: `Notification: ${title}` }],
						details: withSnapshot({ action: "notify", title, body: params.text }),
					};
				}

				case "worktree_list": {
					const args = ["worktree", "list", "--json"];
					if (params.workspace) {
						const workspace = await requireWorkspaceRef(params.workspace, signal);
						args.push("--workspace", workspace.workspace_id);
					} else if (params.cwd) {
						args.push("--cwd", params.cwd);
					}
					const response = await execHerdrJson(args, signal);
					const text = typeof response.result === "string"
						? response.result
						: JSON.stringify(response.result ?? response, null, 2);
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "worktree_list", result: response.result }),
					};
				}

				case "worktree_create": {
					const args = ["worktree", "create", "--json"];
					if (params.workspace) {
						const workspace = await requireWorkspaceRef(params.workspace, signal);
						args.push("--workspace", workspace.workspace_id);
					} else if (params.cwd) {
						args.push("--cwd", params.cwd);
					}
					if (params.branch) args.push("--branch", params.branch);
					if (params.base) args.push("--base", params.base);
					if (params.path) args.push("--path", params.path);
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson(args, signal);
					return {
						content: [{ type: "text", text: `Created worktree${params.branch ? ` branch=${params.branch}` : ""}` }],
						details: withSnapshot({ action: "worktree_create", result: response.result }),
					};
				}

				case "worktree_open": {
					const args = ["worktree", "open", "--json"];
					if (params.workspace) {
						const workspace = await requireWorkspaceRef(params.workspace, signal);
						args.push("--workspace", workspace.workspace_id);
					} else if (params.cwd) {
						args.push("--cwd", params.cwd);
					}
					if (params.path) args.push("--path", params.path);
					else if (params.branch) args.push("--branch", params.branch);
					else throw new Error("'path' or 'branch' is required for worktree_open");
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson(args, signal);
					return {
						content: [{ type: "text", text: `Opened worktree${params.branch ? ` branch=${params.branch}` : params.path ? ` path=${params.path}` : ""}` }],
						details: withSnapshot({ action: "worktree_open", result: response.result }),
					};
				}

				case "worktree_remove": {
					if (!params.workspace) throw new Error("'workspace' is required for worktree_remove");
					const workspace = await requireWorkspaceRef(params.workspace, signal);
					if (workspace.workspace_id === currentWorkspaceId) {
						throw new Error("Refusing to remove the worktree for the workspace pi is running in.");
					}
					const args = ["worktree", "remove", "--workspace", workspace.workspace_id, "--json"];
					if (params.force) args.push("--force");
					const response = await execHerdrJson(args, signal);
					return {
						content: [{ type: "text", text: `Removed worktree workspace ${workspace.workspace_id}` }],
						details: withSnapshot({ action: "worktree_remove", result: response.result }),
					};
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			let text = theme.fg("toolTitle", theme.bold("herdr "));
			text += theme.fg("accent", args.action || "?");
			if (args.workspace) text += theme.fg("muted", ` ${args.workspace}`);
			if (args.tab) text += theme.fg("muted", ` ${args.tab}`);
			if (args.scope) text += theme.fg("dim", ` scope=${args.scope}`);
			if (args.pane) text += theme.fg("muted", ` ${args.pane}`);
			if (args.agent) text += theme.fg("muted", ` ${args.agent}`);
			if (Array.isArray(args.panes) && args.panes.length) text += theme.fg("muted", ` ${args.panes.join(",")}`);
			if (args.moveTo) text += theme.fg("dim", ` › ${args.moveTo}`);
			if (args.direction) text += theme.fg("dim", ` › ${args.direction}`);
			if (args.zoom) text += theme.fg("dim", ` › zoom=${args.zoom}`);
			if (args.command) text += theme.fg("dim", ` › ${args.command}`);
			if (args.newPane) text += theme.fg("muted", ` ${args.newPane}`);
			if (args.label) text += theme.fg("muted", ` “${args.label}”`);
			if (args.title) text += theme.fg("muted", ` “${args.title}”`);
			if (args.branch) text += theme.fg("dim", ` branch=${args.branch}`);
			if (args.path) text += theme.fg("dim", ` ${args.path}`);
			if (args.match) text += theme.fg("dim", ` › ${args.match}`);
			if (args.status) text += theme.fg("dim", ` › ${args.status}`);
			if (Array.isArray(args.statuses) && args.statuses.length) text += theme.fg("dim", ` › ${args.statuses.join("|")}`);
			if (args.mode) text += theme.fg("dim", ` ${args.mode}`);
			if (args.text) text += theme.fg("dim", ` › \"${args.text}\"`);
			if (args.keys) text += theme.fg("dim", ` › ${args.keys}`);

			component.setText(text);
			return component;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as Record<string, any> | undefined;
			const state = context.state as { watchElapsed?: number };
			if (context.args?.action === "watch") {
				if (isPartial) {
					state.watchElapsed = typeof details?.elapsed === "number" ? details.elapsed : 0;
					const pane = details?.pane || context.args?.pane || "?";
					return new Text(
						theme.fg("warning", `◌ watching ${pane}`) + theme.fg("dim", ` (${state.watchElapsed}s)`),
						0,
						0,
					);
				}
				delete state.watchElapsed;
			}
			if (!details) {
				const content = result.content?.[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			switch (details.action) {
				case "current": {
					const pane = details.pane as PaneInfo;
					return new Text(theme.fg("accent", `◎ ${pane.label || pane.pane_id}`), 0, 0);
				}
				case "pane_rename": {
					const pane = details.pane as PaneInfo;
					return new Text(theme.fg("accent", `✎ ${details.alias || pane.pane_id}`) + theme.fg("dim", ` › ${pane.label || "renamed"}`), 0, 0);
				}
				case "pane_split": {
					let text = theme.fg("accent", `▥ ${details.newPane || details.newPaneId}`);
					text += theme.fg("dim", ` ‹ ${details.direction} from ${details.pane}`);
					return new Text(text, 0, 0);
				}
				case "run": {
					let text = theme.fg("success", `▶ ${details.pane}`);
					text += theme.fg("dim", ` › ${details.command}`);
					return new Text(text, 0, 0);
				}
				case "read": {
					let text = theme.fg("accent", `📄 ${details.pane}`);
					if (expanded) {
						const content = result.content?.[0];
						if (content?.type === "text") {
							const outputLines = content.text.split("\n").slice(0, 40);
							text += "\n" + outputLines.map((line: string) => theme.fg("dim", line)).join("\n");
						}
					}
					return new Text(text, 0, 0);
				}
				case "watch": {
					let text = theme.fg("success", `✓ ${details.pane}`);
					text += theme.fg("dim", ` › ${details.matchedLine}`);
					if (typeof details.elapsed === "number") text += theme.fg("muted", ` (took ${details.elapsed}s)`);
					return new Text(text, 0, 0);
				}
				case "wait_agent": {
					const panes = Array.isArray(details.panes) && details.panes.length ? details.panes : details.pane ? [details.pane] : [];
					const statuses = Array.isArray(details.statuses) && details.statuses.length
						? details.statuses
						: details.status
							? [details.status]
							: [];
						let text = theme.fg("success", `◎ ${panes.join(", ")}`);
						if (statuses.length) text += theme.fg("dim", ` › ${statuses.join("|")}`);
						if (details.mode) text += theme.fg("muted", ` (${details.mode})`);
						return new Text(text, 0, 0);
				}
				case "send": {
					const desc = [details.text && `"${details.text}"`, details.keys].filter(Boolean).join(" + ");
					return new Text(theme.fg("accent", `⏎ ${details.pane} › ${desc}`), 0, 0);
				}
				case "stop": {
					return new Text(theme.fg("warning", `■ ${details.pane}`), 0, 0);
				}
				case "pane_get": {
					const pane = details.pane as PaneInfo;
					return new Text(theme.fg("accent", `◎ ${details.alias || pane.label || pane.pane_id}`), 0, 0);
				}
				case "pane_layout": {
					return new Text(theme.fg("accent", `▦ layout ${details.paneId}`), 0, 0);
				}
				case "pane_zoom": {
					return new Text(theme.fg("accent", `⬚ zoom ${details.zoom} ${details.paneId}`), 0, 0);
				}
				case "pane_move": {
					return new Text(theme.fg("accent", `⇄ ${details.alias || details.paneId} › ${details.moveTo}`), 0, 0);
				}
				case "notify": {
					return new Text(theme.fg("accent", `🔔 ${details.title}`), 0, 0);
				}
				case "worktree_list":
				case "worktree_create":
				case "worktree_open":
				case "worktree_remove": {
					return new Text(theme.fg("accent", `⎇ ${details.action}`), 0, 0);
				}
				case "workspace_create":
				case "workspace_focus":
				case "workspace_rename": {
					return new Text(theme.fg("accent", `▣ ${details.workspace?.label || details.workspace?.workspace_id || details.workspaceId}`), 0, 0);
				}
				case "workspace_close": {
					return new Text(theme.fg("warning", `▣ closed ${details.workspaceId}`), 0, 0);
				}
				case "tab_create":
				case "tab_focus":
				case "tab_rename": {
					return new Text(theme.fg("accent", `▤ ${details.tab?.label || details.tab?.tab_id || details.tabId}`), 0, 0);
				}
				case "tab_close": {
					return new Text(theme.fg("warning", `▤ closed ${details.tabId}`), 0, 0);
				}
				case "focus": {
					return new Text(theme.fg("accent", `◎ ${details.target}`), 0, 0);
				}
				case "agent_list": {
					const agents = details.agents as AgentInfo[];
					if (!agents?.length) return new Text(theme.fg("dim", "no agents"), 0, 0);
					return new Text(
						agents.map((agent) => `${statusDot(theme, agent.agent_status)} ${theme.fg(agent.focused ? "accent" : "muted", agentDisplayName(agent))} ${theme.fg("dim", agent.agent_status)}`).join("\n"),
						0,
						0,
					);
				}
				case "agent_get": {
					const agent = details.agent as AgentInfo;
					return new Text(`${statusDot(theme, agent.agent_status)} ${theme.fg("accent", agentDisplayName(agent))} ${theme.fg("dim", agent.agent_status)}`, 0, 0);
				}
				case "workspace_list": {
					const workspaces = details.workspaces as WorkspaceInfo[];
					if (!workspaces?.length) return new Text(theme.fg("dim", "no workspaces"), 0, 0);
					const lines = workspaces.map((workspace) => {
						const dot = statusDot(theme, workspace.agent_status);
						const id = theme.fg(workspace.focused ? "accent" : "muted", workspace.workspace_id);
						const extra = [
							workspace.label && workspace.label !== workspace.workspace_id ? workspace.label : null,
							workspace.agent_status !== "unknown" ? workspace.agent_status : null,
						]
							.filter(Boolean)
							.join(" ");
						return `${dot} ${id}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				case "tab_list": {
					const tabs = details.tabs as TabInfo[];
					if (!tabs?.length) return new Text(theme.fg("dim", "no tabs"), 0, 0);
					const lines = tabs.map((tab) => {
						const dot = statusDot(theme, tab.agent_status);
						const id = theme.fg(tab.focused ? "accent" : "muted", tab.tab_id);
						const extra = [
							tab.label && tab.label !== tab.tab_id ? tab.label : null,
							tab.agent_status !== "unknown" ? tab.agent_status : null,
						]
							.filter(Boolean)
							.join(" ");
						return `${dot} ${id}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				case "list": {
					const panes = details.panes as PaneInfo[];
					if (!panes?.length) return new Text(theme.fg("dim", "no panes"), 0, 0);
					const paneAliases = (details.paneAliases || {}) as Record<string, string>;
					const lines = panes.map((pane) => {
						const dot = statusDot(theme, pane.agent_status);
						const label = paneAliases[pane.pane_id]
							? theme.fg("accent", paneAliases[pane.pane_id])
							: theme.fg("muted", pane.pane_id);
						const extra = [pane.agent, pane.agent_status !== "unknown" ? pane.agent_status : null].filter(Boolean).join(" ");
						return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				default: {
					const content = result.content?.[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
			}
		},
	});
}
