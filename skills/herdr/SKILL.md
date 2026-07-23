---
name: herdr
description: "View and control Herdr terminals. Prefer the herdr tool. For subagent jobs use herd — never herdr-run herd panes. Requires HERDR_ENV=1."
---

# Herdr (viewing + general terminal control)

1. **`herd` tool** — assign work to difficulty-routed subagents
2. **`herdr` tool** — view/control terminals (including watching herd panes when the user asks)

## Environment gate

```bash
test "${HERDR_ENV:-}" = 1
```

If unset, say you are not inside Herdr and stop.

## Rules

| Need | Use |
|------|-----|
| Assign / abort / steer jobs | `herd` |
| User asks to **view** a job pane | `herdr workspace_focus` + `herdr read` |
| Inventory every space | `herdr list scope=all` / `workspace_list` |
| Drive **non-herd** terminals | `herdr` freely |

**Never** `herdr run` into a herd job pane to assign work.
