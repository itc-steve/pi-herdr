/** Shared types for pi-herdr. */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type Difficulty = "easy" | "medium" | "hard";

export type IsolationMode = "none" | "worktree";

export type SessionPolicy = "per-job";

export interface CatalogEntry {
  model: string;
  thinking: string;
  /** When true, consumes a local stream slot (maxStreams). */
  local?: boolean;
}

export interface LocalConfig {
  enabled: boolean;
  model: string;
  thinking: string;
  maxStreams: number;
  preflight: boolean;
}

export interface HerdDefaults {
  isolation: IsolationMode;
  timeoutMs: number;
  waitForReply: boolean;
  requireOutput: boolean;
}

export interface HerdConfig {
  sessionDir: string;
  sessionPolicy: SessionPolicy;
  maxModelConcurrent: number; // max in-flight jobs per exact provider/model string
  local: LocalConfig;
  easy: CatalogEntry[];
  medium: CatalogEntry[];
  hard: CatalogEntry[];
  defaults: HerdDefaults;
}

export interface ResolvedModel {
  model: string;
  thinking: string;
  local: boolean;
  difficulty: Difficulty;
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
  difficulty: Difficulty;
  runId: string | null;
  outputPath?: string;
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
  difficulty: Difficulty;
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
