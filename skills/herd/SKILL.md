---
name: herd
description: Bottom-up difficulty-routed Herdr subagents — easy/local first, medium for bulk build, hard for review/think. Scale with many small jobs.
---

# Herd (pi-herdr)

Use the `herd` tool. Do **not** drive herd panes with `herdr`.

Config: `~/.pi/agent/herd.json` (easy / medium / hard buckets + `local.maxStreams` + `maxModelConcurrent`).

## Scale bottom-up (required mindset)

**Never** dump a whole project on one `difficulty=hard` spawn. Decompose; promote only when needed.

| Difficulty | Use for | Examples |
|------------|---------|----------|
| **easy** | Narrow, cheap steps (local first) | Read docs → summarize into context.md; scaffold package.json/tsconfig; copy type stubs; list files; write a small section of README; run `tsc` and paste errors |
| **medium** | Bulk implementation | Implement a module/package slice with clear owns=; write a family of tools; fill out client.ts + server.ts |
| **hard** | Think / plan / review / integrate | Architecture decisions; critical bug analysis; adversarial review of medium outputs; merge plan; final VERIFY pass |

### Local + overflow easy

1. Spawn as many **easy** jobs as fit the work.
2. First free easy seat → **local vLLM** (`local.maxStreams`, usually 1).
3. Extra easy jobs → next easy catalog models (e.g. Sonnet) up to `maxModelConcurrent` per exact `provider/model`.
4. Do **not** escalate easy work to hard just because local is busy.

### Anti-patterns

- One hard spawn that “owns the entire tree”
- Using hard as a default implementer
- Serializing everything into one agent to “avoid merge fights” — use `owns=` lanes instead

## Spawn rules

- `difficulty=easy|medium|hard` is **required**
- Async spawn **requires** `output=` (artifact under the active run)
- Exact `model=` optional; still pass difficulty=; local mutex still applies for local models
- No `ensure` / open-all — only `herd spawn` boots panes
- Multi-writer: fill **Parallel lanes** in `plan.md`, then disjoint `owns=`

## Workflow

```
herd run create name=auth-bug goal="Fix login redirect"
# instruction.md = goals/constraints; plan.md = Parallel lanes with difficulty per lane

# Many easy in parallel (local + remote overflow)
herd spawn difficulty=easy task="Summarize skill into context.md" output=context.md
herd spawn difficulty=easy task="Scaffold package.json+tsconfig" output=progress-scaffold.md owns=package.json,tsconfig.json,types/

# Medium builders on disjoint owns=
herd spawn difficulty=medium task="Implement src/client.ts+server.ts" output=progress-core.md owns=src/client.ts,src/server.ts,src/config.ts
herd spawn difficulty=medium task="Implement tools+slash" output=progress-tools.md owns=src/tools/,src/slash.ts,src/index.ts

# Hard only for review / hard thinking
herd spawn difficulty=hard task="Review progress-*.md; note gaps; VERIFY tsc" output=progress-review.md
```

## Shared context

Markdown in the run directory only. Panes do not talk to each other.

## Session policy

Each job gets a fresh `runs/<id>/sessions/<job>.jsonl`. Panes stay open after success.
