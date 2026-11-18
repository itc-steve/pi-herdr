import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { createWorkerPolicyCheck } from "../src/herd/worker-policy.ts";

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "herd-policy-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "src-other"));
  const env = {
    PI_HERD_WORKER: "1", PI_HERD_ROOT: root,
    PI_HERD_OWNS: JSON.stringify(["src", "one.ts", "new/deep.ts"]),
    PI_HERD_FORBID: JSON.stringify(["src/locked"]),
  };
  return { base, root, env };
}

function checkPath(check: ReturnType<typeof createWorkerPolicyCheck>, cwd: string, path: unknown, toolName = "write") {
  return check({ toolName, input: { path } }, { cwd });
}

test("owns accepts literal files, directories and new descendants using caller cwd", (t) => {
  const { root, env } = fixture(t);
  writeFileSync(join(root, "one.ts"), "before");
  const check = createWorkerPolicyCheck(env);
  for (const path of ["one.ts", "src/file.ts", "src/new/deep.ts", "new/deep.ts", join(root, "src/absolute.ts"), "@src/prefixed.ts", "src/unicode\u00a0space.ts", pathToFileURL(join(root, "src/url.ts")).href]) {
    assert.equal(checkPath(check, root, path), undefined, path);
    assert.equal(checkPath(check, root, path, "edit"), undefined, path);
  }
  assert.equal(checkPath(check, join(root, "src"), "relative.ts"), undefined);
  assert.equal(checkPath(check, root, `~/${relative(homedir(), join(root, "src/home.ts"))}`), undefined);
});

test("forbid wins; siblings and traversal escaping owns/root are blocked", (t) => {
  const { root, env } = fixture(t);
  const check = createWorkerPolicyCheck(env);
  for (const path of ["src/locked", "src/locked/new.ts", "one.ts-other", "src-other/file.ts", "new/other.ts", "src/../../escape.ts", "../repo-other/file.ts", "src/../other.ts"]) {
    assert.equal(checkPath(check, root, path)?.block, true, path);
  }
});

test("report-only allows only the exact output, never its siblings or descendants", (t) => {
  const { root, base, env } = fixture(t);
  const output = join(base, "reports/result.md");
  const check = createWorkerPolicyCheck({ ...env, PI_HERD_OWNS: "[]", PI_HERD_OUTPUT: output });
  assert.equal(checkPath(check, root, output), undefined);
  for (const path of [join(base, "reports/other.md"), `${output}/child`, "src/file.ts"]) {
    assert.equal(checkPath(check, root, path)?.block, true);
  }
  const forbidden = createWorkerPolicyCheck({ ...env, PI_HERD_OUTPUT: join(root, "src/locked/report.md") });
  assert.equal(checkPath(forbidden, root, join(root, "src/locked/report.md"))?.block, true);
});

test("symlink escapes, aliases into forbidden paths and dangling links fail closed", (t) => {
  const { root, base, env } = fixture(t);
  mkdirSync(join(base, "outside"));
  mkdirSync(join(root, "src/locked"));
  symlinkSync(join(base, "outside"), join(root, "src/escape"));
  symlinkSync(join(root, "src/locked"), join(root, "src/alias"));
  symlinkSync(join(base, "missing"), join(root, "src/dangling"));
  const check = createWorkerPolicyCheck(env);
  for (const path of ["src/escape/new/file.ts", "src/alias/file.ts", "src/dangling/new.ts"]) {
    assert.equal(checkPath(check, root, path)?.block, true, path);
  }
  const escapedLane = createWorkerPolicyCheck({ ...env, PI_HERD_OWNS: '["src/escape"]' });
  assert.equal(checkPath(escapedLane, root, "src/file.ts")?.block, true);
});

