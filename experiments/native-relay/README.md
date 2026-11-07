# Source-backed native relay — RC.1 proof

## Implemented interface

[relay-agent.js](<../../src/relay-agent.js>) exports:

```js
installSourceRelayGuards(hostCtx) // mount once BEFORE publishing Source sessions
const relay = await createSourceRelay(ownerCtx, {
  conversationId, // canonical Source identity; never a worker/coordinator Session id
  cwd,            // LOCAL native Session metadata only; not a WSL execution directory
  transport,
  outbox,         // { load(): state | undefined, save(state): void }, synchronous durable
  pollMs: 1000,   // 0 disables local polling for deterministic probes
  // sdk: optional canonical SDK namespace for tests/embedders
})
// relay.sessionId, relay.agent, relay.refresh(), relay.dispose()
// relay.interrupt({ticketId, expectedAssignmentId, expectedControlSeq})
// relay.resume({ticketId, expectedAssignmentId, expectedControlSeq})
```

The owner must inject `sessions` and `agents`, optional `sessionPersistence` if present, and `attachments` when enabling native file/image transfer. `relaySessionId(conversationId)` is `superagent-source-` plus SHA-256 of the canonical identity. `relayRequestId(nativeRpcId)` produces a stable 64-hex Source request identity. The original human message retains its unmodified native `source.rpcId`, so Controller deduplication/InputHub echo still work. **Transport must not hash again.**

Default SDK loading uses the *public* `ctx.fiber.entry.parent.tree.import()` that loaded the connector, not plugin-relative bare ESM resolution. [relay-sdk.js](<../../src/relay-sdk.js>) imports public `dsh-scope`, `dsh-agent`, `dsh-session` host namespaces and verifies that the actual Context stores are instances of those exact exported constructors. No loader or a second SDK copy refuses closed. No SDK package is bundled, installed, guessed from a fixed Windows path, or imported from a private InputBar module.

### Agent scoped world (including existing host extensions)

A custom structural Agent must compose the same **real scoped-world foundation** as ordinary native Agents. A narrow Source entry's inject list alone is insufficient: the actual Agent Teams `agent/created` hook reads `agent.ctx.systemPrompt` and `agent.ctx.tools`. [relay-world.js](<../../src/relay-world.js>) creates an official Cordis dependency fiber inside the Source owner's effect chain, using the running factory's public `constructor.inject` declaration plus the RC.1 foundation (`agents`, `sessions`, `llm`, `tools`, `systemPrompt`, `sessionProjections`) and available native attachments. Minimal SDK embedders may omit absent optional foundation services. All values are the existing host instances; no prompt/tool/model service is fabricated, and the ordinary factory is never invoked.

The scoped Session and Agent lifecycle lives entirely within that world fiber. This preserves parent isolation/intercepts and provider lifetime retention; it does not use a root-context or inject-check bypass. Existing global extensions can register genuine scope-local prompt sections/tools. Tools/SystemPrompt provider replacement tears down the old Source scope and reconstructs its facade from Source history without replaying input. `relay.agent` is consequently a dynamic getter; `relay.active` and `await relay.whenReady()` expose world readiness. The Source caller still owns complete disposal, which never interrupts a remote task.

The actual public Loader + actual Agent Teams tool plugin + real SystemPrompt/Tools regression first reproduced `cannot get property "systemPrompt" without inject` at the shipped Team hook. After the fix it verifies Source-only scoped contributions, no global leakage, independent Tools **and** SystemPrompt restarts, complete old-world cleanup, Source-history reconstruction and zero local LLM calls. Only Team membership is a fixture; neither scoped registry nor the failing extension is mocked.

Transport:

```js
capabilities() => {version:1, submit:true, interrupt:true, resume:true, ...}
snapshot(conversationId, {afterSeq, limit:200}, {signal}) => ({
  version:1, conversationId, events, hasMore,
  executions:[{ticketId, assignmentId, controlSeq, state,
    actions:{interrupt,resume}}], capabilities
})
submit({conversationId,text,requestId,attachments?:[sourceReceipt]}, {signal}) => ({
  accepted:true, conversationId, requestId, ...
})
upload({conversationId,requestId,name,mediaType,data:base64}, {signal}) => ({attachment:publicMetadata})
attachment({conversationId,requestId,messageId,receipt}, {signal}) => ({attachment:publicMetadata,data:base64})
control({conversationId,ticketId,expectedAssignmentId,expectedControlSeq,
  action:'interrupt'|'resume'}, {signal}) => result
```

