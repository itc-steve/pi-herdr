import type { ManagedJob } from "../types.ts";
import type { LaneClaim } from "../lanes.ts";

export type HerdState = {
  jobs: Record<string, ManagedJob>;
  order: string[];
  activeMonitors: Set<string>;
  namedOutputs: Record<string, string>;
  previous?: string;
};

export function createHerdState(): HerdState {
  return {
    jobs: {},
    order: [],
    activeMonitors: new Set(),
    namedOutputs: {},
  };
}

export function inFlightLaneClaims(state: HerdState): LaneClaim[] {
  const out: LaneClaim[] = [];
  for (const jobId of state.activeMonitors) {
    const job = state.jobs[jobId];
    if (!job?.owns?.length) continue;
    out.push({ key: jobId, owns: job.owns });
  }
  return out;
}

export function formatStatus(
  state: HerdState,
  localInUse: number,
  localMax: number,
  monitorInUse: number,
  monitorMax: number,
): string {
  const lines = [
    `herd status`,
    `local streams: ${localInUse}/${localMax}`,
    `monitors: ${monitorInUse} active (max ${monitorMax}/provider-model)`,
    `jobs tracked: ${state.order.length}`,
    `active monitors: ${state.activeMonitors.size}`,
  ];
  for (const id of state.order.slice(-10)) {
    const j = state.jobs[id];
    if (!j) continue;
    const mon = state.activeMonitors.has(id) ? "ACTIVE" : "idle";
    lines.push(
      `  ${id} ${mon} ${j.difficulty} ${j.model}:${j.thinking}` +
        (j.local ? " [local]" : "") +
        (j.label ? ` (${j.label})` : ""),
    );
  }
  return lines.join("\n");
}
