/** Shared workspace/tab/pane id-or-label resolution for the herdr tool. */

export interface WorkspaceRefInfo {
  workspace_id: string;
  label: string;
}

export interface TabRefInfo {
  tab_id: string;
  label: string;
}

export interface PaneRefInfo {
  pane_id: string;
  label?: string;
  workspace_id?: string;
}

export function resolveWorkspaceRef<T extends WorkspaceRefInfo>(
  ref: string,
  workspaces: T[],
): T {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("'workspace' is required");

  const byId = workspaces.find((w) => w.workspace_id === trimmed);
  if (byId) return byId;

  const byLabel = workspaces.filter((w) => (w.label || "").trim() === trimmed);
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) {
    throw new Error(
      `Ambiguous workspace label '${trimmed}': ${byLabel.map((w) => w.workspace_id).join(", ")}. ` +
        `Use an explicit workspace id.`,
    );
  }

  const hints = workspaces
    .slice(0, 8)
    .map((w) => `${w.workspace_id}${w.label ? ` (${w.label})` : ""}`)
    .join(", ");
  throw new Error(
    `Workspace '${trimmed}' not found as id or label.` +
      (hints ? ` Known: ${hints}${workspaces.length > 8 ? ", …" : ""}` : ""),
  );
}

export function resolveTabRef<T extends TabRefInfo>(ref: string, tabs: T[]): T {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("'tab' is required");

  const byId = tabs.find((t) => t.tab_id === trimmed);
  if (byId) return byId;

  const byLabel = tabs.filter((t) => (t.label || "").trim() === trimmed);
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) {
    throw new Error(
      `Ambiguous tab label '${trimmed}': ${byLabel.map((t) => t.tab_id).join(", ")}. ` +
        `Use an explicit tab id.`,
    );
  }

  const hints = tabs
    .slice(0, 8)
    .map((t) => `${t.tab_id}${t.label ? ` (${t.label})` : ""}`)
    .join(", ");
  throw new Error(
    `Tab '${trimmed}' not found as id or label.` +
      (hints ? ` Known: ${hints}${tabs.length > 8 ? ", …" : ""}` : ""),
  );
}

export function resolvePaneRefByLabel<T extends PaneRefInfo>(
  ref: string,
  panes: T[],
): T {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("'pane' is required");

  const byId = panes.find((p) => p.pane_id === trimmed);
  if (byId) return byId;

  const byLabel = panes.filter((p) => (p.label || "").trim() === trimmed);
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) {
    throw new Error(
      `Ambiguous pane label '${trimmed}': ${byLabel
        .map((p) => `${p.pane_id}${p.workspace_id ? ` @ ${p.workspace_id}` : ""}`)
        .join(", ")}. Use an explicit pane id.`,
    );
  }

  const hints = panes
    .slice(0, 8)
    .map((p) => `${p.pane_id}${p.label ? ` (${p.label})` : ""}`)
    .join(", ");
  throw new Error(
    `Pane '${trimmed}' not found as id or label.` +
      (hints ? ` Known: ${hints}${panes.length > 8 ? ", …" : ""}` : ""),
  );
}
