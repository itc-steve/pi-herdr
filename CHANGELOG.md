# Changelog

All notable changes to `@itc-steve/pi-herdr` are documented here.

## [2.0.3] — 2026-11-18

**Compatibility:** Requires Pi 1.5.0+ and Node.js 22.19+. No configuration migration from 2.0.2. Finish or abort active herd jobs, update, then `/reload` before spawning new workers. The core adapter targets herdr-core 0.1.17 used by Ovis Electron Desktop.

### Added

- Detect Herdr TUI or local herdr-core/Ovis terminals from their actual inherited identity and endpoint. Core uses direct socket/named-pipe IPC without requiring `hc` on PATH, guessing a session, or starting a daemon.
- Launch core workers with structured process arguments and explicit environment/session metadata, avoiding POSIX shell startup and npm `.cmd` execution. Workers use the parent's existing placement labels rather than fabricated tabs or workspaces.
- Provide supported core terminal discovery, inspection, screen/history reads, submitted commands, named keys, bounded waits, and cleanup. Reject unsupported layout/focus actions, literal-text injection, regex watches, and TUI-only read options.

### Fixed

- Retain capacity and write lanes until native worker cleanup is confirmed; missing OSC agent metadata no longer counts as proof that a live process stopped.
- Reconcile uncertain creation and lost removal replies using exact job labels and observed terminal identities. Verified pre-creation rejections release reservations normally instead of leaving them permanently held.
- Bound creation, readiness, task acknowledgment, idle waits, and stop operations during in-flight core IPC. Preserve independent cleanup budgets, working-state stall extensions, and the TUI's existing behavior; core submission never adds a duplicate Enter.

### Verification and limits

- 382 tests, typecheck, packaging checks, and an independent targeted review passed. Isolated Linux core 0.1.17 IPC and actual offline Pi 1.5.0 worker boot smoke tests passed.
- Native Windows IPC/ConPTY, compiled Bun Pi, physical Ovis placement/focus/chat, and live authenticated model turns remain unverified. Core support does not add remote-machine or layout control.

## [2.0.2] — 2026-11-18

**Compatibility:** Requires Pi 1.5.0 or newer. Finish or abort active herd jobs, then `/reload` before spawning new workers.

### Fixed

- Make herd worker sessions discoverable by Ovis by declaring the exact per-run Pi session store, including private workers; preserve Ovis authorization checks and background-tab focus.
- Bound waits for workers blocked on user prompts, surface their pane IDs, and retain capacity/write lanes until failed or cancelled workers are confirmed stopped. Reject explicit aborted/error session outcomes as successful completion.
- Use structured Pi prompt updates instead of replacing the full system prompt or duplicating privacy guidance; refresh configured worker guidance on each run.
- Explain private markers in cloud system/tool guidance when privacy is enabled, with bounded local herd delegation, sanitized reporting, and explicit instructions to preserve source values.
- Avoid private-marker false positives on credential property references and function calls in source code. Recognize private-key delimiter lines in plain and numbered search output without treating inline source strings as key blocks or arming continuation tracking for them.

### Added

- Example and generated worker defaults include Astra escalation alongside Sol, with shared OpenAI concurrency. Worker descriptions specify effort selection, local medium-only guidance, and exceptional-use Astra `xhigh`.
- Herd tool guidance includes configured workers and their runtime defaults/descriptions before the first tool call and refreshes on each new run; `herd models` also reports model-capability diagnostics.
- Guard worker built-in edit/write calls with owned/forbidden paths and an exact report exception. Private workers disable built-in MCP connections; these controls are not a shell or network sandbox.
- Compact, expandable herd tool/results/peer/slash rendering with configured key hints, elapsed duration, and wait progress.

### Changed

- Require Pi 1.5.0+ and validate against its current development packages. Keep JSON Schema enum declarations compatible with TypeBox inference.
- Validate model IDs and thinking levels before creating jobs; clamp supported levels through Pi's model-capability API. Esc-cancelled parents no longer auto-restart for later results.
- Worker-selection guidance uses configured descriptions rather than assuming Grok/Codex worker names or capabilities. Routing and privacy constraints are unchanged.

