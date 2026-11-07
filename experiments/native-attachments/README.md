# Native attachment admission — isolated RC.1 proof

## Reproduce

```powershell
wsl --exec node /mnt/c/Users/1/Documents/deepseek-harness/default-workspace/dsh-superagent-board/experiments/native-attachments/sdk-proof.mjs
```

[sdk-proof.mjs](<sdk-proof.mjs>) runs the actual installed RC.1 Cordis, SessionStore, AgentRegistry, SessionQuery, SessionCommandController, LocalAttachmentStore (real Sharp validation/normalization), FileUploads raw HTTP handler, default AgentLoop factory and JSONL persistence listeners. There is no listener/server, provider, model call, production session, install or Source submission. Only the unrelated commands-registration and connection-route-registration ports are minimal fixture adapters. The actual registered upload handler receives real `Request` bodies. Temporary data is removed in `finally`.

Observed under WSL Node 24.22.2: all assertions pass; `llm`, `resolveModelInfo`, Source submits and Source controls are **0**. The proof prints exact SDK versions and SHA-256 identities, rather than assuming this remains true across SDK upgrades.

## Verified runtime results

1. **A Source-backed memory-only Session can upload files/images.** FileUploads does not require a SessionPersistence writer. Its “ordinary” check excludes `header.origin === 'subagent'`, not a structural Source relay. Flushing the actual JSONL service creates no ordinary relay file.
2. **`agent.model.current() === undefined` permits image admission.** The real Controller skips model-modality lookup in this case. No fake provider/model registration is needed.
3. Both browser file and image upload receipts enter a prompt as `{type:'file', receiptId}`. Controller resolves the exact Session-owned receipt, calls real `ctx.attachments.admitPromptContent`, then calls `agent.followup` with durable refs:

   ```js
   {
     id: '<native message id>', role: 'user',
     source: { kind: 'user', rpcId: '<native request id>' },
     content: [
       { type: 'image', attachment: {
         attachmentId: 'sha256:<64 hex>', mediaType: 'image/webp',
         bytes: 34, width: 1, height: 1, name: 'pixel.png'
         // optional originalDimensions: {width,height}
       } },
       { type: 'file', attachment: {
         attachmentId: 'sha256:<64 hex>', name: 'note.txt', bytes: 28
       } },
       { type: 'text', text: '<original text>' }
     ]
   }
   ```

   Byte sizes above illustrate the shape, not fixed values. Native UI orders attachment parts before text; the proof also verifies Controller preserves a caller's text-first order. No receipt/base64 remains in these admitted parts.
4. **Normalization changes actual representation.** The real 1×1 PNG fixture normalizes to WebP. Always use `stored.ref.mediaType` from `readImage`, not the browser MIME or display-name extension. Do not edit the declared MIME to bypass admission.
5. Official reading interfaces work through `agent.ctx.attachments`:

   ```js
   const {ref, data} = await agent.ctx.attachments.readImage(imageRef, signal)
   for await (const chunk of agent.ctx.attachments.readFileStream(fileRef, signal)) {
     // Count bytes before collecting/forwarding; enforce Source's own limits.
   }
   // For importing real Source history bytes back into the native attachment store:
   const [imageRef] = await agent.ctx.attachments.saveImages([{data, mediaType, name}])
   const fileRef = await agent.ctx.attachments.saveFile({data, name})
   ```

   `ImageRef`/`FileRef` are native-host content identities, **not cross-host authorization**. Native `FileRef` carries no MIME; generic files can honestly use `application/octet-stream`. Do not infer image type from a filename. A genuine image sent through a generic-file route may correctly be rejected by Source MIME validation rather than silently reclassified.
