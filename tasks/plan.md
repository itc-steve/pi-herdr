# Run-scoped worker mailboxes

## Contract

- Add `herd peers`, `herd message jobId=… text="…"`, and `herd messages` to the existing tool and slash command. Workers see only their run/parent namespace; the parent can inspect its runs.
- Messages are advisory questions/findings, not assignments or ownership changes. No auto-replies, broadcast, server, dependency, or replacement scheduler.
- Private workers have no mailbox access. Reject recognized secrets/private markers before persistence; ordinary PII still requires the existing private-local workflow.
- Atomic, owner-private filesystem envelopes; bounded text and per-worker message count. Track queued, delivered (entered Pi context, not understood), and recipient-finished.
- Drain at Pi turn boundaries using native steering. Final `agent_settled` closes reception permanently. Never wake idle/completed workers; completion must wait for the worker's closed mailbox marker before releasing lanes.
- Messages arriving too late remain visible in the parent's log and completion notice. Queued jobs cannot receive messages; workers report blockers instead of waiting indefinitely.
- Session-local coordination only. Reload/shutdown closes admission; saved logs remain. This is not an OS sandbox or exactly-once delivery across crashes.

## Slices

1. Mailbox transport and regression tests: scope, atomic envelopes, receipts, late sends, privacy, bounds.
2. Worker lifecycle and spawn/completion handshake: turn-boundary injection, no reopening, cancellation/reload cleanup; fake Pi and Herdr integration checks.
3. Public tools/commands, peer discovery, parent log, prompt guidance and README; full tests/typecheck and targeted review.

Baseline: 197 tests pass; typecheck passes. Preserve existing dirty work; no commits or dependency changes.

# Pi 1.5 / Ovis compatibility (2026-11-03)

User approved all slices. Preserve the existing uncommitted work; no publish, release, commit, or trust bypass. Baseline: 224 tests and typecheck pass. Run artifacts: `~/.pi/agent/herd/runs/2026-11-03_pi15-ovis-compat/`.

## Ordered slices and parallel lanes

1. **Investigate:** verify installed Pi APIs and Ovis native chat launch contract. Report-only; do not inspect user sessions or secrets. Require source evidence before changing launch behavior.
2. **Dependencies:** `package.json`, `package-lock.json`; update the related host dev packages to 1.5.0, install without scripts, inspect lockfile, run tests/typecheck. No package release version bump.
3. **Worker write gate:** new focused policy helper and tests; project-relative ownership and forbid validation, canonical path containment, exact report exception, fail-closed malformed policy. Built-in edit/write only, not an OS or shell sandbox. Integrate into index/spawn after helper verification.
4. **Launch and lifecycle:** confirmed Ovis launch changes in client/boot/spawn, worker policy env, private `--no-mcp`, `PI_PROGRAM_STATUS=1`; blocked prompts surfaced promptly with bounded stall wait and safe cleanup. Tests cover fallback, focus preservation, blocked/resumed/aborted workers and held lanes.
5. **Pi prompt and rendering integration:** index plus small renderer helper/tests and Herdr collapsed hint; structured prompt options, live worker catalog without duplicate privacy text, aborted settlement handling, compact expandable herd/messages and wait progress. Preserve other extensions' prompt content and existing privacy edits.
6. **Model preflight:** workers/enqueue/actions and tests; registry lookup and Pi thinking clamp before queue/terminal allocation; useful `models` diagnostics. Runtime context wiring coordinated through the index owner.
7. **Verification and docs:** full tests/typecheck, independent stable-file review, synthetic runtime smoke where supported. Update README, skill guidance and Unreleased changelog; retain explicit limitations and record any unavailable Ovis live validation.

Dependencies: API investigation precedes API changes; policy helper precedes launch/index gate integration; dev upgrade precedes final type validation; final review sees stable code only. Avoid concurrent writers to index or spawn.

## Safety and acceptance

- Reports remain writable while project edits outside lanes are blocked; traversal/symlink escapes are tested. Shell and arbitrary extension tools remain outside this guard; `--no-mcp` is not network isolation.
- Prompt/trust stalls never silently slide forever; do not free capacity until worker cleanup is confirmed.
- Ovis uses a documented/discovered native path, preserving non-Ovis behavior and no-focus behavior. Do not guess an RPC protocol or modify the external app without approval.
- Both tool and slash paths preflight models and use refreshed prompt/render APIs.
- All existing checks stay green, added nontrivial behavior has regressions, and existing user changes remain intact.

## Verified upgrade correction

Pi 1.5's published `StringEnum` now returns a pi-schema-branded schema, while `registerTool` still infers parameters through TypeBox `Static`. Updating TypeBox alone does not fix the 12 enum inference errors in `src/herdr/tool.ts`. The index/Herdr integration owner must replace mixed-library enum constructors with native `Type.Enum(values, { type: "string", description: ... })` in both entrypoints; preserve the exact JSON Schema enum semantics, do not cast all callers. Context7 and local TypeBox 1.3.27 runtime confirm this native API. Dependencies were accepted as an isolated upgrade; source integration now uses native Type.Enum and final typecheck passes. Package release version remains unchanged; host peers now require >=1.5.0.

Active-session caveat: this parent still runs the old launcher until `/reload`. New policy guards deliberately fail closed for old workers without policy metadata. After index integration, synchronous report-only reviewers can return final text without `output=`; do not weaken guards to accommodate a stale parent. Finish/accept jobs before asking the user to reload and test a newly launched Ovis chat.

## Final verification

All 13 bounded investigation/implementation/correction/review jobs accepted. Parent reran 277 tests (all pass), typecheck, diff-check, npm audit (0 vulnerabilities), an isolated offline installed-Pi-1.5 extension load/help check (exit 0, no diagnostics), and four installed Ovis session-store resolver tests (all pass). Independent Grok review found no actionable issues. Tests use synthetic files/clients and the real Pi extension registration loader; no live model/auth requests or customer-data inspection.

Unverified: live Ovis chat interaction and physical TUI rendering. Reload after finishing work, then spawn a new harmless worker; the environment fix cannot retrofit already-running workers. Built-in edit/write gates and `--no-mcp` are not filesystem/network isolation. Explicit worker session aborts currently fail queued jobs rather than reporting success; parent cancellation suppresses automatic result-triggered wakeups. No commits, publication, or release version change.