Source events are contiguous positive per-conversation `seq`, and preserve `id`, `role`, `kind`, `text`, `at`, `ticketId`, `requestId` and any other JSON provenance. Snapshot reads begin with `afterSeq:0` and page forward. Execution trace cursors are unrelated and never used here.

## Event and UI contract

- Every observed Source delivery is a **log-only required event** `superagent/source`, with `data:{customSource:'superagent',conversationId,event:SourceEvent}`. It is not an LLM AssistantMessage.
- Durable true human submissions additionally become `user/message` with the original native identity and `surfaceOp:'append'`; Source history reconstructs human input without inventing a turn/step. Local outbox restores uncertain drafts only, never confirmed Source history.
- InputHub acceptance is observed through standard `agent/inbox/spliced` and `user/message`. The default loop's global inbox projection reads the same splice log. Complete Inbox mutations, model read/rejection, status, scoped dispatch, maintenance, cancellation and `whenIdle()` are implemented.
- A custom native Conversation renderer should render Source **assistant-role deliveries only** alongside default user nodes, otherwise human input would duplicate. The `role:'assistant'` field belongs to Source's delivery vocabulary, not the model event system. Preserve `kind:'ack'|'answer'|'attention'|'result'|'delivery'`.
- `superagent/relay` contains `{customSource:'superagent',conversationId,operation,outcome,...}` for durable-input handoff, uncertain status, availability and control observations. Its opening record is also the required owner marker recognized by fork guards.
- Agent status remains busy for Source summary `state:'running'|'pending'`, execution `running`/`pending`, unconfirmed `paused` interruptions, or a pending local submission/control. `requested`/`failed`/missing interruption confirmation never settles `whenIdle()`; a pause must be `interruption:'settled'`. A Source acknowledgement is not work completion.
- Steer while running, model selection and injected model context are rejected. Attachments are accepted only when the Source explicitly advertises support, both cross-host upload/read methods exist, and the native public attachment store has the required real read/write methods. Client must scope-hide unsupported controls (model/permission/plan/goal/compact/fork/local tools/title-LLM refresh) and force Source input to queued mode. Do not modify ordinary Agents' global UI.
- Native Stop only chooses a unique eligible current assignment/control sequence; otherwise it rejects `needs-selection` before transport. Explicit selected controls must supply current CAS. Unload/disposal aborts local observation only and never calls backend control.

## Durability and fail-closed rules

`outbox.save(queued)` must return synchronously before native `followup` returns. Before any transport call, `unknown` is durably recorded. An unacknowledged side effect remains uncertain, with its exact draft retained. Duplicate identities cannot change text or resend. Reloaded `queued` and `unknown` requests reconcile with Source; **neither automatically resends**. Source submission/outbox text is trimmed like Source validation, but the native human message remains byte-for-byte unchanged for echo. A Source user event with the canonical request identity and a matching SHA-256 `textDigest` of normalized input settles an uncertain record even when its displayed text is redacted; legacy events without a digest retain exact normalized-text comparison. Invalid/mismatched digests fail closed. Old V1 outbox outer whitespace is normalized on load without replay. [outbox-store.js](<../../src/outbox-store.js>) supplies the separate synchronous private store.

Fresh native queue insertions/replacements enforce Source v1's **12000 UTF-16 code-unit** limit on normalized text before any durable admission, inbox splice, echo or Source upload/submit. At the real Controller seam an oversize rejection preserves the draft; real FileUploads receipts are not consumed. The limit is deliberately not in shared input parsing: older long `unknown` drafts remain losslessly recoverable in the private bounded outbox and are never automatically resent.

This is a real SessionStore entry and real registered structural Agent. It does **not** open an ordinary SessionPersistence writer. The actual RC.1 JSONL backend only routes Session events to acquired writers, so its global listeners do not create a relay file. After unload, cold Controller lookup cannot observe a persisted relay; even a retained pre-unload observation cannot resume through the default factory because its log is absent. Reopening reconstructs history from Source.

The official serial `agent/created` guard rejects an ordinary driver with a reserved Source id, Source `parentSession`, or inherited Source owner marker. The marker check is necessary: RC.1 native Controller Fork does **not** include `parentSession` in its create metadata. AgentLoop waits for this event before releasing queued work; guard failures roll back publication. The guard does not replace the default factory or affect unrelated ordinary sessions.

## Real attachment handoff and history

