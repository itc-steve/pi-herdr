---
name: herd
description: Local-first Herdr subagents — default spawn is local do; role=think is ranked frontier review/plan. Scale with many small jobs.
---

# Herd (pi-herdr)

Use the `herd` tool. Do **not** drive herd panes with `herdr`.

Config: `~/.pi/agent/herd.json` (`local` + ordered `think[]` + `maxModelConcurrent`).

## Default local

Spawn with **no role** → local GPU, tagged `[local]`, fresh `sessions/<job>.jsonl`.
`maxModelConcurrent` (default 2) is the only cap — local seats and per-cloud-model seats share that number. Extra **do** jobs **queue**. They never overflow onto think.

Pass `role=think` only for an isolated second opinion, plan, or VERIFY. One in-flight job **per** think model (never two Grok at once). Two think tasks → one of each catalog model. A second opinion (next think) rotates to the **other** model. Parent already thinks — think is a **fresh context**, not a smarter model.

Never dump a whole project on one spawn. Slice; use disjoint `owns=` for parallel writers.

## Spawn

- `role` optional (`do` implied). Aliases for think: `review`, `plan`, `architect`, `verify`.
- Async spawn **requires** `output=` (artifact under the active run).
- Exact `model=` optional escape hatch; local models still take a local seat.
- One-release shim: `difficulty=easy|medium` → do, `hard` → think.

```
herd run create name=auth-bug goal="Fix login redirect"

herd spawn task="Summarize skill into context.md" output=context.md
herd spawn task="Implement src/client.ts" output=progress-core.md owns=src/client.ts
herd spawn role=think task="Review progress-*.md; note gaps; VERIFY tsc" output=progress-review.md
```

## Results

Async jobs finish in the background. Last in-flight job of a wave → one batched `herd-result` with **pointers** (`output=path`). Read the artifact. Do not reassess the whole user task from a pointer.

## Shared context

Markdown in the run directory only. Panes do not talk to each other.
