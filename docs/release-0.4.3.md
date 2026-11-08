# v0.4.3 — Feishu-topic reply quotes

- Draw a Feishu-topic-style quote above every Source `acknowledgement`/`reply`: the exact human message it answers plus that message's time. A ticket-level result (for example the final completion notice, whose id names the ticket rather than a message) quotes the human message already bound to that ticket, so the same topic style covers the closing reply too. Replies stay attributable when more messages arrive before the answer, instead of appearing as unattached cards.
- Resolve a direct answer's quoted target from the reply event's deterministic outbox id against the confirmed `superagent/source` history. A ticket-level result has no message id, so it quotes the message already bound to the same ticket (the ticket's opening message when loaded). Do not guess by position: an old, redacted or otherwise unresolvable id renders without a quote rather than quoting the wrong message.
- Make the quote a control: clicking it opens a full-height, tab-strip right column beside the native conversation (resizable from its left edge) with the message, its confirmed neighbours and the reply that opened it. The pane has a composer; sending from it prefixes the quoted message so the WSL SuperAgent receives the message with its context, reusing the native input/outbox path. The pane is read-only history plus that composer; no local ticket or history rewrite.
- Keep the quote as presentation metadata above the native Markdown body. Markdown rendering, attachments, transport status, Source intake and authorization are unchanged; history is only read, never rewritten.

## Verification

- Connector unit tests cover an interleaved acknowledgement/answer pair (the acknowledgement for an earlier message arriving after a later message), a ticket-level result resolved from its ticket even before its acknowledgement row, an unbound ticket result that stays unquoted, and the right context pane quoting and submitting its scoped composer message.
- Real existing Windows DSH desktop → WSL Source GUI capture in the same conversation and theme, before/after for direct replies: [before](<images/reply-topic-before.png>) / [after](<images/reply-topic-after.png>).
- Same real GUI for the ticket-level closing result: [before](<images/reply-topic-result-before.png>) (operator's report; red boxes are their annotations) / [after](<images/reply-topic-result-after.png>).
- Same real GUI for the right context pane and its scoped composer: [before](<images/reply-context-before.png>) (quote not opened) / [after](<images/reply-context-after.png>) (pane open)..
- `npm run check` passes (121 passed / 20 skipped OS-specific tests).

## Deployment

Upgrade both connector profiles to the same 0.4.3 archive and refresh the existing DSH GUI. This release needs no upstream SuperAgent patch, no Source module reload and no task-board change.