6. [read-admitted.mjs](<read-admitted.mjs>) is a minimal bounded reader for the relay's **asynchronous pump**. Its inputs are durable admitted refs, not browser receipts. A production relay must first synchronously persist the full admitted native message to its private durable outbox in `followup`; do not replace that durability barrier with this async helper.
7. The proof writes/loads that admitted message separately from SessionPersistence, reads its real bytes, reuploads those bytes into the real [Source attachment store](<../../src/source-attachments.js>) under another private WSL root, prepares/commits them, and verifies the new random Source receipts resolve to genuine worker-readable files containing exactly those bytes. Local host paths/receipt ids never cross this seam.

## Receipt ownership and lifecycle

Runtime assertions establish:

- Receipts are staged in `WeakMap<exact Session object, ...>`; another live Session cannot resolve them.
- Failed `followup` rolls prompt binding back. The original receipts remain usable for a corrected/retried admission.
- A successfully observed `user/message` with the true native `source.rpcId` retires the bound receipts. Same-request Controller dedup occurs before receipt resolution, so a successful duplicate does not need the old receipt.
- Session disposal retires even unbound receipts. Reopening the same session id does not recreate those receipts.
- Durable admitted attachment refs continue to read correctly after reopening the same Source facade, without an ordinary Session file.

There is **no public receipt persistence/restaging interface**: the declaration marks `stage` and `stagedFiles` private. Do not use private maps, fabricate receipts, or open an ordinary Session writer for attachments. Unaccepted browser drafts must genuinely upload again after the host loses their staged receipts; already admitted relay drafts recover from their separately persisted durable local refs.

## Native InputHub/browser lifecycle: static evidence, not browser execution

The shipped `dsh-client-ui-conversation/lib/client.js` was read directly. Relevant RC.1 locations:

- 4746–4837, `ConversationController.sendSession`: resolve all draft ids; require completed file uploads; serialize file **and uploaded image** as `{type:'file',receiptId}`; an image without a background upload uses a real encoded-image part. `beginSubmission` owns native acceptance/echo; drafts remain registered before Host acceptance, then observed echo retirement seeds image previews and releases draft attachments.
- 4840–4868, `createDrafts`: browser-supported image MIME creates image drafts/object URL previews; other content creates ordinary file drafts. Generic files upload immediately; images upload when enabled for that Session.
- 4882–4894: Workspace/session rebinding restarts uploads for the **new** Session, rather than reusing another Session's receipts.
- 4896–4986: uploads have cancellation, progress, ready/error state and bounded concurrency. Ready image state retains its receipt, not a portable Source reference.
- 5027–5056: removal releases browser drafts, aborts uploads and revokes image object URLs.
- 15357–15619, `SessionInputShell`: the public input facade tracks attachment ids and freezes attachment additions/removals during admission. `pruneAttachments` drops ids no longer present in the browser registry.

Those are static observations from the shipped bundle, not a claim that this probe mounted Lexical/React or interacted with a real browser. The native UI teammate owns that integration and uses the official Factory/input service; this experiment imports no private InputHub implementation.

## Safety and remaining integration

This fixture deliberately omits cross-host upload/read methods from its transport. The real relay driver's attachment capability gate therefore rejects admitted image/file parts before any side effect. The proof confirms that first, then installs a **fixture-only `followup` capture wrapper** that rejects before Source sending. A separate fixture-only memory acceptance appends a true `user/message` solely to exercise official receipt retirement. Neither wrapper is a production implementation. The production driver now supports attachments when the real storage/transport capability is present; its separate [full-driver proof](<../native-relay/attachments-proof.mjs>) exercises that path.

Desktop-to-WSL network upload, actual Source `atomic` intake, `threadContext.image`, worker `read_image`, browser rendering and actual model execution are not exercised here. The two isolated stores both run inside WSL; that proves the byte-transfer/store seam, not network deployment. Production must upload bytes to the authenticated real Source attachment route, retain its new scoped receipts, and only expose server paths to the controlled worker after Source-owned lifecycle checks.

REA was not used to produce these runtime results: the installed REA CLI's read-only doctor found no active DSH MCP registration. No registration/configuration was changed. Source facts above are labeled static inspection; runtime claims come from the executable actual-SDK assertions.
