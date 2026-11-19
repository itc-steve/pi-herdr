# Mailbox implementation

- [x] Transport: send/list/receipt across independent filesystem clients; scoped peers; private and input rejection.
- [x] Lifecycle: deliver only while active; close at settled/shutdown; completion retains lanes until closed.
- [x] Usability: peers/message/messages actions and slash commands; parent log and late-message notices; docs and worker instructions.
- [x] Verification: 208 tests, typecheck, cross-process smoke check using a real Pi SDK loop with a faux provider, and read-only Grok review (no actionable verified findings).

No live Herdr/model integration run. No dependencies changed. Existing uncommitted work preserved.

# Pi 1.5 / Ovis compatibility

- [x] User approved full implementation; baseline 224 tests and typecheck pass.
- [x] Verify Pi APIs and Ovis launch root cause (installed resolver rejects undeclared custom session store; synthetic env fix passes).
- [x] Upgrade host dev packages to 1.5.0 and align TypeBox 1.3.27; version remains 2.0.1. Native Type.Enum resolves the host schema inference mismatch.
- [x] Implement and test worker edit/write policy with exact report exception (13 targeted checks including lane regressions pass; integration queued).
- [x] Integrate Ovis launch, worker env/private MCP disable, blocked lifecycle and cleanup, including widget warnings and held-lane cleanup tests.
- [x] Structured live prompts, compact tool/message renderers, visible partial progress, cancellation handling.
- [x] Registry/model/thinking preflight before allocation, clamp reporting and models diagnostics; tool and slash context wiring verified.
- [x] Final parent verification: 277 tests pass, typecheck and diff-check pass, npm audit reports 0 vulnerabilities.
- [x] Independent Grok stable-code review: no actionable findings; all herd jobs accepted.
- [x] Isolated offline Pi 1.5 CLI extension-loader/help smoke passes with empty HOME; 4 installed Ovis resolver tests pass.
- [x] README, packaged skill and Unreleased changelog updated; original dirty work preserved; no commit or release.
- [ ] Live Ovis chat/physical TUI check: finish jobs and `/reload`, then launch a fresh harmless worker. Existing processes retain the old launch environment.

# Ovis Desktop / herdr-core compatibility

- [x] Confirm scope: both runtimes, native Windows-safe launch, full worker lifecycle, supported core terminal controls, no release.
- [x] Map existing TUI coupling and public Ovis/core documentation; identify bundled core 0.1.17 and remaining source-contract gaps.
- [x] Verify 0.1.17 executable schema, endpoint routing, Windows entrypoint, status and visibility contract (source/schema verified; native Windows runtime not tested).
- [x] Add minimal runtime detection/core adapter with transport and capability tests (7 runtime and 16 client tests).
- [x] Integrate worker launch, privacy/ownership metadata, status and safe cleanup; preserve TUI behavior.
- [x] Enable supported core terminal tools; update runtime guidance, README, skills and Unreleased notes.
- [x] Finish independent stable-code review: fixed three cleanup/rejection/deadline findings; targeted fresh recheck found no remaining actionable issue. Parent and reviewer each passed 382 tests, typecheck and diff-check; package dry-run passed.
- [x] Isolated real core 0.1.17 IPC and actual offline Pi 1.5.0 structured boot smoke passed on Linux; no model calls or user terminals/config changes.
- [ ] Native Windows IPC/ConPTY, compiled Bun Pi, and physical Ovis placement/chat validation remain external checks.
