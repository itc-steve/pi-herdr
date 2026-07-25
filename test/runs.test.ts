import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOutputName,
  resolveHandoffPath,
  HandoffError,
} from "../src/handoff.ts";
import { createRun, getActiveRun, listRuns, requireActiveOrRef, nextJobId } from "../src/runs.ts";
import { appendJournal, completedJobIds } from "../src/journal.ts";
import { ensureJobSessionFile } from "../src/handoff.ts";
import { hasUserMessageAfter } from "../src/readback.ts";
import { mkdirSync } from "node:fs";

describe("handoff sandbox", () => {
  it("resolves under run dir", () => {
    const runDir = mkdtempSync(join(tmpdir(), "herd-ho-"));
    const abs = resolveHandoffPath(runDir, "progress.md");
    assert.ok(abs.startsWith(runDir));
  });

  it("rejects .. and absolute", () => {
    const runDir = mkdtempSync(join(tmpdir(), "herd-ho-"));
    assert.throws(() => resolveHandoffPath(runDir, "../x"), HandoffError);
    assert.throws(() => resolveHandoffPath(runDir, "/etc/passwd"), HandoffError);
  });

  it("rejects reserved output names", () => {
    assert.throws(() => assertOutputName("meta.json"), HandoffError);
  });
});

describe("runs + journal", () => {
  it("creates run templates and active pointer", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "herd-sess-"));
    const { runId, runDir } = createRun(sessionDir, "Auth Bug", "fix it");
    assert.match(runId, /_auth-bug$/);
    assert.equal(getActiveRun(sessionDir), runId);
    assert.ok(listRuns(sessionDir).includes(runId));
    assert.equal(requireActiveOrRef(sessionDir).runId, runId);
    writeFileSync(join(runDir, "instruction.md"), "# ok\n");
  });

  it("appends journal and lists completed", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "herd-sess-"));
    const { runDir } = createRun(sessionDir, "j");
    appendJournal(runDir, {
      jobId: "j01",
      model: "m",
      thinking: "low",
      difficulty: "easy",
      taskPreview: "t",
      status: "ok",
      finishedAt: new Date().toISOString(),
    });
    appendJournal(runDir, {
      jobId: "j02",
      model: "m",
      thinking: "low",
      difficulty: "easy",
      taskPreview: "t",
      status: "error",
      finishedAt: new Date().toISOString(),
    });
    assert.deepEqual(completedJobIds(runDir), ["j01"]);
  });

  it("nextJobId advances past existing sessions and claims jobs/", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "herd-sess-"));
    const { runDir } = createRun(sessionDir, "ids");
    const a = nextJobId(runDir);
    assert.equal(a, "j01");
    ensureJobSessionFile(runDir, a);
    const b = nextJobId(runDir);
    assert.equal(b, "j02");
    // Even without a session file, claim dir blocks reuse
    mkdirSync(join(runDir, "jobs", "j03"), { recursive: true });
    assert.equal(nextJobId(runDir), "j04");
  });

  it("nextJobId exclusive claims never collide under parallel callers", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "herd-sess-"));
    const { runDir } = createRun(sessionDir, "race");
    const ids = Array.from({ length: 20 }, () => nextJobId(runDir));
    assert.equal(new Set(ids).size, 20);
    assert.deepEqual(ids, [
      "j01",
      "j02",
      "j03",
      "j04",
      "j05",
      "j06",
      "j07",
      "j08",
      "j09",
      "j10",
      "j11",
      "j12",
      "j13",
      "j14",
      "j15",
      "j16",
      "j17",
      "j18",
      "j19",
      "j20",
    ]);
  });
});

describe("submit evidence", () => {
  it("hasUserMessageAfter ignores extension noise", () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-sessfile-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "1" }),
        JSON.stringify({ type: "model_change", id: "2" }),
        JSON.stringify({
          type: "custom",
          customType: "caveman-level",
          id: "3",
        }),
        JSON.stringify({
          type: "message",
          id: "4",
          message: {
            role: "user",
            content: [{ type: "text", text: "go" }],
          },
        }),
      ].join("\n") + "\n",
    );
    assert.equal(hasUserMessageAfter(file, 3), true);
    assert.equal(hasUserMessageAfter(file, 4), false);
    assert.equal(hasUserMessageAfter(file, 0), true);
  });
});
