# Native Source conversation — implemented design and evidence

Status: implemented for the planned **0.4.2** release on DSH **0.2.2-rc.1**. 0.4.0/0.4.1 were local staging only, without a public tag. This replaces the earlier investigation-only document. Real-machine send, attachment consumption, nonterminal Stop/continue and trace checks are recorded in the [verification record](<native-verification.md>); isolated SDK proofs remain separate evidence.

## Requirement and authority

Reuse the existing DSH conversation/input/attachment experience while keeping the real WSL SuperAgent as execution authority. Do not create an ordinary assistant, rename it, synthesize model/tool events, or turn a local UI preference into a WSL execution setting.

A Source thread such as `desktop-inbox:main` is **not** a worker Session. One message can answer directly, route to an existing ticket, create tickets or reach multiple subscribed workers. The actual worker Session and Assignment remain upstream-owned. Main/coordinator history mixes sources and is never presented as this conversation's private transcript.

The default UI currently opens the project's `main` conversation. The scoped transport/journal identities do not imply a complete multi-instance, independent-conversation-list or multi-tenant product.

## Native presentation seam

[The client](<../src/client.js>) opens a genuine Source facade through [the native Host](<../src/native-host.js>), refreshes the actual Controller catalog, and retains its admitted `SessionReference`. It then mounts the native Session Provider and the public `conversation.content` embedded Factory. An unavailable Factory/reference fails closed; it does not mount a fake reference or fall back to an ordinary Agent.

This reuses native Lexical input, queue, human-message/attachment presentation and conversation layout. Private InputBar/ChatView values are not imported across plugins. Enter queues input; Shift+Enter inserts a newline. The source renderer uses the actual custom event extension points alongside native human nodes, avoiding a second copy of the human transcript.

RC.1 does **not** offer the desired native per-session capability interface. The Source-scoped compatibility adapter uses DOM slots/ARIA plus synchronous action/input checks to hide/refuse unsupported controls. Host methods independently reject unsupported operations. This is an explicit **DOM/ARIA shim**, not an SDK capability or permission boundary; upstream DOM/locale/interface changes require revalidation. It is scoped to Source views and must not disable controls in ordinary DSH conversations.

Unsupported: local model/reasoning/permission selection, steer, approval, Plan, Goal, injected model context, local commands, title-LLM refresh, fork and any other unimplemented ordinary-Agent action. Only queue semantics are supported. Attachment controls require actual effective native-storage + cross-host upload/read capabilities, not a decorative button.

## Structural Agent and NativeRoot world

[The relay](<../src/relay-agent.js>) implements a real structural Agent registered in the actual Host AgentRegistry and SessionStore: inbox operations, followup, cancellation, status, scoped events, maintenance and lifecycle are explicit. It is neither an ordinary AgentLoop nor a model/provider alias. Its `model.current()` is undefined and model selection is refused; the real WSL model route remains upstream-owned.

[SDK loading](<../src/relay-sdk.js>) uses the public loader tree that loaded the connector. The imported constructors must own the actual Host SessionStore/AgentRegistry; a second bundled SDK/runtime copy is refused.

[The Agent world](<../src/relay-world.js>) uses a real Cordis dependency fiber. It reads the actual running AgentLoop constructor's public `inject` declaration and borrows only already-mounted Host foundations (including the real `systemPrompt` and `tools` needed by the Teams `agent/created` hook). This does **not** invoke the ordinary Agent factory, create an LLM/provider, or run a local model. The exact world disposer owns Source publication and drains before a changed foundation is reconstructed; it is not a root-context/inject bypass.

The facade is memory-only in ordinary SessionPersistence. Source history and a separate private outbox provide its durability. It never opens an ordinary JSONL writer merely to support attachments. Actual cold Controller lookup therefore cannot resurrect it via the default assistant factory. Retained-observation restoration and Source-origin forks are also guarded at native admission; an unknown preset or Source-looking name alone would be insufficient.

## Event vocabulary and Source history

