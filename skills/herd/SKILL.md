---
name: herd
description: Bottom-up difficulty-routed Herdr subagents — easy/local first, medium for bulk build, hard for review/think. Scale with many small jobs.
---

# Herd (pi-herdr)

Use the `herd` tool. Do **not** drive herd panes with `herdr`.

Config: `~/.pi/agent/herd.json` (easy / medium / hard buckets + `local.*` + `defaults.resultDelivery`).

## Scale bottom-up (required mindset)

**Never** dump a whole project on one `difficulty=hard` spawn. Decompose; promote only when needed.

| Difficulty | Use for | Examples |
|------------|---------|----------|
| **easy** | **Default** for any single discrete task (local first) | Summarize → context.md; scaffold one file; list files; small README section; run `tsc` and paste errors |
| **medium** | Multi-file bulk implementation (local still preferred when free) | Implement a module slice with clear owns=; fill client.ts + server.ts |
| **hard** | Frontier think / plan / review / integrate only | Architecture decisions; critical bug analysis; adversarial review; final VERIFY |

### Local first (private, free, one stream)

The `local` seat (`local.model`, `maxStreams` usually **1**) is private hardware — no cloud tokens. Prefer it for every single-task job.

1. **Default to `difficulty=easy`** for single-file / single-question / scaffold / summarize work.
2. Local is auto-promoted first on `local.preferOn` (default **easy + medium**). Free seat → local boots with a **clean per-job session**.
3. `local.whenFull`:
   - **`queue`** (default): extra jobs wait for the local seat — serial free GPU, no paid overflow.
   - **`overflow`**: extra jobs go to the next catalog model (paid parallel).
4. Do **not** escalate to hard because local is busy or queued.
5. Do **not** pass `model=` for the local model on more than `maxStreams` jobs.
6. Parent/orchestrator stays on the frontier model. Herd workers do the narrow work.

### Anti-patterns

- One hard spawn that “owns the entire tree”
- Using hard (or medium) as a default for a single small task local could do
- Burning rock/claw/sonnet for work that fits one clean local context
- Serializing everything into one agent to “avoid merge fights” — use `owns=` lanes instead
- Re-deriving a finished job from a herd-result pointer — **read the output file**

## Spawn rules

- `difficulty=easy|medium|hard` is **required**
- Async spawn **requires** `output=` (artifact under the active run)
- Exact `model=` optional; still pass difficulty=; local mutex still applies for local models
- No `ensure` / open-all — only `herd spawn` boots panes
- Multi-writer: fill **Parallel lanes** in `plan.md`, then disjoint `owns=`

## Results (pointers, not pastes)

Async jobs finish in the background. When the **last** in-flight job of a wave completes, the parent gets **one** batched `herd-result` with short **pointers** (`output=path`) — not full reply pastes.

- Read the artifact if you need content.
- Do **not** reassess the whole user task just because a pointer arrived.
- `defaults.resultDelivery=full` only if you explicitly need reply bodies in-session.
- `defaults.triggerTurnOnResult=false` → display only (no auto parent turn).

## Workflow

```
herd run create name=auth-bug goal="Fix login redirect"
# instruction.md = goals/constraints; plan.md = Parallel lanes with difficulty per lane

# Single discrete tasks → easy (local)
herd spawn difficulty=easy task="Summarize skill into context.md" output=context.md
herd spawn difficulty=easy task="Scaffold package.json+tsconfig" output=progress-scaffold.md owns=package.json,tsconfig.json,types/

# Multi-file bulk → medium (still local-first when free / queued)
herd spawn difficulty=medium task="Implement src/client.ts+server.ts" output=progress-core.md owns=src/client.ts,src/server.ts,src/config.ts

# Hard only for review / hard thinking on the frontier
herd spawn difficulty=hard task="Review progress-*.md; note gaps; VERIFY tsc" output=progress-review.md
```

## Shared context

Markdown in the run directory only. Panes do not talk to each other.

## Session policy

Each job gets a fresh `runs/<id>/sessions/<job>.jsonl`. Panes stay open after success.
