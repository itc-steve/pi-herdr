import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHandoffKick } from "../src/handoff.ts";

const base = { task: "Check the assigned slice", runDir: "/runs/demo", reads: [] };

describe("worker prompt contracts", () => {
  for (const local of [true, false]) {
    it(`gives ${local ? "local" : "remote"} do workers scope, goal, and verification instructions`, () => {
      const kick = buildHandoffKick({ ...base, local, role: "do" });
      assert.match(kick, local ? /LOCAL worker/ : /DO worker/);
      assert.match(kick, /instruction\.md.*goal and constraints/);
      assert.match(kick, /parent owns orchestration/i);
      assert.match(kick, /Verify.*report.*checks/);
      assert.match(kick, /Do not spawn.*agents/);
      assert.match(kick, /Return your final deliverable in chat/);
      assert.doesNotMatch(kick, /Write output=/);
    });
  }

  it("preserves Markdown contracts and requests criterion-level evidence for do and think", () => {
    const task = [
      "## Objective", "Verify the assigned slice",
      "## Inputs", "src/handoff.ts (project-relative)",
      "## Owns", "None; report only",
      "## Acceptance", "A1: Task text is preserved",
      "## Verification", "Inspect the generated kick",
      "## Stop conditions", "Report missing context instead of guessing",
    ].join("\n");
    for (const role of ["do", "think"] as const) {
      const kick = buildHandoffKick({ ...base, task, role });
      assert.ok(kick.includes(task));
      assert.match(kick, /Follow the assigned task contract/);
      assert.match(kick, /each acceptance criterion.*met \| unmet \| not checked/);
      assert.match(kick, /checks run.*results.*unrun checks/);
      assert.match(kick, /stop condition.*report the blocker/i);
      assert.match(kick, /Plain-text tasks remain valid/);
    }
  });

  it("keeps think focused on evidence and recommendations, not implementation", () => {
    const kick = buildHandoffKick({ ...base, role: "think", output: "review.md" });
    assert.match(kick, /THINK pass/);
    assert.match(kick, /Do not edit project files/);
    assert.match(kick, /evidence.*risks.*recommendations/);
    assert.match(kick, /instruction\.md.*goal and constraints/);
    assert.match(kick, /Write your final deliverable to: \/runs\/demo\/review\.md/);
  });

  it("keeps private work narrow and all reports secret-free without broad context reads", () => {
    const kick = buildHandoffKick({
      ...base, private: true, local: true, role: "do", reads: ["operation.md"], output: "private.md",
    });
    assert.match(kick, /PRIVATE LOCAL helper/);
    assert.match(kick, /Rerun.*locally/);
    assert.match(kick, /Never return secret values/);
    assert.match(kick, /artifacts, logs, errors, or chat/);
    assert.match(kick, /status: done \| blocked/);
    assert.match(kick, /operation\.md/);
    assert.doesNotMatch(kick, /instruction\.md|context\.md|plan\.md|LOCAL worker|Follow the assigned task contract/);
  });

  it("preserves the task, explicit reads, and write lane", () => {
    const kick = buildHandoffKick({
      ...base, reads: ["design.md"], output: "notes/check.md", laneBlock: "ONLY edit src/a.ts",
    });
    assert.ok(kick.includes(base.task));
    assert.match(kick, /- design\.md/);
    assert.match(kick, /ONLY edit src\/a\.ts/);
    assert.match(kick, /Write your final deliverable to: \/runs\/demo\/notes\/check\.md/);
  });
});
