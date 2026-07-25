# Changelog

All notable changes to `@itc-steve/pi-herdr` are documented here.

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
