import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scrollbackLooksLikeShellPrompt,
  isOutputReady,
  taskPreview,
} from "../src/herd/boot.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHerdSlashArgs,
  HerdSlashHelpError,
  getHerdSlashCompletions,
} from "../src/herd/slash.ts";

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
