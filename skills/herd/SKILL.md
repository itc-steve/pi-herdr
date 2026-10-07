---
name: herd
description: Delegate bounded tasks to agent-chosen local, Grok, or Codex workers. Queue work with write ownership and accepted dependencies; route sensitive operations locally.
---

# Herd agent instructions

- Use `herd` for assignments. Use `herdr` only to inspect/control terminals, never to send assignments into worker panes.
- Call `herd models`, then choose `worker=` deliberately. No default-local assignment or think/do pipeline. Use exact `model=` only when needed.
- Do small already-understood work yourself when delegation adds little. Local suits bounded, easily checked tasks; Grok and Codex can implement, investigate, or review. Never create filler work to occupy seats.
- Queue independent small tasks; configured concurrency limits execution. Workers cannot delegate or expand scope. Parent owns sequencing, integration checks, and acceptance.
- Declare project-relative literal files/directories in `owns=` for every writer. Omitted ownership means report-only. Conflicting writers and reviews wait. Parent/manual edits must respect those lanes too; they are not a filesystem sandbox.
- Give each async job a unique `output=` report under its run. Use `after=` for dependencies on existing job IDs. Dependencies require parent acceptance, not merely completion.
- `label=` is two words for the Herdr tab (task or role), e.g. `Adapter readiness`. Omit and the first two words of `task=` are used. Never put the job id or run name in the label.
- Read completion artifacts and check their evidence, then call `accept jobId=`. Never accept solely because a worker stopped. Failed/aborted dependencies block descendants; cancel and replace blocked tasks after resolving the issue.
- Use targeted independent reviews when useful, preferably another provider. Review stable finished files. No mandatory review for every tiny task.
- For non-trivial assignments include objective, inputs, owns, acceptance criteria, verification, and stop conditions. Keep implementation and its regression test in one independently verifiable slice. Plain-text tasks remain valid.
- Require criterion-level `met / unmet / not checked` evidence, files changed, checks/results, unrun checks with reasons, blockers, and next steps. Contract text never expands ownership or permissions.
- Before retrieving likely customer information, PII, confidential records, credentials, or secrets, delegate the narrow operation with `private=true`. Request only safe aggregates, status, or sanitized findings. Never put sensitive values in cloud-facing task text.
- `[PRIVATE:…]` markers require local delegation, not alternate retrieval or requests to reveal values. Private jobs never fall back to cloud. If local/private mode is unavailable, stop and ask. Cloud reviewers get sanitized material only.
- Redaction and privacy prompts are nudges, not guaranteed containment. Private helpers retain narrow, secret-free reporting instructions rather than broad run-context reads.
- Read artifact pointers without reconsidering the whole project. Run Markdown carries shared context. Use `herd peers` to discover same-run workers, `herd message jobId=… text=…` for advisory questions/findings, and `herd messages` for delivery status. Notes never expand ownership, delegate tasks, or approve results. Reply through the tool when useful; skip acknowledgement-only replies. Continue independent work or report blockers instead of polling/waiting indefinitely. Finished workers never restart. Limit: 20 outgoing notes per worker, 4096 UTF-8 bytes each. Private workers cannot use mailboxes; never put private data in peer messages.
- Queue and acceptance state are session-local. Finish or abort jobs before reload; do not assume durable resume or coordination across parent sessions.
