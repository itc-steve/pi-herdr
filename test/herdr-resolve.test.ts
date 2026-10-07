import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveWorkspaceRef,
  resolvePaneRefByLabel,
} from "../src/herdr/resolve.ts";
import {
  createHerdrClient,
  statusMatches,
} from "../src/herdr/client.ts";

describe("herdr resolve", () => {
  const workspaces = [
    { workspace_id: "w1", label: "main" },
    { workspace_id: "w2", label: "job-01" },
  ];

  it("resolves by id or label", () => {
    assert.equal(resolveWorkspaceRef("w2", workspaces).label, "job-01");
    assert.equal(resolveWorkspaceRef("main", workspaces).workspace_id, "w1");
  });

  it("errors on missing", () => {
    assert.throws(() => resolveWorkspaceRef("nope", workspaces), /not found/);
  });

  it("resolves panes", () => {
    const panes = [
      { pane_id: "w1:p1", label: "server" },
      { pane_id: "w1:p2", label: "logs" },
    ];
    assert.equal(resolvePaneRefByLabel("server", panes).pane_id, "w1:p1");
  });
});

describe("agent status matching", () => {
  it("treats idle and done as equivalent settled states", () => {
    assert.equal(statusMatches("done", ["idle"]), true);
    assert.equal(statusMatches("idle", ["done"]), true);
    assert.equal(statusMatches("working", ["idle"]), false);
    assert.equal(statusMatches("blocked", ["idle", "done"]), false);
    assert.equal(statusMatches("working", ["working"]), true);
  });

  it("waitAgentStatus uses herdr agent wait idle|done", async () => {
    const calls: string[][] = [];
    const client = createHerdrClient(async (_cmd, args) => {
      calls.push(args);
      return { stdout: "{}", stderr: "", code: 0 };
    });
    await client.waitAgentStatus("p1", "idle", 1000);
    assert.deepEqual(calls[0], [
      "agent",
      "wait",
      "p1",
      "--timeout",
      "1000",
      "--until",
      "idle",
      "--until",
      "done",
    ]);
  });
});
