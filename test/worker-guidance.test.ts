import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

it("exposes workers at startup and replaces only owned prompt contributions on every normal/custom run", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "herd-guidance-"));
  const keys = ["HOME", "HERDR_ENV", "PI_HERD_WORKER", "PI_HERD_PRIVATE"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  for (const key of keys.slice(1)) delete process.env[key];
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const configPath = join(agentDir, "herd.json");
  const writeConfig = (name: string, enabled: boolean) => writeFileSync(configPath, JSON.stringify({
    workers: { [name]: { model: "test-provider/test-model", thinking: "low", maxConcurrent: 2,
      description: "Fast codebase mapping; avoid large implementations." }, local: { model: "vllm/local-test", thinking: "medium", maxConcurrent: 1 } },
    local: { model: "vllm/local-test" }, private: { enabled },
  }));
  writeConfig("scout", false);
  const { default: register } = await import("../index.ts");
  const extension = await loadExtensionFromFactory(register, home, createEventBus(), createExtensionRuntime());
  const emit = async (name: string, event: unknown, ctx: unknown) => {
    for (const handler of extension.handlers.get(name) ?? []) assert.equal(await handler(event, ctx), undefined);
  };
  t.after(() => emit("session_shutdown", {}, {}));
  const tool = extension.tools.get("herd")!.definition;
  const startup = tool.promptGuidelines!.join("\n");
  assert.match(startup, /scout: test-provider\/test-model:low/);
  assert.match(startup, /2 concurrent/);
  assert.match(startup, /Fast codebase mapping/);
  assert.match(startup, /private: off/);
  assert.doesNotMatch(startup, /Privacy protection is enabled|startup snapshot/);

  const cloud = { model: { provider: "cloud", id: "model" } };
  const options = {
    promptGuidelines: ["other global rule"],
    toolGuidelines: { herd: [...tool.promptGuidelines!, "other herd rule"], read: ["other read rule"] },
    sections: { unknown_extension: "keep this verbatim" },
  };
  const check = (worker: string, privacy: boolean) => {
    const all = [...options.promptGuidelines, ...Object.values(options.toolGuidelines).flat(), ...Object.values(options.sections)].join("\n");
    assert.equal(all.split(`${worker}: test-provider/`).length - 1, 1);
    assert.equal(all.split("Privacy protection is enabled").length - 1, privacy ? 1 : 0);
    assert.match(all, /other global rule/);
    assert.match(all, /other herd rule/);
    assert.deepEqual(options.toolGuidelines.read, ["other read rule"]);
    assert.deepEqual(options.sections, { unknown_extension: "keep this verbatim" });
    assert.equal("forceSystemPrompt" in options, false);
    return all;
  };
  await emit("before_agent_start", { messageType: "user", systemPromptOptions: options }, cloud);
  check("scout", false);
  writeConfig("reviewer", true);
  await emit("before_agent_start", { messageType: "custom", message: { customType: "herd-result" }, systemPromptOptions: options }, cloud);
  assert.doesNotMatch(check("reviewer", true), /scout:/);
  await emit("before_agent_start", { messageType: "user", systemPromptOptions: options }, { model: { provider: "vllm", id: "local-test" } });
  check("reviewer", false);
  await emit("before_agent_start", { messageType: "custom", systemPromptOptions: options }, cloud);
  check("reviewer", true);
  writeConfig("reviewer", false);
  await emit("before_agent_start", { messageType: "user", systemPromptOptions: options }, cloud);
  check("reviewer", false);

  // Pi normally clones base tool metadata each run, rather than reusing mutations.
  const fresh = { promptGuidelines: [], toolGuidelines: { herd: [...tool.promptGuidelines!] }, sections: {} };
  await emit("before_agent_start", { messageType: "custom", systemPromptOptions: fresh }, cloud);
  assert.doesNotMatch(JSON.stringify(fresh), /scout:/);
  assert.equal(JSON.stringify(fresh).split("reviewer: test-provider/").length - 1, 1);
});