## [2.0.1] — 2026-10-07

### README and packaging

- Redesigned the README homepage: project-native SVG hero (main agent → worker lanes with status) and a task-lifecycle diagram (spawn → run → report → accept → release).
- Moved the 2.0 breaking-change warning from the first screen into the "Upgrading from think/do" section where it belongs.
- README assets are now published with the npm package (`assets` in `files`).

## [2.0.0] — 2026-09-27

**Breaking overhaul.** Do not treat this as a drop-in upgrade from 1.x. Rewrite `~/.pi/agent/herd.json`, then `/reload`. Bare `herd spawn` and think/do routing no longer choose a worker for you.

### Warning — required config and spawn changes

- **`herd.json` format.** Replace top-level `local`, `do[]`, `think[]`, and `maxModelConcurrent` with a `workers` map. Each worker needs `model`, `thinking`, and `maxConcurrent`. Set `workers.<name>.group` when two cloud workers share a subscription. `private.enabled` is unchanged (still default off).
- **No default-local spawn.** Every spawn must pass `worker=` (or exact `model=`). `role=do|think` and `difficulty=` are not how work is assigned anymore.
- **Writers need `owns=`.** Comma-separated project-relative files or directories. Omit it and the job is report-only.
- **`after=` waits for `accept`, not completion.** Read the artifact, verify it, then `/herd accept jobId=…`. Completion alone does not release dependents.
- **Queues are session-local.** Finish or abort jobs before `/reload`. There is no automatic resume across parent sessions.
- **Old configs still load** (`local` / `do[]` / `think[]` fold into named workers) so Pi starts, but prompts and spawn behavior already follow 2.0. Migrate the file.

New shape (replace the three model placeholders with IDs from your Pi setup):

```json
{
  "workers": {
    "local": {
      "model": "local-provider/local-model",
      "thinking": "medium",
      "maxConcurrent": 2
    },
    "grok": {
      "model": "grok-provider/grok-model",
      "thinking": "medium",
      "maxConcurrent": 1
    },
    "codex": {
      "model": "openai-codex/codex-model",
      "thinking": "medium",
      "maxConcurrent": 1
    }
  },
  "private": { "enabled": false }
}
```

See `herd.json.example` and README “Upgrading from think/do”. Run `/herd models` after reload.

### Added

- Named workers. The parent chooses local, Grok, Codex, or another configured name. No think/do pipeline and no automatic local assignment.
- Job queue with per-worker/`group` concurrency. Independent tasks can wait; only configured seats run.
- Write lanes: overlapping `owns=` serializes; report-only reviews wait for writers in the same project.
- `herd accept` — parent approval gate for `after=` dependents.
- Run-scoped worker mailboxes: `herd peers`, `herd message`, `herd messages`. Advisory notes only. Private workers excluded.

### Changed

- `herd models` lists workers, not think/do catalogs.
- `herd status` reports queued/running/accepted/blocked jobs and held capacity.
- Default on-disk config writes the `workers` map.
- README, skills, and package description match agent-chosen workers.

## [1.5.1] — 2026-09-18

### Added

- Opt-in `do[]` catalog in herd.json: extra non-local models a bare `role=do` rotates onto when local seats are full (local model stays the do head; each `do[]` model caps at one in-flight job, shared with `think[]`). Empty/absent `do[]` keeps the classic local-only do behavior. `herd models` lists the do extras.

## [1.5.0] — 2026-09-16

### Added

- Opt-in **private mode** (`"private": { "enabled": false }` by default). Cloud parents get `[PRIVATE:<category>]` markers instead of detected secrets in tool output, provider requests (including compaction), shell history, summaries, and replayed tool arguments. `herd spawn private=true` forces the configured local model for one secret-dependent step; private workers cannot spawn nested herd jobs. Detector vendored from `@spences10/pi-redact` (Scott Spence, MIT).
- Strict TypeScript checking through `npm run typecheck`.

### Fixed

- Aborting a queued model slot now cancels it instead of letting it start later.
- Async monitors no longer wait forever when an `output=` file shrinks relative to its spawn baseline (spec overwritten by a shorter result).

