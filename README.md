# pi-herdr

**Pi extension for Herdr-visible subagent herds — default-local workers, optional ranked-frontier think, markdown handoff.**

**Design intent**

| Role | Who |
| ---- | --- |
| Orchestration | Frontier model (parent session) |
| Implement / slice | **Local seat** — private, free, clean per-job context, cap = `maxModelConcurrent` |
| Isolated review / plan / VERIFY | `role=think` — one job per catalog model; two tasks → one each; next think rotates to the other |
| User view / permissions | [Herdr](https://herdr.dev) panes (watch, focus, accept) |

Requires running **inside [Herdr](https://herdr.dev)** (`HERDR_ENV=1`). Outside Herdr, `herd` still loads for config/status, but spawn/boot and the `herdr` tool are inactive.

## Install

```bash
pi install npm:@itc-steve/pi-herdr
```

From a local checkout:

```bash
pi install /path/to/pi-herdr
```

Then `/reload`. Use `/herd help` for slash usage.

**Do not** install other herdr packages at the same time (e.g. `@ogulcancelik/pi-herdr`, `pi-custom-herdr`). This package vendors the `herdr` tool and **refuses to load** if a known competitor appears in Pi settings.

## Requirements

- Node.js ≥ 22.19
- [Pi coding agent](https://github.com/earendil-works/pi)
- [Herdr](https://herdr.dev) (terminal workspace / agent multiplexer)
- Models listed in config must already be available to Pi (local vLLM/SGLang, Grok CLI, etc.)

## Config

Copy [herd.json.example](./herd.json.example) to `~/.pi/agent/herd.json` (created automatically on first `models`, `run`, or `journal` if missing):

```json
{
  "sessionDir": "~/.pi/agent/herd",
  "maxModelConcurrent": 2,
  "local": {
    "enabled": true,
    "model": "vllm/Qwen/Qwen3.6-27B-FP8",
    "thinking": "medium",
    "preflight": true
  },
  "think": [
    { "model": "grok-cli/grok-4.6", "thinking": "high" },
    { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" }
  ],
  "private": { "enabled": false },
  "defaults": {
    "isolation": "none",
    "timeoutMs": 600000,
    "waitForReply": false,
    "requireOutput": true,
    "resultDelivery": "pointer",
    "triggerTurnOnResult": true
  }
}
```

`think[]` order **is** the rank. Put the best frontier first.

Old `easy` / `medium` / `hard` catalogs still parse: remotes fold into `think` (hard, then medium, then easy). `local.maxStreams`, `preferOn`, and `whenFull` are ignored. Cap is always `maxModelConcurrent`.

### Field reference

| Field | Meaning |
| ----- | ------- |
| `sessionDir` | Run root (`runs/`, journals, session JSONL) |
| `maxModelConcurrent` | Cap on **local seats** and on in-flight jobs **per exact provider/model** |
| `local` | Default implementer: model id, thinking, optional preflight |
| `think` | Ordered frontier catalog for `role=think` |
| `private.enabled` | Opt-in cloud redaction + `private=true` spawn (default **false**) |
| `defaults.isolation` | ignored; writers share the tree (`owns=` is the isolation) |
| `defaults.requireOutput` | Async spawn must declare `output=` |
| `defaults.resultDelivery` | `pointer` (default: path only) or `full` (paste reply) |
| `defaults.triggerTurnOnResult` | One parent turn when the last in-flight job finishes (default true) |

Jobs resolved to the local model are tagged `local: true` so parent, kick text, and `herd models` all see the seat.

## How it works

### Default-local + optional think

| Spawn | Route |
| ----- | ----- |
| no `role`, or `role=do` | Local. Queue if seats full. Never overflow onto think. |
| `role=think` (aliases: `review`, `plan`, `architect`, `verify`) | One in-flight per think model. First → `think[0]`. Second task or second opinion → the other. Both busy → queue `think[0]` |
| `model=` | That model (local id still takes a local seat) |

**Never** dump a whole project on one spawn. Decompose. Parent stays on a frontier model for orchestration; workers get a fresh session and a narrow kick.

One-release shim: `difficulty=easy\|medium` → do, `difficulty=hard` → think.

### Local seat

1. Default spawn claims a local seat (cap = `maxModelConcurrent`).
2. Extra do jobs **wait** for a free seat.
3. Each job gets a **fresh** `sessions/<job>.jsonl`.
4. Kick banner: *You are a LOCAL worker. One slice…*

### Private mode (opt-in)

Default **off**. Set `"private": { "enabled": true }` in `herd.json`.

When on, a **cloud** parent (active model ≠ `local.model`) sees `[PRIVATE:<category>]` instead of detected secrets in tool output, shell output, provider requests (including compaction), and herd-result text. The configured local model is trusted and is not redacted. Detection is regex/field-name based (vendored from `@spences10/pi-redact`, MIT) — not a guarantee; novel formats, assembled values, and secrets inside images can miss.

No auto-spawn. If the current task needs a withheld value, the cloud agent calls:

```text
herd spawn private=true task="…one secret-dependent step…" output=private-check.md
```

That spawn requires `private.enabled` and `local.enabled=true`, claims a normal local seat (FIFO queue if local seats are busy — never overflow to cloud), and rejects `role=think` / non-local `model=`. Private workers cannot spawn nested herd jobs. A `[PRIVATE:]` marker in a non-private spawn is rejected while private mode is enabled — retry with `private=true`.

The private worker reruns the operation locally. It must not plan the project, inspect unrelated files, spawn agents, or return secret values. Replies/errors back to a cloud parent are redacted again before delivery (and before the 4000-char paste cap). Journal never stores the reply.

Do not use alternate retrieval tools to recover a marker. Do not ask the worker to print the value.

`local.model` is a trust assertion: if that id is actually a remote endpoint, private mode will treat it as local and skip redaction.

### Handoff runs

```text
~/.pi/agent/herd/runs/<date>_<slug>/
  instruction.md   context.md   plan.md   progress.md
  meta.json   journal.jsonl
  sessions/<job>.jsonl
  jobs/…
  <your output=.md files>
```

Shared context is **markdown only** — panes do not chat to each other. Each spawn opens a background tab in the parent's current workspace. Job tabs stay open after success so you can watch or intervene in Herdr.

### Write lanes

Multi-writer fan-out requires disjoint `owns=` (and optional `forbid=`). Put **Parallel lanes** in `plan.md` first; the tool rejects overlapping owners.

### Completion (pointer batching)

Async jobs are monitored in the background.

- Mid-wave: footer only (`herd: N mon +local M`) — **no** parent turn.
- When the **last** in-flight job finishes: **one** batched `herd-result` with short **pointers** (`output=path`), not full reply pastes.
- Parent should **read the artifact** if it needs content — do not reassess the whole task from a pointer.
- Use `herd wait` / `herd collect` for a sync barrier. Set `resultDelivery=full` only if you need reply bodies in-session.

## Tools

| Tool | Role |
| ---- | ---- |
| `herd` | Assign / abort / steer / status local-first subagents |
| `herdr` | View and control Herdr terminals (workspaces, tabs, panes, worktrees) |

**Rule:** assign work with `herd`. Use `herdr` to view/focus/read — never `herdr run` into a herd job pane to assign work.

### `herd` actions

| Action | Purpose |
| ------ | ------- |
| `models` | Show local seats + ranked think catalog |
| `status` | Active monitors / local seats |
| `run` | `create` / `list` / `use` / `show` handoff folders |
| `spawn` | Boot a pane, submit task (async needs `output=`; `role=think` optional; `private=true` for secret-dependent local work) |
| `steer` / `abort` | Nudge or stop a job |
| `wait` / `collect` | Block until idle / harvest reply |
| `close` / `reset` | Close panes / clear monitors |
| `journal` | Soft resume log for the active run |

### Quick flow

```text
herd run create name=demo goal="Summarize this repo"
herd spawn task="Fill context.md from the repo" output=context.md
herd spawn task="Implement src/client.ts" output=progress-core.md owns=src/client.ts
herd spawn role=think task="Review progress-*.md; note gaps" output=progress-review.md
herd spawn private=true task="One secret-dependent check" output=private-check.md
```

Exact model override:

```text
herd spawn model=grok-cli/grok-4.6 task="…" output=notes.md
```

### Slash

```text
/herd help
/herd models
/herd status
/herd run create name=<slug> goal="…"
/herd spawn task="…" output=file.md
/herd spawn role=think task="…" output=review.md
/herd spawn private=true task="…" output=private-check.md
```

### `herdr` (view / control)

Registered only when `HERDR_ENV` and `HERDR_PANE_ID` are set (Herdr-managed pane). Actions include workspace/tab/pane lifecycle, `read` / `watch` / `wait_agent`, `run` / `send` / `stop`, worktrees, and notifications. Prefer friendly aliases or ids from `herdr list` — never invent pane ids.

## Skills

Package skills (`herd`, `herdr`) teach the launcher default-local vs think and the herd vs herdr split. They install with the package via the Pi `skills` manifest.

## Footer status

While monitors or local streams are active: `herd: N mon +local M`. Hidden when idle.

## Development

```bash
npm test
```

Tests use Node’s built-in runner with `--experimental-strip-types` (Node ≥ 22.19). Run `npm run typecheck` for strict TypeScript checks.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT. See [LICENSE](./LICENSE).
