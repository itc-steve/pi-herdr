import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPiHolder,
  refreshPiHolder,
  safeSendDisplay,
  safeSendFollowUp,
} from "../src/harness/pi-holder.ts";
import {
  createHerdUiBinder,
  ensureHerdToolsActive,
} from "../src/harness/ui-bind.ts";
import {
  errorText,
  isAbortError,
  softToolResult,
} from "../src/harness/errors.ts";
import {
  getOrCreateLocalLock,
  replaceHarnessDispose,
} from "../src/harness/reload.ts";

describe("harness pi-holder", () => {
  it("safeSendFollowUp uses followUp + triggerTurn", () => {
    const calls: unknown[] = [];
    const pi = {
      sendMessage(msg: unknown, opts?: unknown) {
        calls.push([msg, opts]);
      },
    } as never;
    const holder = createPiHolder(pi);
    safeSendFollowUp(holder, "done", {
      customType: "herd-result",
      details: { jobId: "j1" },
    });
    assert.equal(calls.length, 1);
    const [msg, opts] = calls[0] as [
      { customType: string; content: string; details: { jobId: string } },
      { deliverAs: string; triggerTurn: boolean },
    ];
    assert.equal(msg.customType, "herd-result");
    assert.equal(msg.content, "done");
    assert.equal(msg.details.jobId, "j1");
    assert.equal(opts.deliverAs, "followUp");
    assert.equal(opts.triggerTurn, true);
  });

  it("safeSendFollowUp swallows sync throw and rejects", async () => {
    const pi = {
      sendMessage() {
        throw new Error("stale");
      },
    } as never;
    assert.doesNotThrow(() =>
      safeSendFollowUp(createPiHolder(pi), "x"),
    );

    const piAsync = {
      sendMessage() {
        return Promise.reject(new Error("async stale"));
      },
    } as never;
    assert.doesNotThrow(() =>
      safeSendFollowUp(createPiHolder(piAsync), "y"),
    );
    await new Promise((r) => setTimeout(r, 5));
  });

  it("refreshPiHolder swaps the live API", () => {
    const calls: string[] = [];
    const a = {
      sendMessage() {
        calls.push("a");
      },
    } as never;
    const b = {
      sendMessage() {
        calls.push("b");
      },
    } as never;
    const holder = createPiHolder(a);
    refreshPiHolder(holder, b);
    safeSendDisplay(holder, "hi");
    assert.deepEqual(calls, ["b"]);
  });
});

describe("harness ui-bind", () => {
  it("guards UI when hasUI is false", () => {
    const status: unknown[] = [];
    const widgets: unknown[] = [];
    const ui = createHerdUiBinder();
    ui.bind({
      hasUI: false,
      ui: {
        setStatus: (k: string, t: string | undefined) => status.push([k, t]),
        setWidget: (k: string, c: unknown) => widgets.push([k, c]),
        notify: () => {},
      } as never,
    });
    ui.setStatus("herd: 1");
    ui.setWidgetLines(["x"]);
    assert.equal(status.length, 0);
    assert.equal(widgets.length, 0);
  });

  it("sets status and belowEditor widget when hasUI", () => {
    const status: unknown[] = [];
    const widgets: unknown[] = [];
    const ui = createHerdUiBinder();
    ui.bind({
      hasUI: true,
      ui: {
        setStatus: (k: string, t: string | undefined) => status.push([k, t]),
        setWidget: (k: string, c: unknown, o?: unknown) =>
          widgets.push([k, c, o]),
        notify: () => {},
      } as never,
    });
    ui.setStatus("herd: 1 mon");
    ui.setWidgetLines(["herd monitors (1)"]);
    ui.clear();
    assert.deepEqual(status[0], ["herd", "herd: 1 mon"]);
    assert.equal((widgets[0] as unknown[])[0], "herd-tasks");
    assert.deepEqual((widgets[0] as unknown[])[2], {
      placement: "belowEditor",
    });
    assert.deepEqual(status.at(-1), ["herd", ""]);
  });

  it("ensureHerdToolsActive adds missing tools", () => {
    let active = ["read", "bash"];
    ensureHerdToolsActive({
      getActiveTools: () => active,
      setActiveTools: (t) => {
        active = t;
      },
    });
    assert.ok(active.includes("herd"));
    assert.ok(active.includes("herdr"));
    assert.ok(active.includes("read"));
  });
});

describe("harness errors", () => {
  it("classifies abort and soft-wraps messages", () => {
    assert.equal(isAbortError(new Error("Aborted")), true);
    assert.equal(isAbortError(new Error("boom")), false);
    const ac = new AbortController();
    ac.abort();
    assert.equal(isAbortError(new Error("x"), ac.signal), true);
    assert.equal(errorText(new Error("nope")), "nope");
    const soft = softToolResult("bad args", { action: "spawn" });
    assert.equal(soft.content[0]?.text, "bad args");
    assert.equal(soft.details.error, true);
    assert.equal(soft.details.action, "spawn");
  });
});

describe("harness reload", () => {
  it("reuses local lock and runs previous dispose", () => {
    delete (globalThis as { __piHerdrHarness?: unknown }).__piHerdrHarness;
    const lock1 = getOrCreateLocalLock(1);
    const lock2 = getOrCreateLocalLock(2);
    assert.equal(lock1, lock2);
    assert.equal(lock2.maxStreamsCount(), 2);

    let disposed = 0;
    replaceHarnessDispose(() => {
      disposed += 1;
    });
    replaceHarnessDispose(() => {
      disposed += 10;
    });
    assert.equal(disposed, 1);
    replaceHarnessDispose(() => {});
    assert.equal(disposed, 11);
  });
});