### Breaking

- Node.js 22.19+ is now required, matching current Pi packages and native TypeScript test execution.

## [1.4.0] — 2026-08-31

### Breaking (with one-release shim)

- Spawn is **default-local**. Omit `role` (or `role=do`) → local implementer. `role=think` (aliases: review, plan, architect, verify) walks a ranked `think[]` catalog.
- Dropped `easy` / `medium` / `hard` catalogs, `local.maxStreams`, `local.preferOn`, `local.whenFull`. One cap: `maxModelConcurrent` (local seats + per-model cloud seats).
- Do jobs **queue** when local seats are full. They never overflow onto think.
- `difficulty=easy|medium|hard` still accepted this release (`easy`/`medium` → do, `hard` → think).

### Added

- Kick banners: LOCAL worker vs cloud THINK pass.
- Old herd.json leftovers fold remotes into `think` (hard, then medium, then easy).
- `role=think` with no `model=`: one in-flight per think model; two tasks → one of each; next think rotates to the other (second opinion).

### Docs

- README, skills, and package description match default-local + `think[]`. Dropped the difficulty-era screenshot (`difficulty=hard` spawn).

## [1.3.1] — 2026-08-27

### Fixes

- Output-backed jobs now respect their timeout while waiting for a required output file, instead of overshooting short deadlines by the output polling interval.

## [1.3.0] — 2026-08-23

### Added

- Herd subagents now spawn as background tabs in the parent's current workspace instead of creating workspaces.

### Fixes

- Herd-result no longer starts a second parent turn when the parent is already
  in a turn (it was followUp+triggerTurn after settle — parent already had the
  final state). `wait_agent` and native `agent wait` treat `done` like `idle`.
- Async monitors no longer inherit the spawning tool call's abort signal. A
  cancelled parallel tool batch could release the local seat while its pane was
  still working, allowing a second local stream to start.

## [1.2.0] — 2026-08-19

### Fixes

- Local seat: `waitForJobIdle` no longer treats a still-working pane as timed out.
  Monitor `timeoutMs` (default 10 min) was releasing `maxStreams=1` and letting a
  queued local job start a second vLLM stream. Timeout is now a stall clock —
  it only fires while the pane is not `working`/`blocked`.

## [1.1.2] — 2026-07-26

### Docs & config

- `herd.json.example` and README: updated model catalog to current recommended defaults
  - **easy**: `vllm/Qwen/Qwen3.6-27B-FP8` (local) + `openai-codex/gpt-5.6-luna`
  - **medium**: `grok-cli/grok-4.5` + `openai-codex/gpt-5.6-terra`
  - **hard**: `claude-code/claude-opus-5` + `openai-codex/gpt-5.6-sol`

## [1.1.1] — 2026-07-25

### Docs

- README: remove em dashes for cleaner formatting.

## [1.1.0] — 2026-07-25

### Local-first routing

- `local.preferOn` (default `["easy","medium"]`) — promote the local seat first on those difficulties.
- `local.whenFull`: `"queue"` (default) waits for the free local GPU; `"overflow"` uses the next catalog model.
- Atomic local-stream claim with queue support so parallel spawns cannot oversubscribe `maxStreams`.
- Exclusive `jobs/<id>` claims so parallel spawns never collide on the same job id.

### Lean result delivery

- `defaults.resultDelivery`: `"pointer"` (default) or `"full"`.
- `defaults.triggerTurnOnResult` — one parent turn when the wave finishes (default true).
- Mid-wave completions are footer-only; the last job flushes **one** batched `herd-result`.
- Pointers point at `output=` artifacts — no full reply paste by default (less reassess token burn).

### Docs & skills

- README, `herd.json.example`, and `herd` skill updated for local-first + pointer batching vision.
- Prompt guidelines steer single discrete tasks to `easy` / local.

## [1.0.0] — 2025-07-23

Initial public release:

- Difficulty-routed `herd` spawn (`easy` / `medium` / `hard`)
- Local vLLM preference on easy with overflow
- Markdown handoff runs, write lanes, journal
- Vendored `herdr` tool (competitor package guard)
- Background monitors + herd-result follow-ups
