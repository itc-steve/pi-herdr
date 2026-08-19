import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForJobIdle } from "../src/herd/boot.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import type { AgentStatus, PaneInfo } from "../src/types.ts";

function pane(status: AgentStatus): PaneInfo {
  return {
    pane_id: "p1",
    workspace_id: "w1",
    tab_id: "t1",
    focused: false,
    agent: "pi",
    agent_status: status,
    revision: 1,
  };
}

/** Native wait always times out after a short slice — same as a 600s wall clock. */
function herdr(getStatus: () => AgentStatus): HerdrClient {
  return {
    getPaneInfo: async () => pane(getStatus()),
    waitAgentStatus: async (_p, _s, timeoutMs, signal) => {
      const slice = Math.min(Math.max(1, timeoutMs), 15);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, slice);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      });
      throw new Error("Timed out waiting for agent status");
    },
  } as unknown as HerdrClient;
}

describe("waitForJobIdle", () => {
  it("keeps waiting while pane is working past timeoutMs", async () => {
    const t0 = Date.now();
    const getStatus = (): AgentStatus =>
      Date.now() - t0 < 80 ? "working" : "idle";
    const result = await waitForJobIdle({
      herdr: herdr(getStatus),
      paneId: "p1",
      timeoutMs: 30,
    });
    assert.equal(result.status, "idle");
    assert.equal(result.sawBusy, true);
  });

  it("keeps waiting while pane is blocked past timeoutMs", async () => {
    const t0 = Date.now();
    const getStatus = (): AgentStatus =>
      Date.now() - t0 < 80 ? "blocked" : "idle";
    const result = await waitForJobIdle({
      herdr: herdr(getStatus),
      paneId: "p1",
      timeoutMs: 30,
    });
    assert.equal(result.status, "idle");
    assert.equal(result.sawBusy, true);
  });

  it("still times out when never busy and no evidence", async () => {
    await assert.rejects(
      () =>
        waitForJobIdle({
          herdr: herdr(() => "idle"),
          paneId: "p1",
          timeoutMs: 40,
        }),
      /Timed out waiting/,
    );
  });
});
