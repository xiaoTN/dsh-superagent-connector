# v0.4.3 — Feishu-topic reply quotes

- Draw a Feishu-topic-style quote above every Source `acknowledgement`/`reply`: the exact human message it answers plus that message's time. Replies stay attributable when more messages arrive before the answer, instead of appearing as unattached cards.
- Resolve the quoted target from the reply event's deterministic outbox id against the confirmed `superagent/source` history. Do not guess by position: an old, redacted or otherwise unresolvable id renders without a quote rather than quoting the wrong message.
- Keep the quote as presentation metadata above the native Markdown body. Markdown rendering, attachments, transport status, Source intake and authorization are unchanged; history is only read, never rewritten.

## Verification

- Connector unit tests cover an interleaved acknowledgement/answer pair (the acknowledgement for an earlier message arriving after a later message) and a ticket result with no direct question.
- Real existing Windows DSH desktop → WSL Source GUI capture in the same conversation and theme, before/after: [before](<images/reply-topic-before.png>) / [after](<images/reply-topic-after.png>).
- `npm run check` passes (120 passed / 20 skipped OS-specific tests).

## Deployment

Upgrade both connector profiles to the same 0.4.3 archive and refresh the existing DSH GUI. This release needs no upstream SuperAgent patch, no Source module reload and no task-board change.
