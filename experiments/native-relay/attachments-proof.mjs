// Real native Controller/FileUploads/AttachmentStore and separate real Source storage.
// This isolated in-process transport does not call a model, existing service, or external network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSourceRelay, relayRequestId, RELAY_EVENT } from '../../src/relay-agent.js';
import { createAttachmentStore } from '../../src/source-attachments.js';
import { createOutboxStore } from '../../src/outbox-store.js';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const TEXT = Buffer.from('real Source relay file-only fixture\n');
const sha = data => createHash('sha256').update(data).digest('hex');

export async function runAttachmentProof() {
  const sdkRoot = process.env.DSH_NATIVE_SDK ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
  const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(sdkRoot, name, file)).href);
  const [{ Context }, { SessionStore }, { AgentRegistry, agentEvents }, { SessionProjectionRegistry }, { SessionQueryEngine }, scope,
    { ApiSessionAgentController }, { SessionCommandController }, jsonl, { default: AgentLoop }, { LocalAttachmentStore }, { FileUploads }, { ApiSessionList }] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-session-projection'), load('dsh-session-query'), load('dsh-scope'),
    load('dsh-api-session-controller', 'lib/types/agent.js'), load('dsh-api-session-controller', 'lib/types/commands.js'),
    load('dsh-session-persistence-jsonl'), load('dsh-agent-loop'), load('dsh-attachment-local'), load('dsh-client-file-upload'),
    load('dsh-api-session-controller', 'lib/types/list.js'),
  ]);
  const sdk = { ...scope, SessionStore, AgentRegistry, agentEvents };
  const disk = mkdtempSync(join(tmpdir(), 'dsh-relay-attachments-proof-'));
  const sourceRoot = join(disk, 'source-host');
  const sourceStore = createAttachmentStore({ root: sourceRoot });
  const sourceEvents = [];
  const counts = { llm: 0, modelInfo: 0, uploads: 0, submits: 0, attachmentReads: 0, controls: 0 };
  const uploads = [];
  const contexts = [];
  let loseUploadAck = false, loseSubmitAck = true, failRead = false, corruptRead = false;
  const sourceScope = request => ({ owner: 'isolated-proof-owner', conversationId: request.conversationId, requestId: request.requestId });
  const transport = {
    capabilities: async () => ({ version: 1, submit: true, attachments: true }),
    snapshot: async (conversationId, { afterSeq }) => ({ version: 1, conversationId,
      events: sourceEvents.filter(event => event.conversationId === conversationId && event.seq > afterSeq), state: sourceEvents.length ? 'pending' : 'ended', executions: [], hasMore: false }),
    upload: async request => {
      counts.uploads++;
      assert.deepEqual(Object.keys(request).sort(), ['conversationId', 'data', 'mediaType', 'name', 'requestId']);
      const bytes = Buffer.from(request.data, 'base64');
      const attachment = sourceStore.upload({ ...sourceScope(request), name: request.name, mediaType: request.mediaType, bytes });
      uploads.push({ attachment, bytes, requestId: request.requestId });
      if (loseUploadAck) throw Error('uploaded bytes accepted but acknowledgement lost');
      return { attachment };
    },
    submit: async request => {
      counts.submits++;
      assert.equal(request.text, request.text.trim());
      assert(request.attachments.every(receipt => /^[a-f0-9]{64}$/u.test(receipt)));
      const id = `source-trigger-${sourceEvents.length + 1}`;
      const batch = { ...sourceScope(request), messageId: id, receipts: request.attachments };
      sourceStore.prepare(batch); sourceStore.commit(batch);
      const attachments = request.attachments.map(receipt => sourceStore.read({ ...batch, receipt }).attachment);
      sourceEvents.push({ seq: sourceEvents.length + 1, id, conversationId: request.conversationId, requestId: request.requestId,
        role: 'user', kind: 'request', text: request.text, textDigest: sha(request.text), at: 1, attachments });
      if (loseSubmitAck) throw Error('Source committed but acknowledgement lost');
      return { accepted: true, conversationId: request.conversationId, requestId: request.requestId, id };
    },
    attachment: async request => {
      counts.attachmentReads++;
      if (failRead) throw Error('real Source read temporarily unavailable');
      const stored = sourceStore.read({ ...sourceScope(request), messageId: request.messageId, receipt: request.receipt });
      return { attachment: stored.attachment, data: (corruptRead ? Buffer.from('corrupt') : stored.bytes).toString('base64') };
    },
    control: async () => { counts.controls++; throw Error('No backend control is permitted in this proof'); },
  };
  async function host(label) {
    const ctx = new Context(), routes = new Map(), relays = [], nativeRoot = join(disk, label);
    contexts.push(ctx);
    await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionQueryEngine);
    ctx.provide('llm', new Proxy({}, { get: (_target, key) => () => { counts[key === 'resolveModelInfo' ? 'modelInfo' : 'llm']++; throw Error('No local LLM'); } }));
    ctx.provide('tools', {}); ctx.provide('systemPrompt', { variable() {} });
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'forbidden', model: 'forbidden' }) });
    ctx.provide('commands', { registerFileReceiptResolver: () => () => {} });
    ctx.provide('connection', { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } });
    assert.equal((await ctx.plugin(jsonl, { root: join(disk, 'ordinary-sessions'), compression: 'none' })).state, 2);
    assert.equal((await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })).state, 2);
    assert.equal((await ctx.plugin(LocalAttachmentStore, { dshHome: nativeRoot })).state, 2);
    assert.equal((await ctx.plugin(FileUploads)).state, 2);
    const agentController = new ApiSessionAgentController(ctx), commands = new SessionCommandController(ctx, agentController);
    const catalog = new ApiSessionList(ctx, 10); await catalog.initialize();
    const open = async (conversationId = 'main', privateOutbox = join(nativeRoot, 'outbox')) => {
      const store = createOutboxStore({ root: privateOutbox, conversationId });
      let relay;
      const owner = await ctx.plugin({ inject: ['sessions', 'agents', 'sessionPersistence', 'attachments'], async apply(ownerCtx) {
        relay = await createSourceRelay(ownerCtx, { conversationId, cwd: nativeRoot, transport, sdk, pollMs: 0,
          outbox: { load: store.load, save: value => {
            assert(!JSON.stringify(value).includes('"data":'), 'durable outbox contains refs/metadata, never base64');
            store.save(value);
          } } });
      } });
      assert.equal(owner.state, 2); relays.push(relay);
      assert.equal((await catalog.list()).find(item => item.sessionId === relay.sessionId)?.agentAvailable, true);
      return { relay, owner, store };
    };
    const upload = async (sessionId, bytes, { name, mediaType } = {}) => {
      const route = [...routes.values()][0], query = new URLSearchParams({ sessionId, name });
      if (mediaType) query.set('mediaType', mediaType);
      const response = await route.fetch(new Request(`http://isolated.fixture${route.path}?${query}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
      }));
      assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.ok, true); return result.value;
    };
    return { ctx, commands, open, upload, nativeRoot, relays };
  }
  try {
    const first = await host('native-first');
    const { relay, owner, store } = await first.open();
    assert.equal(relay.capabilities.attachments, true);
    assert.equal(relay.agent.model.current(), undefined);
    const imageUpload = await first.upload(relay.sessionId, PNG, { name: 'pixel.png', mediaType: 'image/png' });
    const fileUpload = await first.upload(relay.sessionId, TEXT, { name: 'note.txt' });
    const rpcId = 'real-native-attachment-request';
    const content = [{ type: 'file', receiptId: imageUpload.receiptId }, { type: 'file', receiptId: fileUpload.receiptId }];
    assert.deepEqual(await first.commands.prompt({ sessionId: relay.sessionId, requestId: rpcId, mode: 'queue', content }, { kind: 'user', rpcId }), { accepted: true });
    await relay.agent.pumping;
    assert.equal(counts.uploads, 2); assert.equal(counts.submits, 1);
    assert.equal(relay.outboxState[0].text, '', 'attachment-only input must not invent human text');
    assert.equal(relay.outboxState[0].state, 'accepted', 'lost Source acknowledgement reconciles without resending');
    assert.deepEqual(relay.outboxState[0].message.content.map(part => part.type), ['image', 'file']);
    assert.equal(store.load().requests[0].message.content[0].attachment.mediaType, imageUpload.image.mediaType);
    assert.equal(uploads[0].attachment.mediaType, imageUpload.image.mediaType);
    assert.equal(uploads[1].attachment.mediaType, 'application/octet-stream');
    assert.deepEqual(uploads[1].bytes, TEXT);
    assert.equal(first.ctx.fileUploads.resolve(relay.agent, imageUpload.receiptId), undefined);
    assert.equal(first.ctx.fileUploads.resolve(relay.agent, fileUpload.receiptId), undefined);
    for (const value of uploads) {
      assert.notEqual(value.attachment.receipt, imageUpload.receiptId);
      assert.notEqual(value.attachment.receipt, fileUpload.receiptId);
      assert.notEqual(value.attachment.receipt, value.attachment.attachmentId);
      const worker = sourceStore.resolve({ ...sourceScope({ conversationId: 'main', requestId: relayRequestId(rpcId) }),
        messageId: sourceEvents[0].id, receipt: value.attachment.receipt });
      assert(worker.path.startsWith(sourceRoot));
      assert.deepEqual(readFileSync(worker.path), value.bytes);
    }
    assert.deepEqual(await first.commands.prompt({ sessionId: relay.sessionId, requestId: rpcId, mode: 'queue', content }, { kind: 'user', rpcId }), { accepted: true });
    assert.equal(counts.submits, 1, 'actual native duplicate bypasses retired receipts and cannot resend');
    assert.equal(relay.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1);
    assert.equal(relay.agent.session.snapshotEvents().filter(event => event.type === RELAY_EVENT).length, 1);

    // Oversize text with a genuine admitted attachment fails before Source upload,
    // durable admission or native echo, and the real native upload receipt stays usable.
    const longDraftUpload = await first.upload(relay.sessionId, TEXT, { name: 'long-draft.txt' });
    const beforeLongState = store.load(), beforeLongSeq = relay.agent.session.seq;
    await assert.rejects(first.commands.prompt({ sessionId: relay.sessionId, requestId: 'native-attachment-long-draft', mode: 'queue',
      content: [{ type: 'text', text: 'x'.repeat(12001) }, { type: 'file', receiptId: longDraftUpload.receiptId }] },
    { kind: 'user', rpcId: 'native-attachment-long-draft' }),
    error => error.code === 'session/agent-busy' && /12000/u.test(error.details?.reason ?? ''));
    assert.equal(relay.agent.session.seq, beforeLongSeq);
    assert.deepEqual(store.load(), beforeLongState);
    assert(first.ctx.fileUploads.resolve(relay.agent, longDraftUpload.receiptId));
    assert.equal(counts.uploads, 2); assert.equal(counts.submits, 1);

    // An actual upload whose result is unknown must never be replayed after reload.
    loseUploadAck = true;
    const uncertain = await first.upload(relay.sessionId, TEXT, { name: 'uncertain.txt' });
    const uncertainRpc = 'uncertain-native-upload-request';
    await first.commands.prompt({ sessionId: relay.sessionId, requestId: uncertainRpc, mode: 'queue', content: [{ type: 'file', receiptId: uncertain.receiptId }] }, { kind: 'user', rpcId: uncertainRpc });
    await relay.agent.pumping;
    assert.equal(counts.uploads, 3); assert.equal(counts.submits, 1);
    assert.equal(relay.outboxState.find(item => item.requestId === relayRequestId(uncertainRpc)).state, 'unknown');
    await owner.dispose();
    const { relay: reopened } = await first.open();
    await reopened.refresh();
    assert.equal(counts.uploads, 3); assert.equal(counts.submits, 1);
    await reopened.dispose();

    // Restore Source history into a genuinely EMPTY, different native AttachmentStore.
    loseUploadAck = false; loseSubmitAck = false;
    const previousReads = counts.attachmentReads;
    // Simulate a crash before the lost Source acknowledgement was reconciled. The
    // copied real outbox still contains prior-host refs, but this native store is EMPTY.
    const uncertainOutbox = store.load();
    uncertainOutbox.requests.find(item => item.requestId === relayRequestId(rpcId)).state = 'unknown';
    store.save(uncertainOutbox);
    const second = await host('native-restored');
    const { relay: restored } = await second.open('main', join(first.nativeRoot, 'outbox'));
    assert.equal(counts.attachmentReads - previousReads, 2);
    assert.equal(restored.outboxState.find(item => item.requestId === relayRequestId(rpcId)).state, 'accepted');
    assert.equal(restored.outboxState.find(item => item.requestId === relayRequestId(uncertainRpc)).state, 'unknown');
    assert.equal(restored.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.rpcId === uncertainRpc).length, 0, 'missing prior-host blob is not published as a readable native ref');
    assert(restored.agent.session.snapshotEvents().some(event => event.type === 'superagent/relay'
      && event.data.operation === 'restore-local-attachments' && event.data.outcome === 'unavailable'));
    const human = restored.agent.session.deriveMessages()[0];
    assert.deepEqual(human.content.map(part => part.type), ['image', 'file']);
    const restoredImage = await second.ctx.attachments.readImage(human.content[0].attachment);
    const chunks = [];
    for await (const chunk of second.ctx.attachments.readFileStream(human.content[1].attachment)) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), TEXT);
    assert.equal(human.content[0].attachment.mediaType, restoredImage.ref.mediaType);
    assert.notEqual(second.ctx.attachments.fileHostPath(human.content[1].attachment), first.ctx.attachments.fileHostPath(fileUpload.file));
    assert.equal(counts.uploads, 3); assert.equal(counts.submits, 1, 'historical import performs only authorized reads');

    // Failed or corrupt remote reads preserve cursor and cannot fabricate native refs.
    const external = { owner: 'isolated-proof-owner', conversationId: 'main', requestId: 'external-native-history-request' };
    const metadata = sourceStore.upload({ ...external, name: 'later.txt', mediaType: 'application/octet-stream', bytes: TEXT });
    const batch = { ...external, messageId: 'source-trigger-2', receipts: [metadata.receipt] };
    sourceStore.prepare(batch); sourceStore.commit(batch);
    sourceEvents.push({ seq: 2, id: batch.messageId, conversationId: 'main', requestId: external.requestId, role: 'user', kind: 'request',
      text: '', textDigest: sha(''), at: 2, attachments: [metadata] });
    failRead = true;
    await assert.rejects(restored.refresh());
    assert.equal(restored.agent.cursor, 1);
    assert.equal(restored.agent.session.deriveMessages().length, 1);
    failRead = false; corruptRead = true;
    await assert.rejects(restored.refresh(), { code: 'attachment-integrity' });
    assert.equal(restored.agent.cursor, 1);
    corruptRead = false;
    await restored.refresh();
    assert.equal(restored.agent.cursor, 2);
    assert.equal(restored.agent.session.deriveMessages().length, 2);
    await second.ctx.sessions.flush(restored.agent.session); await second.ctx.sessionPersistence.flush();
    assert.equal(await second.ctx.sessionPersistence.stat(restored.sessionId), undefined);
    assert.deepEqual(readdirSync(disk).filter(name => name === 'ordinary-sessions'), []);
    assert.equal(counts.llm, 0); assert.equal(counts.modelInfo, 0); assert.equal(counts.controls, 0);
    return { actualController: true, actualFileUploads: true, actualNativeAttachmentStore: true, actualSourceAttachmentStore: true,
      fileOnlySubmission: true, normalizedImageMime: uploads[0].attachment.mediaType, distinctSourceReceipts: true,
      realWorkerPathsReadExactBytes: true, emptyNativeStoreRestoredSourceBytes: true, missingLocalUnknownRefsNeverPublished: true, failedReadsNeverInventRefs: true,
      unknownUploadNotReplayed: true, nativeCatalogContainsMemoryRelay: true, noOrdinarySessionFiles: true, counts,
      limitation: 'isolated in-process transport; Source HTTP and real worker intake are separate integration proofs' };
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    assert(disk.startsWith(join(tmpdir(), 'dsh-relay-attachments-proof-')));
    rmSync(disk, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(JSON.stringify(await runAttachmentProof(), null, 2));
