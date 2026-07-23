import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveWorkspaceRef,
  resolvePaneRefByLabel,
} from "../src/herdr/resolve.ts";

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
