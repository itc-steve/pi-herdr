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
import { spawnJob, type SpawnParams } from "../src/herd/spawn.ts";
import { buildHandoffKick } from "../src/handoff.ts";
import { parseHerdConfig, defaultConfigObject } from "../src/config.ts";
import { pickDoEntry } from "../src/resolve-model.ts";
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
    writeFileSync(path, "x");
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
      modelInUse: () => 0,
      thinkLoad: () => 0,
      claimThinkPick: (catalog: { model: string; thinking: string }[]) => ({
        entry: catalog[0]!,
        queued: false,
      }),
      releaseThinkHold: () => {},
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
      params: { task: "review", output: "review.md" },
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

describe("handoff kick", () => {
  it("banners local vs think", () => {
    const local = buildHandoffKick({
      task: "edit foo.ts",
      runDir: "/run",
      reads: [],
      output: "out.md",
      local: true,
      role: "do",
    });
    assert.match(local, /LOCAL worker/);
    const think = buildHandoffKick({
      task: "review",
      runDir: "/run",
      reads: [],
      output: "rev.md",
      local: false,
      role: "think",
    });
    assert.match(think, /THINK pass/);
  });
});

describe("slash parse", () => {
  it("parses spawn kv", () => {
    const p = parseHerdSlashArgs(
      `spawn role=think output=context.md task="Do the thing"`,
    );
    assert.equal(p.action, "spawn");
    assert.equal(p.role, "think");
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

describe("private spawn contract", () => {
  type Harness = {
    config: ReturnType<typeof parseHerdConfig>;
    herdr: HerdrClient;
    monitor: HerdMonitor;
    localLock: ReturnType<typeof createLocalStreamLock>;
    state: ReturnType<typeof createHerdState>;
    createTabCalls: () => number;
    bootedCmds: () => string[];
    slotLanes: () => Array<Record<string, unknown>>;
  };

  function spawnHarness(privateEnabled: boolean): Harness {
    const sessionDir = mkdtempSync(join(tmpdir(), "herd-pvt-"));
    const defaults = defaultConfigObject();
    const config = parseHerdConfig({
      ...defaults,
      sessionDir,
      private: { enabled: privateEnabled },
      local: { ...(defaults.local as object), preflight: false },
    });
    createRun(sessionDir, "pvt-test");
    const pane = {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t2",
      focused: false,
      agent: "pi",
      agent_status: "idle" as const,
      revision: 1,
    };
    let status: "idle" | "working" = "idle";
    let createTabCalls = 0;
    const booted: string[] = [];
    const slotLanes: Array<Record<string, unknown>> = [];
    const herdr = {
      getCurrentPaneInfo: async () =>
        ({ ...pane, pane_id: "w1:p1", tab_id: "w1:t1" }),
      getTabList: async () => [],
      createTab: async () => {
        createTabCalls++;
        return { tab: { tab_id: pane.tab_id, workspace_id: "w1" }, paneId: pane.pane_id };
      },
      renamePane: async () => {},
      readPane: async () => "$ ",
      runInPane: async (_paneId: string, command: string) => {
        booted.push(command);
        if (!command.includes("pi --model")) status = "working";
      },
      getPaneInfo: async () => ({ ...pane, agent_status: status }),
    } as unknown as HerdrClient;
    const monitor = {
      inFlightLaneClaims: () => [],
      reserveSlot: async (_signal?: unknown, lane?: Record<string, unknown>) => {
        slotLanes.push(lane ?? {});
        return "slot-1";
      },
      modelInUse: () => 0,
      thinkLoad: () => 0,
      claimThinkPick: (catalog: { model: string; thinking: string }[]) => ({
        entry: catalog[0]!,
        queued: false,
      }),
      claimDoPick: (
        catalog: { model: string; thinking: string }[],
        localModel: string,
        localInUse: number,
        localMax: number,
        localEnabled: boolean,
        _jobId: string,
      ) =>
        pickDoEntry(catalog, {
          localModel,
          localInUse,
          localMax,
          localEnabled,
          load: () => 0,
        }),
      releaseThinkHold: () => {},
      attachAndWatch: () => ({}),
      releaseTicket: () => {},
    } as unknown as HerdMonitor;
    return {
      config,
      herdr,
      monitor,
      localLock: createLocalStreamLock(1),
      state: createHerdState(),
      createTabCalls: () => createTabCalls,
      bootedCmds: () => booted,
      slotLanes: () => slotLanes,
    };
  }

  function spawnOpts(h: Harness, params: SpawnParams) {
    return {
      config: h.config,
      params,
      state: h.state,
      localLock: h.localLock,
      herdr: h.herdr,
      monitor: h.monitor,
    };
  }

  it("private kick banner replaces the generic LOCAL worker banner", () => {
    const kick = buildHandoffKick({
      task: "rotate the token",
      runDir: "/run",
      reads: [],
      output: "out.md",
      private: true,
      local: true,
      role: "do",
    });
    assert.match(kick, /PRIVATE LOCAL helper/);
    assert.match(kick, /status: done \| blocked/);
    assert.match(kick, /Never return secret values/);
    assert.ok(!kick.includes("LOCAL worker"));
  });

  it("slash spawn private=true parses to private === true", () => {
    const p = parseHerdSlashArgs(
      `spawn private=true task="x" output=a.md`,
    ) as Record<string, unknown>;
    assert.equal(p.action, "spawn");
    assert.equal(p.private, true);
    assert.equal(p.task, "x");
    assert.equal(p.output, "a.md");
  });

  it("private=true with private.enabled=false throws before boot", async () => {
    const h = spawnHarness(false);
    await assert.rejects(
      spawnJob(spawnOpts(h, {
        task: "use [PRIVATE:GitHub Token]",
        output: "o.md",
        private: true,
      })),
      /"private": \{ "enabled": true \}/,
    );
    assert.equal(h.createTabCalls(), 0);
  });

  it("private + role=think (or difficulty=hard) throws", async () => {
    const h = spawnHarness(true);
    await assert.rejects(
      spawnJob(spawnOpts(h, { task: "t", output: "o.md", private: true, role: "think" })),
      /local do only/,
    );
    await assert.rejects(
      spawnJob(spawnOpts(h, { task: "t", output: "o.md", private: true, difficulty: "hard" })),
      /local do only/,
    );
    assert.equal(h.createTabCalls(), 0);
  });

  it("private + model= that is not the local model throws", async () => {
    const h = spawnHarness(true);
    await assert.rejects(
      spawnJob(spawnOpts(h, {
        task: "t",
        output: "o.md",
        private: true,
        model: "grok-cli/grok-4.6",
      })),
      /must be exactly the local model/,
    );
    assert.equal(h.createTabCalls(), 0);
  });

  it("private worker cannot spawn any nested job", async () => {
    const h = spawnHarness(true);
    assert.equal(h.localLock.tryAcquire("j00"), true);
    process.env.PI_HERD_PRIVATE = "1";
    try {
      await assert.rejects(
        spawnJob({
          ...spawnOpts(h, { task: "t", output: "o.md" }),
          parentSignal: AbortSignal.timeout(30),
        }),
        /cannot spawn further jobs/,
      );
      await assert.rejects(
        spawnJob({
          ...spawnOpts(h, { task: "t", output: "o.md", role: "think" }),
          parentSignal: AbortSignal.timeout(30),
        }),
        /cannot spawn further jobs/,
      );
    } finally {
      delete process.env.PI_HERD_PRIVATE;
      h.localLock.release("j00");
    }
    assert.equal(h.createTabCalls(), 0);
    assert.equal(h.localLock.queued(), 0);
  });

  it("allows literal [PRIVATE: text when private mode is disabled", async () => {
    const h = spawnHarness(false);
    await spawnJob(spawnOpts(h, {
      task: "test [PRIVATE: marker handling",
      output: "o.md",
    }));
    assert.equal(h.createTabCalls(), 1);
  });

  it("requires private=true when task or reads contains a private marker", async () => {
    const h = spawnHarness(true);
    for (const params of [
      { task: "use [PRIVATE:value]", output: "o.md" },
      { task: "use context", reads: "[PRIVATE:value]", output: "o.md" },
    ]) {
      await assert.rejects(spawnJob(spawnOpts(h, params)), /private=true/);
    }
    assert.equal(h.createTabCalls(), 0);
  });

  it("rejects private spawn when local execution is disabled", async () => {
    const h = spawnHarness(true);
    h.config.local.enabled = false;
    await assert.rejects(
      spawnJob(spawnOpts(h, { task: "t", output: "o.md", private: true })),
      /local.enabled=true/,
    );
    assert.equal(h.createTabCalls(), 0);
  });

  it("accepted private spawn uses portable env and marks handle private", async () => {
    const h = spawnHarness(true);
    const res = await spawnJob(
      spawnOpts(h, { task: "rotate the token", output: "o.md", private: true }),
    );
    assert.equal(h.createTabCalls(), 1);
    assert.ok(
      h.bootedCmds().some((c) => c.startsWith("env PI_HERD_PRIVATE=1 pi --model")),
    );
    assert.equal((res.handle as { private?: boolean } | undefined)?.private, true);
  });

  it("do[] extra spawn reserves its slot with the shared per-model cap (slotMax=1)", async () => {
    const h = spawnHarness(false);
    h.config.do = [{ model: "grok-cli/grok-build", thinking: "medium" }];
    h.config.maxModelConcurrent = 1; // single local seat taken → extra
    h.localLock.tryAcquire("j00");
    try {
      await spawnJob(spawnOpts(h, { task: "t", output: "o.md" }));
    } finally {
      h.localLock.release("j00");
    }
    assert.equal(h.createTabCalls(), 1);
    const lane = h.slotLanes()[0]!;
    assert.equal(lane.model, "grok-cli/grok-build");
    assert.equal(lane.slotMax, 1);
  });
});