test("owns and output targets remain pinned against symlink retargeting between calls", (t) => {
  const { root, base, env } = fixture(t);
  mkdirSync(join(root, "target"));
  mkdirSync(join(root, "other"));
  symlinkSync(join(root, "target"), join(root, "lane"));
  const output = join(base, "report.md");
  const check = createWorkerPolicyCheck({ ...env, PI_HERD_OWNS: '["lane"]', PI_HERD_OUTPUT: output });
  assert.equal(checkPath(check, root, "lane/new.ts"), undefined);
  unlinkSync(join(root, "lane"));
  symlinkSync(join(root, "other"), join(root, "lane"));
  assert.equal(checkPath(check, root, "lane/new.ts")?.block, true);
  symlinkSync(join(base, "elsewhere.md"), output);
  assert.equal(checkPath(check, root, output)?.block, true);
});

test("an existing output symlink cannot be retargeted, nor can its parent", (t) => {
  const { root, base, env } = fixture(t);
  mkdirSync(join(base, "a"));
  mkdirSync(join(base, "b"));
  writeFileSync(join(base, "a/report.md"), "");
  symlinkSync(join(base, "a"), join(base, "reports"));
  const linkedOutput = join(base, "linked-report.md");
  symlinkSync(join(base, "a/report.md"), linkedOutput);
  const linkedCheck = createWorkerPolicyCheck({ ...env, PI_HERD_OWNS: "[]", PI_HERD_OUTPUT: linkedOutput });
  assert.equal(checkPath(linkedCheck, root, linkedOutput), undefined);
  unlinkSync(linkedOutput);
  symlinkSync(join(base, "b/report.md"), linkedOutput);
  assert.equal(checkPath(linkedCheck, root, linkedOutput)?.block, true);
  const output = join(base, "reports/report.md");
  const check = createWorkerPolicyCheck({ ...env, PI_HERD_OWNS: "[]", PI_HERD_OUTPUT: output });
  assert.equal(checkPath(check, root, output), undefined);
  unlinkSync(join(base, "reports"));
  symlinkSync(join(base, "b"), join(base, "reports"));
  assert.equal(checkPath(check, root, output)?.block, true);
});

test("missing/malformed worker policy and invalid paths fail closed for edits only", (t) => {
  const { root, env } = fixture(t);
  for (const patch of [
    { PI_HERD_ROOT: undefined }, { PI_HERD_ROOT: "relative" },
    { PI_HERD_OWNS: undefined }, { PI_HERD_FORBID: undefined },
    { PI_HERD_OWNS: "not-json" }, { PI_HERD_FORBID: "null" },
    { PI_HERD_OWNS: '[1]' }, { PI_HERD_OWNS: '[""]' },
    { PI_HERD_OWNS: '["../escape"]' }, { PI_HERD_OWNS: '["src/*"]' },
    { PI_HERD_OWNS: '["/absolute"]' }, { PI_HERD_OUTPUT: "relative" },
    { PI_HERD_WORKER: "0" }, { PI_HERD_WORKER: undefined, PI_HERD_PRIVATE: "1" },
  ]) {
    const check = createWorkerPolicyCheck({ ...env, ...patch });
    assert.equal(checkPath(check, root, "src/new.ts")?.block, true, JSON.stringify(patch));
    assert.equal(checkPath(check, root, "src/new.ts", "bash"), undefined);
  }
  const check = createWorkerPolicyCheck(env);
  for (const path of [undefined, null, 1, "", "src/\0file"]) assert.equal(checkPath(check, root, path)?.block, true);
});

test("nonworkers and tools other than built-in edit/write are unchanged", () => {
  const check = createWorkerPolicyCheck({});
  assert.equal(checkPath(check, "/", "/anywhere"), undefined);
  assert.equal(checkPath(check, "/", undefined, "edit"), undefined);
  const worker = createWorkerPolicyCheck({ PI_HERD_WORKER: "1" });
  for (const tool of ["read", "bash", "custom_write"]) assert.equal(checkPath(worker, "/", "/anywhere", tool), undefined);
});
