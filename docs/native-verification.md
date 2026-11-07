# Native conversation verification — 0.4.2

Environment: existing DSH 0.2.2-rc.1 Windows GUI, its existing task-board 0.4.15, and the existing WSL SuperAgent project. No replacement server or second board was started. Private launch URLs, Source credentials, conversation exports and fixture bytes are not published.

## Actual GUI and backend results

- **Native shell:** a Host-created Source Agent appeared in the actual Controller catalog; refresh → owned SessionReference → ready → SessionProvider → official embedded Conversation Factory produced the real Lexical composer and native user nodes. No bespoke textarea remained. Browser console: zero page errors.
- **Unsupported local actions:** final GUI checks observed zero visible local rollback/edit-fork or local model/permission controls within the Source scope. Copy and the real native composer remained available; ordinary-session behavior is separately covered by scoped client regressions.
- **Real response:** Enter submitted a read-only request. The actual Source journal appended one user request and one `reply` carrying the requested unique marker. No new ticket was created for this direct answer. It was not merely an acknowledgement or a local ordinary-model response.
- **Real attachments:** the native picker used two actual `/api/session/uploadFileBinary` requests. After the original upload gate settled, the Source received an ordinary file and a real PNG. Its actual reply returned the text's unique first line, the image's red color, exact 80×60 dimensions and pixel color. Those values were not supplied in the text prompt. A subsequent browser run reconstructed the media conversation without re-uploading or resubmitting. The Source legitimately chose a direct reply; this check did not force a synthetic ticket.
- **Upload race:** pressing Enter before upload completion produced the native “files have not finished uploading” refusal, retained the draft and appended no Source user request. A preview/chip or an enabled primary button is not evidence of upload completion. The test explicitly waited for the original upload responses before its next attempt.
- **Nonterminal Stop:** a separate explicitly requested read-only lifecycle ticket was created through normal Source intake. The UI selected that exact ticket/assignment/control generation and interrupted it during preparation. State became `paused` with actual cancellation `settled`; the ticket remained open. The canonical worker Session appeared while preparation settled, so an initially empty presentation field was not treated as a different worker identity.
- **Continue:** the UI explicitly selected the new generation and continued it. The same Assignment, canonical worker Session and worktree were retained; control sequence advanced from 0 to 1 to 2. The read-only ticket subsequently ended normally and the runtime reported zero running/queued workers. Stop did not call terminal ticket stop or create a retry Assignment.

The Stop check covers the actual preparation/cancellation/continuation boundary; it does not claim an OS sandbox or proof that every possible third-party tool honors cancellation. Source delivery is not a fabricated model stream. Model/permission/steer/approval/Plan/Goal/local rollback/fork controls remain unsupported as documented in the [README](<../README.en.md>).

Reproduction entry points: [native GUI](<../test/native.gui.mjs>), [attachment GUI](<../test/native-attachments.gui.mjs>), [Stop/continue GUI](<../test/native-stop.gui.mjs>). They require ignored private fixture/auth files and must never be run with blind retries against unknown Source outcomes.

## Isolated proofs and regressions

These are separate evidence, not replacements for the actual GUI results above:

- [Actual RC SDK regression suite](<../test/relay-agent.test.js>) plus [attachment suite](<../test/relay-attachments.test.js>): **24/24**, including real Controller catalog, actual global Agent Teams hooks and scoped-world provider replacement. Local LLM invocation count is zero.
- [Default factory / JSONL / cold fallback proof](<../experiments/native-relay/sdk-proof.mjs>): no ordinary Session persistence file, default Source namespace/fork publication refused, unload cold requests fail closed, Source history reconstructs without replaying uncertain input.
- [Full attachment proof](<../experiments/native-relay/attachments-proof.mjs>): actual native upload/admission/storage → bounded real bytes → fresh Source receipts → prepared/committed worker-readable files. A completely empty new native store restores only after scoped byte/digest validation. Missing blobs and unknown upload acknowledgements are not replayed or represented as readable images.
- [Cold worker history proof](<../integration-patches/cold-execution-proof.mjs>): actual sequence/time pages, zero cold Agent activation or LLM calls. Trace records remain separate provenance-bearing records, not synthesized native model/tool events.
- Independent read-only audit reproduced three P2 regressions, then [transport regressions](<../test/native-transport.test.js>) verified fixes: all ticket summaries are classified before bounding presentation; fresh Source capability revocations constrain cached native support; known rejected request reuse is refused before pinning unrelated files. [Upload route tests](<../test/source-attachment-routes.test.js>) also prove expired draft cleanup runs before quotas are enforced.

The upstream patch's complete test run retains its separately reproduced pre-existing Feishu consumer race; see the [patch verification notes](<../integration-patches/README.execution.md>). Do not describe that suite as wholly green or count explicitly skipped SDK/OS tests as passed.
