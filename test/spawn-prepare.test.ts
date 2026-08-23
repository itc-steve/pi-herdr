import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createAndBootJob,
  scrollbackLooksLikeShellPrompt,
  isOutputReady,
  taskPreview,
} from "../src/herd/boot.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHerdSlashArgs,
  HerdSlashHelpError,
  getHerdSlashCompletions,
} from "../src/herd/slash.ts";
import { spawnJob } from "../src/herd/spawn.ts";
import { parseHerdConfig, defaultConfigObject } from "../src/config.ts";
import { createLocalStreamLock } from "../src/local-lock.ts";
import { createHerdState } from "../src/state.ts";
import { createRun } from "../src/runs.ts";
import type { HerdMonitor } from "../src/herd/monitor.ts";

describe("boot helpers", () => {
  it("detects shell prompts", () => {
    assert.equal(scrollbackLooksLikeShellPrompt("user@host ~/proj ❯"), true);
    assert.equal(scrollbackLooksLikeShellPrompt("neofetch output\n"), false);
    assert.equal(scrollbackLooksLikeShellPrompt("$ "), true);
  });

  it("isOutputReady respects baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-out-"));
    const path = join(dir, "o.md");
    writeFileSync(path, "hi");
    assert.equal(isOutputReady(path, 0), true);
    assert.equal(isOutputReady(path, 2), false);
    writeFileSync(path, "hello");
    assert.equal(isOutputReady(path, 2), true);
  });

  it("taskPreview truncates", () => {
    assert.ok(taskPreview("a".repeat(200)).endsWith("…"));
  });

  it("creates jobs as tabs in the current workspace", async () => {
    let createdWorkspace = false;
    let createdTabWorkspace = "";
    const pane = {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t2",
      focused: false,
      agent: "pi",
      agent_status: "idle" as const,
      revision: 1,
    };
    const herdr = {
      getCurrentPaneInfo: async () => ({ ...pane, pane_id: "w1:p1", tab_id: "w1:t1" }),
      getTabList: async () => [],
      createTab: async ({ workspaceId }: { workspaceId: string }) => {
        createdTabWorkspace = workspaceId;
        return { tab: { tab_id: pane.tab_id, workspace_id: workspaceId }, paneId: pane.pane_id };
      },
      createWorkspace: async () => {
        createdWorkspace = true;
        throw new Error("workspace creation must not be used");
      },
      renamePane: async () => {},
      readPane: async () => "$ ",
      runInPane: async () => {},
      getPaneInfo: async () => pane,
    } as unknown as HerdrClient;

    const result = await createAndBootJob({
      herdr,
      label: "job-01",
      cwd: "/repo",
      bootCmd: "pi",
      sessionFile: "/tmp/job-01.jsonl",
      timeoutMs: 5_000,
    });

    assert.equal(createdTabWorkspace, "w1");
    assert.equal(createdWorkspace, false);
    assert.deepEqual(result, { paneId: "w1:p2", workspaceId: "w1" });
  });
});

describe("spawn lifecycle", () => {
  it("does not tie an async monitor to the spawning tool signal", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "herd-signal-"));
    const defaults = defaultConfigObject();
    const config = parseHerdConfig({
      ...defaults,
      sessionDir,
      local: { ...(defaults.local as object), preflight: false },
    });
    createRun(sessionDir, "signal-test");

    let status: "idle" | "working" = "idle";
    const pane = {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t2",
      focused: false,
      agent: "pi",
      agent_status: status,
      revision: 1,
    };
    const herdr = {
      getCurrentPaneInfo: async () => ({ ...pane, pane_id: "w1:p1", tab_id: "w1:t1" }),
      getTabList: async () => [],
      createTab: async () => ({ tab: { tab_id: pane.tab_id, workspace_id: "w1" }, paneId: pane.pane_id }),
      renamePane: async () => {},
      readPane: async () => "$ ",
      runInPane: async (_paneId: string, command: string) => {
        if (!command.startsWith("pi ")) status = "working";
      },
      getPaneInfo: async () => ({ ...pane, agent_status: status }),
    } as unknown as HerdrClient;

    let watched: Record<string, unknown> | undefined;
    const monitor = {
      inFlightLaneClaims: () => [],
      reserveSlot: async () => "slot-1",
      attachAndWatch: (opts: Record<string, unknown>) => {
        watched = opts;
        return {};
      },
      releaseTicket: () => {},
    } as unknown as HerdMonitor;
    const localLock = createLocalStreamLock(1);
    const controller = new AbortController();

    await spawnJob({
      config,
      params: { task: "review", difficulty: "easy", output: "review.md" },
      state: createHerdState(),
      localLock,
      herdr,
      monitor,
      parentSignal: controller.signal,
    });

    assert.ok(watched);
    assert.equal("parentSignal" in watched, false);
    localLock.release("j01");
  });
});

describe("slash parse", () => {
  it("parses spawn kv", () => {
    const p = parseHerdSlashArgs(
      `spawn difficulty=easy output=context.md task="Do the thing"`,
    );
    assert.equal(p.action, "spawn");
    assert.equal(p.difficulty, "easy");
    assert.equal(p.output, "context.md");
    assert.equal(p.task, "Do the thing");
  });

  it("help throws", () => {
    assert.throws(() => parseHerdSlashArgs("help"), HerdSlashHelpError);
  });

  it("completions are AutocompleteItem objects (not bare strings)", () => {
    const all = getHerdSlashCompletions("");
    assert.ok(all && all.length > 0);
    for (const item of all) {
      assert.equal(typeof item.value, "string");
      assert.equal(typeof item.label, "string");
      assert.ok(item.value.length > 0);
      assert.ok(item.label.length > 0);
    }
    const filtered = getHerdSlashCompletions("sp");
    assert.ok(filtered?.some((i) => i.value === "spawn"));
    const run = getHerdSlashCompletions("run ");
    assert.ok(run?.every((i) => typeof i.value === "string" && i.value.length));
  });
});
