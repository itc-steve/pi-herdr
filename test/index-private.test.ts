import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("private-mode extension wiring", () => {
  it("redacts provider context and private-key tool output for cloud models", async (t) => {
    const oldHome = process.env.HOME;
    t.after(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    });
    const home = mkdtempSync(join(tmpdir(), "herd-index-private-"));
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "herd.json"),
      JSON.stringify({
        local: { model: "vllm/local-test", preflight: false },
        private: { enabled: true },
      }),
    );
    process.env.HOME = home;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      },
      registerTool: () => {},
      registerCommand: () => {},
      sendMessage: () => {},
    } as unknown as ExtensionAPI;
    const { default: register } = await import("../index.ts");
    register(pi);

    const context = handlers.get("context");
    const toolResult = handlers.get("tool_result");
    const beforeProviderRequest = handlers.get("before_provider_request");
    assert.ok(context);
    assert.ok(toolResult);
    assert.ok(beforeProviderRequest);
    assert.ok(handlers.has("model_select"));

    const secret = "context-secret-value";
    const messages = [
      {
        role: "bashExecution",
        command: `PASSWORD=${secret}`,
        output: `TOKEN=${secret}`,
      },
      { role: "compactionSummary", summary: `secret is ${secret}` },
      { role: "branchSummary", summary: `password is ${secret}` },
    ];
    const cloud = { model: { provider: "cloud", id: "model" } };
    const contextResult = await context({ messages }, cloud);
    assert.ok(contextResult);
    assert.ok(!JSON.stringify(contextResult).includes(secret));

    const keyBody = "Q0FOQVJZX1VOTEFCRUxMRURfUFJJVkFURV9LRVlfQk9EWQ==";
    const toolResultValue = await toolResult(
      {
        toolName: "grep",
        input: { path: "/home/u/.ssh/id_ed25519" },
        content: [{ type: "text", text: keyBody }],
      },
      cloud,
    );
    assert.ok(toolResultValue);
    assert.ok(!JSON.stringify(toolResultValue).includes(keyBody));

    const bashResult = await toolResult(
      {
        toolName: "bash",
        input: { command: 'tail -n +2 "~/.ssh/id_ed25519"' },
        content: [{ type: "text", text: keyBody }],
      },
      cloud,
    );
    assert.ok(bashResult);
    assert.ok(!JSON.stringify(bashResult).includes(keyBody));

    const providerSecret = `ghp_${"P".repeat(36)}`;
    const providerPayload = { messages: [{ role: "user", content: providerSecret }] };
    const providerResult = await beforeProviderRequest(
      { payload: providerPayload },
      cloud,
    );
    assert.ok(providerResult);
    assert.ok(!JSON.stringify(providerResult).includes(providerSecret));

    const localMessages = [{ role: "custom", content: `token is ${secret}` }];
    assert.equal(
      await context(
        { messages: localMessages },
        { model: { provider: "vllm", id: "local-test" } },
      ),
      undefined,
    );
    assert.ok(JSON.stringify(localMessages).includes(secret));
  });
});
