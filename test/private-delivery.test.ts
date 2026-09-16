import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReply,
  formatHerdResultMessage,
  type JobHandle,
} from "../src/herd/boot.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import { redactForCloud } from "../src/private.ts";

// Fake secrets only — never real values.
const GITHUB_FAKE = `ghp_${"a1b2C3".repeat(6)}`; // ghp_ + 36 alnum
const AWS_FAKE = "AKIAQ7X9M2B4N6P8R0T1";

const sanitize = (text: string): string => redactForCloud(text).redacted;

function fakeHerdr(readText: string): HerdrClient {
  return {
    readPane: async () => readText,
  } as unknown as HerdrClient;
}

function makeHandle(dir: string, extra: Partial<JobHandle> = {}): JobHandle {
  return {
    jobId: "j-test",
    label: "test",
    paneId: "p1",
    workspaceId: "w1",
    sessionFile: join(dir, "session.jsonl"),
    watermark: 0,
    taskPreview: "task",
    model: "vllm/Qwen/Qwen3.6-27B-FP8",
    thinking: "medium",
    local: true,
    role: "do",
    ...extra,
  };
}

function writeSession(
  file: string,
  opts: { assistantText?: string } = {},
): void {
  const lines = [
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "user",
        content: [{ type: "text", text: "do the thing" }],
      },
    }),
  ];
  if (opts.assistantText) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: "m2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: opts.assistantText }],
        },
      }),
    );
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
}

describe("collectReply sanitize chokepoint", () => {
  it("sanitizes the session reply before return", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-pd-"));
    writeSession(join(dir, "session.jsonl"), {
      assistantText: `value ${GITHUB_FAKE} end`,
    });
    const collected = await collectReply({
      herdr: fakeHerdr("should not be read"),
      handle: makeHandle(dir, { private: true }),
      sanitize,
    });
    assert.equal(collected.source, "session");
    assert.ok(!collected.reply.includes(GITHUB_FAKE));
    assert.ok(collected.reply.includes("[PRIVATE:"));
  });

  it("sanitizes the scrollback fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-pd-"));
    // User message only → session grew but no assistant text → scrollback.
    writeSession(join(dir, "session.jsonl"));
    const scrollback = `❯ /task\nsecret handed over: ${GITHUB_FAKE}\ndone ok`;
    const collected = await collectReply({
      herdr: fakeHerdr(scrollback),
      handle: makeHandle(dir),
      sanitize,
    });
    assert.equal(collected.source, "scrollback");
    assert.ok(!collected.reply.includes(GITHUB_FAKE));
    assert.ok(collected.reply.includes("[PRIVATE:"));
  });

  it("output-file fallback write uses sanitized text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-pd-"));
    const out = join(dir, "out.md");
    writeSession(join(dir, "session.jsonl"), {
      assistantText: `value ${GITHUB_FAKE} end`,
    });
    await collectReply({
      herdr: fakeHerdr("unused"),
      handle: makeHandle(dir, { outputPath: out }),
      sanitize,
    });
    const written = readFileSync(out, "utf8");
    assert.ok(!written.includes(GITHUB_FAKE));
    assert.ok(written.includes("[PRIVATE:"));
  });

  it("identity sanitize leaves values (local parent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-pd-"));
    writeSession(join(dir, "session.jsonl"), {
      assistantText: `value ${GITHUB_FAKE} end`,
    });
    const collected = await collectReply({
      herdr: fakeHerdr("unused"),
      handle: makeHandle(dir),
      sanitize: (t) => t,
    });
    assert.ok(collected.reply.includes(GITHUB_FAKE));
  });

  it("no sanitize leaves values (default identity)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-pd-"));
    writeSession(join(dir, "session.jsonl"), {
      assistantText: `value ${GITHUB_FAKE} end`,
    });
    const collected = await collectReply({
      herdr: fakeHerdr("unused"),
      handle: makeHandle(dir),
    });
    assert.ok(collected.reply.includes(GITHUB_FAKE));
  });
});

describe("formatHerdResultMessage after sanitize", () => {
  it("truncates AFTER sanitize: marker at char 0 survives 4000 slice", () => {
    // Secret at char 0; raw reply > 4000 so format must truncate the
    // ALREADY-redacted text (raw value gone before the slice is taken).
    const reply = `${AWS_FAKE}\n${"x".repeat(4_200)}`;
    const sanitized = sanitize(reply);
    assert.ok(!sanitized.includes(AWS_FAKE));
    assert.ok(sanitized.includes("[PRIVATE:"));

    const msg = formatHerdResultMessage({
      jobId: "j1",
      label: "job",
      status: "done",
      role: "do",
      model: "m",
      thinking: "off",
      taskPreview: "task",
      reply: sanitized,
      resultDelivery: "full",
    });
    assert.ok(!msg.includes(AWS_FAKE));
    assert.ok(msg.includes("[PRIVATE:"));
    assert.ok(msg.includes("…(truncated)"));
  });

  it("error field carries caller-sanitized text", () => {
    const error = sanitize(`failed: ${AWS_FAKE}`);
    const msg = formatHerdResultMessage({
      jobId: "j1",
      label: "job",
      status: "failed",
      role: "do",
      model: "m",
      thinking: "off",
      taskPreview: "task",
      error,
    });
    assert.ok(!msg.includes(AWS_FAKE));
    assert.ok(msg.includes("[PRIVATE:"));
  });
});
