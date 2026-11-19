import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTerminalClient, detectTerminalRuntime } from "../src/herdr/runtime.ts";

describe("terminal runtime detection", () => {
  it("constructs only the selected client without starting or probing a runtime", () => {
    let calls = 0;
    const exec = async () => { calls++; return { stdout: "{}", stderr: "", code: 0 }; };
    assert.equal(createTerminalClient(exec, {}), null);
    assert.ok("createTab" in createTerminalClient(exec, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!);
    const core = createTerminalClient(exec, { HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: "/tmp/explicit.sock" });
    assert.equal(core?.kind, "core");
    assert.ok(core && !("createTab" in core));
    assert.equal(createTerminalClient(exec, { HC_TERMINAL_ID: "t3", HC_SESSION: "ovis" }), null);
    assert.equal(calls, 0);
  });

  it("requires complete Herdr TUI markers", () => {
    assert.equal(detectTerminalRuntime({}), null);
    assert.equal(detectTerminalRuntime({ HERDR_ENV: "1" }), null);
    assert.equal(detectTerminalRuntime({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" }), null);
    assert.deepEqual(detectTerminalRuntime({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), {
      kind: "herdr", paneId: "w1:p1",
    });
  });

  it("uses the core's inherited endpoint without guessing from a session name", () => {
    assert.deepEqual(detectTerminalRuntime({ HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: "/tmp/own-core.sock" }), {
      kind: "core", terminalId: "t3", socketPath: "/tmp/own-core.sock",
    });
    assert.equal(detectTerminalRuntime({ HC_TERMINAL_ID: "t3", HC_SESSION: "ovis" }), null);
    assert.equal(detectTerminalRuntime({ HC_TERMINAL_SOCKET: "/tmp/own-core.sock" }), null);
  });

  it("prefers the caller's core socket over an unrelated client override", () => {
    assert.deepEqual(detectTerminalRuntime({
      HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: "/tmp/own-core.sock", HC_SOCKET: "/tmp/other-core.sock",
    }), { kind: "core", terminalId: "t3", socketPath: "/tmp/own-core.sock" });
    assert.deepEqual(detectTerminalRuntime({ HC_TERMINAL_ID: "t3", HC_SOCKET: "/tmp/explicit-core.sock" }), {
      kind: "core", terminalId: "t3", socketPath: "/tmp/explicit-core.sock",
    });
  });

  it("preserves native Windows named-pipe paths", () => {
    const socketPath = String.raw`\\.\pipe\herdr-core-user-ovis`;
    assert.deepEqual(detectTerminalRuntime({ HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: socketPath }), {
      kind: "core", terminalId: "t3", socketPath,
    });
  });

  it("keeps complete TUI identity authoritative when both runtimes are inherited", () => {
    assert.deepEqual(detectTerminalRuntime({
      HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: "/tmp/core.sock",
    }), { kind: "herdr", paneId: "w1:p1" });
  });

  it("does not treat blank identities or endpoints as usable runtimes", () => {
    assert.equal(detectTerminalRuntime({ HERDR_ENV: "1", HERDR_PANE_ID: " " }), null);
    assert.equal(detectTerminalRuntime({ HC_TERMINAL_ID: " ", HC_TERMINAL_SOCKET: "/tmp/core.sock" }), null);
    assert.equal(detectTerminalRuntime({ HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: " " }), null);
  });
});