[relay-attachments.js](<../../src/relay-attachments.js>) accepts only Controller-admitted `image`/`file` blocks carrying durable local references. It rejects encoded browser input, receipt-only blocks, paths, excessive counts and byte budgets. The private outbox stores those actual references and small Source receipt metadata, **never base64 or file contents**. Attachment-only submissions use `text:''`; no worker path is inserted into human text.

The pump first records `unknown`, then serially reads and verifies the real local objects. Images use `readImage().ref.mediaType` (the official normalizer may convert PNG into WebP); ordinary native files have no MIME and use honest `application/octet-stream` with `readFileStream()`. Only read bytes cross the upload seam. Source replies with NEW owner/request-scoped receipts; only those receipt strings go into submit. Ordered attachment identities are part of local duplicate detection and Source reconciliation. A lost upload/submit acknowledgement never causes automatic replay, including after reload. Recovered unknown drafts first re-read their local blobs before exposing native attachment references; if a prior-host blob is missing, the draft stays durable with a real availability error and no fake-readable image/file. A confirmed Source event can then re-import the exact scoped bytes into the new native store.

Source user events carry `attachments:[publicMetadata]`, each with `receipt`, `sha256`, `attachmentId`, `name`, `mediaType`, `size`, `isImage`, and image dimensions. Historical import fetches the exact conversation/request/message/receipt scope, verifies canonical base64, SHA-256, size and public metadata, then calls actual native `saveImages`/`saveFile` and verifies the resulting local references are readable. Native reference fields are never fabricated or rewritten to pretend a MIME. A failed read/import does not advance the Source cursor or publish a new human node; later pure reads can retry safely. Limits are **20 MiB/file, 10/event, 64 MiB/event/request**, serial network/storage access.

[attachments-proof.mjs](<attachments-proof.mjs>) exercises the real native Controller, real FileUploads upload/binding lifecycle, real LocalAttachmentStore and a separate real Source attachment store. File-only image+file submission transfers exact native normalized bytes under new Source receipts, committed Source worker paths read those bytes, and a completely empty different native store with copied unknown outbox references restores confirmed Source history into actual readable references while never publishing the still-uncertain missing local blob. Unknown-upload reload is not replayed. Failed/corrupt Source reads never invent a reference. Local model and model-info calls remain zero. Its transport is isolated/in-process: it does not claim desktop-to-WSL HTTP or actual worker-model execution coverage.

## Reproduction (isolated, no network/provider/service changes)

On this machine:

```powershell
wsl -d Ubuntu-22.04 -- env DSH_NATIVE_SDK=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node --test /mnt/c/Users/1/Documents/deepseek-harness/default-workspace/dsh-superagent-board/test/relay-agent.test.js /mnt/c/Users/1/Documents/deepseek-harness/default-workspace/dsh-superagent-board/test/relay-attachments.test.js
wsl -d Ubuntu-22.04 -- node /mnt/c/Users/1/Documents/deepseek-harness/default-workspace/dsh-superagent-board/experiments/native-relay/sdk-proof.mjs
wsl -d Ubuntu-22.04 -- node /mnt/c/Users/1/Documents/deepseek-harness/default-workspace/dsh-superagent-board/experiments/native-relay/attachments-proof.mjs
```

Observed: **24/24 tests pass** against real RC.1 Cordis/SessionStore/AgentRegistry/SessionQuery/Controller. [sdk-proof.mjs](<sdk-proof.mjs>) additionally mounts the real default AgentLoop factory and real JSONL persistence including its global listeners, performs native Controller prompt/Stop, flushes both stores, verifies no ordinary Session file, refuses cold and retained-observation restoration, restores Source history without replay, and observes **zero local LLM calls**.

[loader-fixture.js](<loader-fixture.js>) is imported through the actual public Loader in one integration test; the relay obtains the same SDK without explicit `sdk` or plugin-local SDK dependencies. Other tests cover actual Controller Fork refusal, current-control CAS selection, unload during a late network result, unknown acknowledgement reconciliation, synchronous save failure, full Inbox operations, and maintenance lifecycle.

Without `DSH_NATIVE_SDK`, regular Node test runs execute the four pure identity/attachment-contract tests and explicitly skip SDK-only tests; do not report skipped tests as SDK proof.

These probes establish the host module and Controller contract, not a full browser rendering or real remote-worker execution proof. UI integration and real Source/backend behavior remain their respective modules' acceptance work. No real Source history, credentials, existing service configuration or actual model provider was accessed.