- Genuine admitted human input is `user/message`, preserving native request/echo identity.
- A confirmed Source observation is a required log-only `superagent/source` event with `{customSource:'superagent', conversationId, event}`. Only Source assistant-role deliveries receive the custom Source view; human input must not render twice.
- Local handoff, uncertain status and control observations are `superagent/relay` records. These are not model events.
- Actual Source ports currently carry `acknowledgement`, `reply` and `notice`. Preserve their raw kind and ticket/request provenance. Compatibility spellings remain distinguishable; legacy entries without a kind stay `delivery`, never an inferred answer/result based on text.
- No fake assistant deltas, turns, steps, tool calls, token stream or local execution acceptance records are manufactured from these deliveries.

[The Source journal](<../src/conversation-store.js>) is append-only ordered conversation history in the Source's own state, with stable id/seq and request provenance. Reads page at most 200 entries within a byte budget. It is not truncated at 2000: only the legacy rollback mirror retains that limit. Confirmed history is reconstructed from Source, never synthesized from the desktop outbox. Offline/unavailable reads retain prior display data rather than inventing completion or empty history.

## Admission and durable unknown outcomes

[The private outbox](<../src/outbox-store.js>) is a synchronous save barrier before the Controller/NativeInputHub receives acceptance. It stores admitted native message content, including durable local attachment refs, separately from ordinary Session files.

State flow:

```text
explicit native submit → durable queued
before any upload/submit side effect → durable unknown
exact Source acknowledgement or matching Source history → accepted
local unsent removal → canceled
```

Recovered `queued` becomes uncertain; queued/unknown recovery only reconciles and **does not automatically resend**. A lost upload acknowledgement is already a potentially successful side effect. Preserve the request identity and ordered attachment signature. Reusing it with changed content conflicts. No retry loop turns an unavailable Source into a default local assistant.

The outbox currently caps each journal at 256 requests / 10 MiB. A full/corrupt/unwritable outbox refuses new native admission without discarding existing messages. It is not fixed by truncating pending records. This bounded retention is distinct from Source history retention.

[Source intake](<../src/source.js>) validates owner/conversation/request, uses a stable Trigger identity and fingerprints text plus ordered Source receipts. The Source journal and Trigger intake commit in the same Source atomic transaction. Acceptance is not completion, nor a promise that one message creates exactly one ticket.

## Attachment seam: bytes, not cross-host receipts

[Native attachment transfer](<../src/relay-attachments.js>), [the Source store](<../src/source-attachments.js>), [private DTO routes](<../src/source-attachment-routes.js>) and [Source attachment input](<../src/source-attachment-input.js>) implement:

1. The official native FileUploads service stores browser files/images and stages receipts for the exact receiving Session object. Controller receipt resolution and `admitPromptContent` turn them into real image/file refs before relay `followup`.
2. `followup` synchronously journals the admitted message/refs. The async relay pump then uses official `agent.ctx.attachments.readImage` / `readFileStream` to read bounded actual bytes. Native normalization may change image representation; use the stored reference's real MIME. Generic native FileRefs do not carry MIME and remain honest binary files.
3. The authenticated bridge uploads bytes to the real WSL Source store, obtaining **new random Source receipts** scoped to owner/conversation/request. Windows receipt, native attachment id and local path are not accepted as portable credentials.
4. Source `prepare` durably pins the exact receipt order and messageId. Server-only `resolvePrepared` verifies that precise prepared/committed binding and supplies a genuine read-only file path for trigger context **before** Source atomic intake; it does not mark the message committed.
5. Source atomic intake commits Trigger + journal, then attachment `commit` marks that bound batch committed. On a crash between the two commits, recovery replays commit from the Source's durable messages. Unknown transaction outcomes leave prepared bytes pinned; only a known failed Source transaction may abort preparation. Draft TTL never erases prepared or committed message files.
6. Worker context contains the genuine server-owned paths and image keys. Source `threadContext.image` rechecks original Source message/receipt ownership and the actual active model route's image modality, then calls its real attachment `saveImage`. Unsupported models/limits are errors, not claims of successful inspection. A controlled same-account worker can also read a real image path with `read_image`.
7. Source history restore downloads only committed files with exact scope/message binding, verifies receipt/length/SHA-256 and really imports bytes through native `saveImages`/`saveFile`. A fresh native attachment root can reconstruct its own valid refs; a fabricated ref or absent file is never a successful restore.

