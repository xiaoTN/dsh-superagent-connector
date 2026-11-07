# v0.4.2 — Native SuperAgent conversation

- Replace the simplified transcript/textarea with DSH's real Conversation Factory, Controller-owned Session reference, native composer/user messages, Markdown and native file intake.
- Keep the real WSL SuperAgent Source/ticket/worker pipeline. No ordinary-assistant fallback, fabricated model/tool events or replacement task board.
- Add ordered Source-owned history, synchronous durable native outbox and explicit unknown-delivery status. Uncertain requests are reconciled, never automatically resent.
- Transfer actual admitted image/file bytes to new owner/conversation/request-bound WSL receipts. Prepare → Source transaction → filesystem commit; restore history only after scoped byte/digest verification.
- Add nonterminal, assignment/control-generation checked interruption and continuation. Only actual cancellation `settled` enables continuation; the same worker and worktree are retained.
- Display bounded, passive real worker records with original sequence/time instead of inventing a local model trace.
- Preserve independent Agent naming and the existing task-board synchronization/central execution guard.
- Fix actual Agent Teams scoped-world compatibility, historical-ticket visibility, fresh capability revocation, rejected-upload pinning and oversized-input admission.

## Deployment

Upgrade both connector profiles. Interrupt/continue requires the included upstream patch for SuperAgent commit `8c32a9d`, followed by build and a real idle-time module reload. Connector upgrade alone does not add this backend capability. The original board 0.4.15 guard remains required and unchanged. Refresh the existing DSH GUI after installation.

This remains single-machine/single-owner/single-repository software under the existing worker permissions. Local model/permission/steer/approval/Plan/Goal/rollback/fork controls have no supported remote mapping and remain unavailable. Source-scoped RC.1 DOM/ARIA compatibility code is not an official per-session capability API or a sandbox.

## Verification

24/24 actual RC SDK checks; separate real Windows GUI → WSL Source reply, text/image consumption, settled interruption during preparation and same-assignment/session/worktree continuation to normal completion, and 46 original execution records. See the verification document for exact boundaries. The upstream full suite retains one separately reproduced pre-existing Feishu consumer race. Skipped SDK/OS tests are not counted as passed.

Versions 0.4.0 and 0.4.1 were local staging only; this is the public native-conversation release.
