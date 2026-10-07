/** Shared types for pi-herdr. */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** do = local implementer (default) + optional do[] extras. think = ranked frontier catalog. */
export type Role = "do" | "think";

export type IsolationMode = "none" | "worktree";

export type SessionPolicy = "per-job";

export interface CatalogEntry {
  model: string;
  thinking: string;
  /** When true, consumes a local stream slot. */
  local?: boolean;
}

export interface WorkerConfig extends CatalogEntry {
  description: string;
  maxConcurrent: number;
  /** Workers sharing a subscription share this concurrency group. */
  group: string;
}

export type ResultDelivery = "pointer" | "full";

export interface LocalConfig {
  enabled: boolean;
  model: string;
  thinking: string;
  preflight: boolean;
}

export interface PrivateConfig {
  enabled: boolean;
}

export interface HerdDefaults {
  isolation: IsolationMode;
  timeoutMs: number;
  waitForReply: boolean;
  requireOutput: boolean;
  /** herd-result body: pointer (artifact path only) or full reply paste. */
  resultDelivery: ResultDelivery;
  /** Start a parent turn when the last in-flight job finishes. */
  triggerTurnOnResult: boolean;
}

export interface HerdConfig {
  sessionDir: string;
  sessionPolicy: SessionPolicy;
  maxModelConcurrent: number; // local seats AND per exact provider/model string
  local: LocalConfig;
  workers: Record<string, WorkerConfig>;
  /** Extra non-local do models. Bare role=do prefers local; extras only when local seats are full. */
  do: CatalogEntry[];
  /** Ordered frontier rank. Index 0 = best. */
  think: CatalogEntry[];
  private: PrivateConfig;
  defaults: HerdDefaults;
}

export interface ResolvedModel {
  model: string;
  thinking: string;
  local: boolean;
  role: Role;
  /** Why this entry was chosen (for logs/tool output). */
  reason: string;
}

export interface ManagedJob {
  jobId: string;
  label: string;
  paneId: string;
  workspaceId: string;
  sessionFile: string;
  model: string;
  thinking: string;
  local: boolean;
  role: Role;
  runId: string | null;
  outputPath?: string;
  outputBaselineBytes?: number;
  private?: boolean;
  owns?: string[];
  forbid?: string[];
  watermark?: number;
  launchedAt: number;
}

export interface JournalEntry {
  idx: number;
  jobId: string;
  model: string;
  thinking: string;
  role: Role;
  taskPreview: string;
  reads?: string[];
  output?: string;
  resultPath?: string;
  status: "ok" | "error" | "aborted";
  finishedAt: string;
  error?: string;
}

export interface AgentInfo {
  terminal_id: string;
  name?: string;
  agent?: string;
  display_agent?: string;
  title?: string;
  agent_status: AgentStatus;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd?: string;
  revision: number;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id?: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  agent?: string;
  title?: string;
  agent_status: AgentStatus;
  revision: number;
}

export interface HerdrJsonEnvelope {
  id?: string;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}
