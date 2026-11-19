---
name: herdr
description: View and control Herdr TUI or herdr-core/Ovis terminals. Use herd for subagent assignments.
---

# Herdr agent instructions

- The TUI uses `HERDR_ENV=1` plus `HERDR_PANE_ID`; core/Ovis uses `HC_TERMINAL_ID` plus its inherited `HC_TERMINAL_SOCKET` (or explicit `HC_SOCKET`). Do not spoof flags or guess an endpoint from `HC_SESSION`.
- Use the structured `herdr` tool to inspect/control terminals. Use `herd` to assign, steer, accept, or cancel worker jobs.
- Never use `herdr run` to assign work to herd workers; their queue and ownership belong to `herd`.
- On the TUI, use `list scope=all` to discover terminals outside the current workspace. On core, use `list` and the supported tool schema; there are no native workspaces, tabs, splits, or focus controls. Use returned IDs or unique labels; do not invent them.
- Core `run` submits text with Enter. Core `send` supports named keys only; never substitute submitted text for literal `send text=`. Core reads are screen/history snapshots, not TUI read sources; unsupported actions/options must not be emulated.
- Preserve focus unless the user asks to switch. Do not close panes you did not create without explicit permission.
