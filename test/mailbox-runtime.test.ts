import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createMailbox } from "../src/herd/mailbox.ts";
import { bindWorkerMailbox } from "../src/herd/mailbox-worker.ts";

it("real Pi loop consumes cross-process mail before settling, without network or idle wakeup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herd-pi-mail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const box = createMailbox(join(root, "mail"));
  box.register("frontend", "Frontend"); box.activate("frontend");
  box.register("backend", "Backend");
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { bindWorkerMailbox(pi, { box, jobId: "backend" }); }] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: faux.getModel(),
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [], thinkingLevel: "off" });
  t.after(() => session.dispose());
  faux.setResponses([
    () => {
      assert.equal(box.peer("backend").status, "active");
      execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
        'const { openMailbox } = await import(process.argv[1]); openMailbox(process.argv[2]).send("frontend", "backend", "Which PATCH fields?");',
        new URL("../src/herd/mailbox.ts", import.meta.url).href, box.dir], { timeout: 10_000 });
      return fauxAssistantMessage("Initial task finished.");
    },
    (context) => {
      assert.match(JSON.stringify(context.messages), /Which PATCH fields\?/);
      assert.equal(box.messages()[0]!.status, "delivered");
      assert.equal(box.isFinished("backend"), false, "lanes must remain held during message-driven continuation");
      return fauxAssistantMessage("Both fields are optional.");
    },
  ]);
  await session.prompt("Implement the API.");
  assert.equal(faux.state.callCount, 2);
  assert.equal(session.isIdle, true);
  assert.equal(box.isFinished("backend"), true);
  assert.equal(box.send("frontend", "backend", "Late follow-up").status, "recipient-finished");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(faux.state.callCount, 2, "late mail must not trigger another model call");
  assert.ok(session.messages.some((m) => m.role === "custom" && m.customType === "herd-peer"));
});
