---
name: herdr
description: View and control Herdr terminals. Use herd for subagent assignments. Requires HERDR_ENV=1.
---

# Herdr agent instructions

- Check `HERDR_ENV=1` before terminal operations. If unset, explain that Herdr is required.
- Use the structured `herdr` tool to inspect/control terminals. Use `herd` to assign, steer, accept, or cancel worker jobs.
- Never use `herdr run` to assign work to herd workers; their queue and ownership belong to `herd`.
- Use `list scope=all` to discover terminals outside the current workspace. Use returned IDs; do not invent them.
- Preserve focus unless the user asks to switch. Do not close panes you did not create without explicit permission.
