# Changelog

All notable changes to `@itc-steve/pi-herdr` are documented here.

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
