import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { waitForJobIdle, waitUntilAgentReady, stopAgentInPane, POLL_MS } from "../src/herd/boot.ts";
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
    waitAgentStatus: async (
      _p: string,
      _s: AgentStatus,
      timeoutMs: number,
      signal?: AbortSignal,
    ) => {
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
  it("does not submit /quit as an answer to a blocked prompt during cleanup", async () => {
    let submitted = false;
    const client = {
      getPaneInfo: async () => pane("blocked"),
      runInPane: async () => { submitted = true; },
    } as unknown as HerdrClient;
    await assert.rejects(stopAgentInPane({ herdr: client, paneId: "p1" }), /blocked.*without answering/);
    assert.equal(submitted, false);
  });
  it("does not release a mailbox worker on transient terminal idle before Pi settles", async () => {
    let reads = 0;
    let closed = false;
    const client = { getPaneInfo: async () => {
      reads++;
      if (reads === 1) return pane("working");
      if (reads >= 4) closed = true;
      return pane("idle");
    } } as unknown as HerdrClient;
    const result = await waitForJobIdle({ herdr: client, paneId: "p1", timeoutMs: 3_000,
      mailboxFinished: () => closed });
    assert.equal(result.status, "idle");
    assert.ok(reads >= 4);
  });

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

  it("times out a permanently blocked pane rather than sliding forever", async () => {
    await assert.rejects(waitForJobIdle({
      herdr: herdr(() => "blocked"), paneId: "p1", timeoutMs: 30,
      signal: AbortSignal.timeout(500),
    }), /Timed out.*pane p1.*blocked/);
  });

  for (const resumed of ["working", "idle"] as const) {
    it(`resumes blocked -> ${resumed} before deadline`, async () => {
      let reads = 0;
      const seen: string[] = [];
      const result = await waitForJobIdle({
        herdr: herdr(() => ++reads < 3 ? "blocked" : reads < 7 ? resumed : "done"),
        paneId: "p1", timeoutMs: 200,
        onStatus: status => { seen.push(status); },
      });
      assert.ok(["idle", "done"].includes(result.status));
      assert.deepEqual(seen.slice(0, 2), ["blocked", resumed]);
      assert.equal(seen.filter(s => s === "blocked").length, 1);
    });
  }

  it("caps native boot waits and reports a prompt observed after boot detection", async () => {
    let reads = 0;
    const seen: string[] = [];
    const client = {
      getPaneInfo: async () => pane(++reads <= 2 ? "working" : "blocked"),
      waitAgentStatus: async (_p: string, _s: string, ms: number) => {
        assert.ok(ms <= POLL_MS);
        await new Promise(resolve => setTimeout(resolve, Math.min(ms, 15)));
        throw new Error("Timed out");
      },
    } as unknown as HerdrClient;
    await assert.rejects(waitUntilAgentReady(client, "p1", 600, undefined,
      status => seen.push(status)), /pane p1.*blocked/);
    assert.deepEqual(seen, ["working", "blocked"]);
  });

  it("caps native job waits so a newly blocked prompt is observed promptly", async () => {
    let reads = 0;
    const seen: string[] = [];
    const client = {
      getPaneInfo: async () => pane(++reads === 1 ? "working" : reads === 2 ? "blocked" : "done"),
      waitAgentStatus: async (_p: string, _s: string, ms: number) => {
        assert.ok(ms <= POLL_MS);
        throw new Error("Timed out");
      },
    } as unknown as HerdrClient;
    await waitForJobIdle({ herdr: client, paneId: "p1", timeoutMs: 3_000,
      onStatus: status => seen.push(status) });
    assert.deepEqual(seen, ["working", "blocked", "done"]);
  });

  for (const stopReason of ["aborted", "error", "stop"] as const) {
    it(`checks the final assistant outcome (${stopReason}) even with a ready output`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "herdr-outcome-"));
      try {
        const sessionFile = join(dir, "session.jsonl");
        const outputPath = join(dir, "result.md");
        writeFileSync(outputPath, "artifact");
        writeFileSync(sessionFile, JSON.stringify({ type: "message", message: {
          role: "assistant", content: [{ type: "text", text: "partial" }], stopReason,
        } }) + "\n");
        let reads = 0;
        const pending = waitForJobIdle({
          herdr: herdr(() => ++reads === 1 ? "working" : "done"),
          paneId: "p1", timeoutMs: 100, sessionFile, outputPath,
        });
        if (stopReason === "stop") assert.equal((await pending).status, "done");
        else await assert.rejects(pending, new RegExp(`pane p1.*stopReason=${stopReason}`));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

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

  it("treats done as finished like idle", async () => {
    const t0 = Date.now();
    const getStatus = (): AgentStatus =>
      Date.now() - t0 < 80 ? "working" : "done";
    const result = await waitForJobIdle({
      herdr: herdr(getStatus),
      paneId: "p1",
      timeoutMs: 30,
    });
    assert.equal(result.status, "done");
    assert.equal(result.sawBusy, true);
  });

  it("fails when pane settles without writing its required output", async () => {
    const t0 = Date.now();
    const getStatus = (): AgentStatus =>
      Date.now() - t0 < 20 ? "working" : "idle";

    await assert.rejects(
      () =>
        waitForJobIdle({
          herdr: herdr(getStatus),
          paneId: "p1",
          outputPath: join(tmpdir(), `pi-herdr-missing-${randomUUID()}.md`),
          timeoutMs: 30,
          signal: AbortSignal.timeout(200),
        }),
      /output file is empty\/unchanged/,
    );
  });
});