Source limits: 20 MiB/file, 10 files / 100 MiB/request, default 500 MiB / 1000 files total. Supported raster headers are PNG/JPEG/WebP/GIF; MIME mismatch and unsupported formats fail. Display names never choose storage paths; receipts use server-generated fixed-character names. Root/ancestor/file symlinks, path/URL traversal and content hardlinks are refused. Private files/manifests use atomic publication, integrity checks and crash recovery. Source paths stay server/controlled-worker-only; browser DTOs contain safe metadata/base64, not arbitrary filesystem paths.

Native staged receipts are deliberately ephemeral and Session-owned; the public service provides no persistent restaging interface. Reopening the same id does not revive old receipts. Accepted local drafts instead recover their durable admitted refs; unaccepted browser drafts genuinely upload again. Saving an ordinary Session log to preserve receipts would reintroduce unsafe default-driver cold restoration and is not used.

## Nonterminal controls and passive trace

The connector depends on the separately deployed [upstream execution patch](<../integration-patches/README.execution.md>) targeting commit `8c32a9d`. Apply/review, typecheck/test/build, then really reload the **idle** Source runtime. Updating the connector or build artifacts alone does not load the capability. Without actual `context.execution.version === 1`, controls/trace remain unavailable.

- Every operation verifies Source/thread/ticket subscription provenance, not an arbitrary worker Session id.
- Interrupt/Resume require `expectedAssignmentId` and `expectedControlSeq`; exact replay is idempotent, stale Assignment/generation conflicts.
- Stop commits a nonterminal hold. Resume retains the Assignment, worker Session, directory and branch; it is not terminal management stop or a retry creating a new Assignment.
- `paused` means hold committed; only `interruption:'settled'` proves the worker/preparation/jobs/subagents have drained. Resume refuses while cancellation is requested, failed or unsettled. A canceled HTTP wait is not worker cancellation.
- Native Stop chooses only a unique eligible assignment; otherwise require explicit ticket selection. Local unload/disposal only stops observation.
- Trace uses bounded cold history inspection: one underlying page, at most 100 visible entries / 128 KiB, original seq/time and a fixed cursor cut. No default Agent activation, no Main/coordinator history, and no hidden-page auto-scan. An empty filtered page is not evidence of no history.
- Reasoning/system prompts/raw tool arguments/results/configuration are not exported. Model-route metadata appears only when actually persisted by an event. Redaction is best effort, not a guarantee that any visible text contains no secrets.

## Existing task-board guard is unchanged

[The provider](<../src/taskboard.js>) still projects Source tickets into the existing native board. [The version/hash-pinned central guard](<../src/native-guard.js>) blocks local run admission for persistent externally managed cards before execution creation, including rerun/schedule/parent dispatch. Disabling the connector or changing a preset does not remove an installed guard. This separate local board patch is not replaced by the conversation shim or upstream execution patch.

## Evidence and remaining release acceptance

| Scope | Current evidence | Not established by that evidence |
| --- | --- | --- |
| Real RC.1 SDK integration | 24/24 suite, actual Controller/SessionStore/AgentRegistry/default factory/JSONL and Teams-world integration | A browser screenshot or completed production work |
| Native upload/admission | [Admission proof](<../experiments/native-attachments/sdk-proof.mjs>): real FileUploads, normalization, memory-only Session, zero model calls | Desktop-to-WSL network/UI completion |
| Full relay attachment path | [Driver proof](<../experiments/native-relay/attachments-proof.mjs>): bytes → new Source receipts → real files; fresh-native-root restore; lost-ack refusal | Actual worker/model vision result or final GUI acceptance |
| Passive execution history | [Cold execution proof](<../integration-patches/cold-execution-proof.mjs>) and upstream regression details in the [patch guide](<../integration-patches/README.execution.md>) | That merely upgrading connector loaded a running Source capability |
| Windows GUI and real WSL backend | Genuine native send/Source reply; unique text/image bytes read; settled nonterminal interruption during preparation and same-worker continuation to completion; 46 original seq/time records; no page errors | Arbitrary-tool OS cancellation or sandbox guarantees |

The [real-machine verification record](<native-verification.md>) records these checks independently of SDK assertions. Private conversation screenshots are not published. The [old v0.2 chat screenshot](<images/chat.png>) is historical simplified UI, not the native implementation.

No production/model task is required to run the isolated SDK probes. This document publishes no credentials, authenticated launch URL, private attachment or raw execution history. Operational safety remains one local owner / one repository with the existing WSL worker privileges, not an OS or multi-tenant sandbox.
