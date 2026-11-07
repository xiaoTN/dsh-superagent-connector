// Isolated real RC.1 SDK proof. No network, models, production sessions or installation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSourceRelay, relayRequestId } from '../../src/relay-agent.js'
import { createAttachmentStore } from '../../src/source-attachments.js'
import { readAdmittedAttachments } from './read-admitted.mjs'

const sdkRoot = process.env.DSH_NATIVE_SDK ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(sdkRoot, name, file)).href)
const [{ Context }, { SessionStore }, { AgentRegistry, agentEvents }, { SessionProjectionRegistry }, { SessionQueryEngine }, scope,
  { ApiSessionAgentController }, { SessionCommandController }, jsonl, { default: AgentLoop }, { LocalAttachmentStore }, { FileUploads }] = await Promise.all([
  load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-session-projection'), load('dsh-session-query'), load('dsh-scope'),
  load('dsh-api-session-controller', 'lib/types/agent.js'), load('dsh-api-session-controller', 'lib/types/commands.js'),
  load('dsh-session-persistence-jsonl'), load('dsh-agent-loop'), load('dsh-attachment-local'), load('dsh-client-file-upload'),
])
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const TEXT = Buffer.from('private isolated SDK fixture\n', 'utf8')
const disk = mkdtempSync(join(tmpdir(), 'dsh-native-attachments-proof-'))
const ctx = new Context(), routes = new Map(), relays = [], calls = { llm: 0, modelInfo: 0, source: 0, controls: 0 }
const sdk = { ...scope, SessionStore, AgentRegistry, agentEvents }
let uploadOwner, captured
const transport = {
  capabilities: async () => ({ version: 1, submit: true, attachments: true }),
  snapshot: async conversationId => ({ version: 1, conversationId, events: [], executions: [], hasMore: false }),
  submit: async () => { calls.source++; throw Error('Real Source sends are forbidden in this SDK fixture') },
  control: async () => { calls.controls++; throw Error('Real Source controls are forbidden') },
}
async function open(conversationId) {
  let relay, state
  const owner = await ctx.plugin({ inject: ['sessions', 'agents', 'sessionPersistence', 'attachments'], async apply(ownerCtx) {
    relay = await createSourceRelay(ownerCtx, { conversationId, cwd: disk, transport,
      outbox: { load: () => structuredClone(state), save: value => { state = structuredClone(value) } }, sdk, pollMs: 0 })
  } })
  assert.equal(owner.state, 2)
  relays.push({ relay, owner })
  return relay
}
async function rawUpload(sessionId, bytes, { name, mediaType } = {}) {
  const query = new URLSearchParams({ sessionId })
  if (name !== undefined) query.set('name', name)
  if (mediaType !== undefined) query.set('mediaType', mediaType)
  assert.equal(routes.size, 1, 'actual FileUploads service must mount its raw upload route')
  const route = [...routes.values()][0]
  const response = await route.fetch(new Request('http://isolated.fixture' + route.path + '?' + query, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
  }))
  assert.equal(response.status, 200)
  return response.json()
}
const reason = expected => error => error?.code === 'session/attachment-invalid' && error?.details?.reason === expected

try {
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionQueryEngine)
  ctx.provide('llm', new Proxy({}, { get: (_target, name) => () => {
    if (name === 'resolveModelInfo') calls.modelInfo++
    else calls.llm++
    throw Error('No local model/provider call is permitted')
  } }))
  ctx.provide('tools', {}); ctx.provide('systemPrompt', { variable() {} })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'forbidden', model: 'forbidden' }) })
  // These are only non-exercised registration ports: the actual upload handler,
  // receipt ownership/binding, attachment storage and Controller all run unchanged.
  ctx.provide('commands', { registerFileReceiptResolver: () => () => {} })
  ctx.provide('connection', { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  const persistence = await ctx.plugin(jsonl, { root: join(disk, 'ordinary-sessions'), compression: 'none' })
  assert.equal(persistence.state, 2)
  assert.equal((await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })).state, 2)
  assert.equal((await ctx.plugin(LocalAttachmentStore, { dshHome: join(disk, 'native-host') })).state, 2)
  uploadOwner = await ctx.plugin(FileUploads); assert.equal(uploadOwner.state, 2)

  const relay = await open('attachment-proof'), foreign = await open('foreign-proof')
  const agent = relay.agent, sessionId = relay.sessionId
  assert(agent.ctx.attachments instanceof LocalAttachmentStore)
  assert.equal(agent.model.current(), undefined)
  assert.notEqual(agent.session.header.origin, 'subagent')
  assert.equal(await ctx.sessionPersistence.stat(sessionId), undefined)
  const agentController = new ApiSessionAgentController(ctx), commands = new SessionCommandController(ctx, agentController)

  const fileUpload = await rawUpload(sessionId, TEXT, { name: 'note.txt' })
  assert.equal(fileUpload.ok, true)
  const imageUpload = await rawUpload(sessionId, PNG, { name: 'pixel.png', mediaType: 'image/png' })
  assert.equal(imageUpload.ok, true)
  const file = fileUpload.value, image = imageUpload.value
  assert.match(file.receiptId, /^[a-f0-9-]{36}$/); assert.match(image.receiptId, /^[a-f0-9-]{36}$/)
  assert.equal(ctx.fileUploads.resolve(foreign.agent, file.receiptId), undefined)
  assert.equal(ctx.fileUploads.resolve(foreign.agent, image.receiptId), undefined)
  assert.equal('path' in file.file, false); assert.equal('mediaType' in file.file, false)
  const source = { kind: 'user', rpcId: 'native-proof-request' }
  const content = [{ type: 'text', text: 'Inspect these actual uploaded fixtures' },
    { type: 'file', receiptId: image.receiptId }, { type: 'file', receiptId: file.receiptId }]
  await assert.rejects(commands.prompt({ sessionId: foreign.sessionId, requestId: 'foreign', mode: 'queue', content }, { kind: 'user', rpcId: 'foreign' }), reason('FILE_NOT_STAGED'))

  // This transport deliberately omits upload/read: the real driver's capability
  // gate must reject attachments before any Source side effect.
  await assert.rejects(commands.prompt({ sessionId, requestId: source.rpcId, mode: 'queue', content }, source), error =>
    error?.code === 'session/agent-busy' && error.details?.reason.includes('Source attachments require verified'))
  assert(ctx.fileUploads.resolve(agent, file.receiptId), 'failed followup must roll binding back, retaining receipt')
  assert(ctx.fileUploads.resolve(agent, image.receiptId))

  const originalFollowup = agent.followup
  agent.followup = message => { captured = structuredClone(message); throw Error('Intentional proof stop before Source sending') }
  await assert.rejects(commands.prompt({ sessionId, requestId: source.rpcId, mode: 'queue', content }, source), error =>
    error?.code === 'session/agent-busy' && error.details?.reason.includes('Intentional proof stop'))
  assert.deepEqual(captured.content.map(part => part.type), ['text', 'image', 'file'])
  assert.equal(captured.source.rpcId, source.rpcId)
  assert.deepEqual(captured.content[1].attachment, image.image)
  assert.deepEqual(captured.content[2].attachment, file.file)
  assert.equal('receiptId' in captured.content[1], false); assert.equal('data' in captured.content[1], false)
  assert.equal(calls.modelInfo, 0, 'model.current undefined must skip model modality resolution')

  // Save admitted content as a separate local outbox record, NOT a normal Session.
  const outbox = join(disk, 'private-outbox.json')
  writeFileSync(outbox, JSON.stringify(captured), { mode: 0o600 })
  const restoredMessage = JSON.parse(readFileSync(outbox, 'utf8'))
  const admitted = await readAdmittedAttachments(agent, restoredMessage)
  assert.equal(admitted.length, 2)
  assert.equal(admitted[0].mediaType, image.image.mediaType)
  assert.deepEqual(admitted[1].bytes, TEXT)
  assert.equal(admitted[1].mediaType, 'application/octet-stream')
  assert.deepEqual(admitted[0].bytes, Buffer.from((await ctx.attachments.readImage(image.image)).data))
  await assert.rejects(readAdmittedAttachments(agent, restoredMessage, { maxFileBytes: 1 }), /maxFileBytes/)
  await assert.rejects(readAdmittedAttachments(agent, restoredMessage, { maxFiles: 1 }), /count limit/)

  // Use the real Source attachment module under a DIFFERENT, private WSL root.
  // Only read bytes cross this seam: native receipts and host paths never do.
  const sourceStore = createAttachmentStore({ root: join(disk, 'source-host') })
  const request = { owner: 'proof-owner', conversationId: relay.agent.conversationId, requestId: relayRequestId(source.rpcId) }
  const remote = admitted.map(upload => sourceStore.upload({ ...request, name: upload.name, mediaType: upload.mediaType, bytes: upload.bytes }))
  const batch = { ...request, messageId: 'accepted-source-message', receipts: remote.map(upload => upload.receipt) }
  sourceStore.prepare(batch); sourceStore.commit(batch)
  for (let n = 0; n < remote.length; n++) {
    assert.notEqual(remote[n].receipt, n === 0 ? image.receiptId : file.receiptId)
    assert.notEqual(remote[n].receipt, admitted[n].localRef.attachmentId)
    const worker = sourceStore.resolve({ ...request, messageId: batch.messageId, receipt: remote[n].receipt })
    assert(worker.path.startsWith(join(disk, 'source-host')))
    assert.deepEqual(readFileSync(worker.path), admitted[n].bytes)
    assert.notEqual(worker.path, n === 0 ? ctx.attachments.imageHostPath(image.image) : ctx.attachments.fileHostPath(file.file))
  }

  // A successful memory-only capture appends the true admitted human message.
  // This exercises the real FileUploads user/message retirement listener, NOT
  // Source submission or a modified relay implementation.
  agent.followup = message => agent.session.append('user/message', message, { surfaceOp: 'append' })
  assert.deepEqual(await commands.prompt({ sessionId, requestId: source.rpcId, mode: 'queue', content }, source), { accepted: true })
  assert.equal(ctx.fileUploads.resolve(agent, image.receiptId), undefined)
  assert.equal(ctx.fileUploads.resolve(agent, file.receiptId), undefined)
  assert.deepEqual(await commands.prompt({ sessionId, requestId: source.rpcId, mode: 'queue', content }, source), { accepted: true }, 'native request-id dedup runs before expired receipt lookup')
  agent.followup = originalFollowup
  await ctx.sessions.flush(agent.session); await ctx.sessionPersistence.flush()
  assert.equal(await ctx.sessionPersistence.stat(sessionId), undefined)
  assert(!existsSync(join(disk, 'ordinary-sessions')) || readdirSync(join(disk, 'ordinary-sessions')).length === 0)

  // Disposal retires even an unbound receipt. A newly opened same-id facade
  // cannot reuse receipts from a previous Session object; durable refs DO work.
  const unbound = (await rawUpload(sessionId, TEXT, { name: 'remaining.txt' })).value
  await relay.dispose()
  assert.equal(ctx.fileUploads.resolve(agent, unbound.receiptId), undefined)
  const reopened = await open('attachment-proof')
  assert.equal(reopened.sessionId, sessionId)
  assert.equal(ctx.fileUploads.resolve(reopened.agent, unbound.receiptId), undefined)
  assert.deepEqual((await readAdmittedAttachments(reopened.agent, restoredMessage))[1].bytes, TEXT)
  assert.deepEqual(calls, { llm: 0, modelInfo: 0, source: 0, controls: 0 })

  const versions = Object.fromEntries(['dsh-client-file-upload', 'dsh-attachment-local', 'dsh-api-session-controller'].map(name =>
    [name, JSON.parse(readFileSync(join(sdkRoot, name, 'package.json'), 'utf8')).version]))
  const digests = Object.fromEntries([
    ['controller', 'dsh-api-session-controller/lib/types/commands.js'],
    ['uploads', 'dsh-client-file-upload/lib/index.js'], ['attachments', 'dsh-attachment-local/lib/index.js'],
  ].map(([name, path]) => [name, createHash('sha256').update(readFileSync(join(sdkRoot, path))).digest('hex')]))
  console.log(JSON.stringify({ versions, digests, realStreamingRoute: true, realFileUploads: true, realLocalAttachmentStore: true,
    realController: true, nativeMemoryOnlySessionAcceptedUploads: true, modelCurrentUndefinedAllowsImage: true,
    admittedKinds: captured.content.map(part => part.type), ordinaryFileHasMime: false,
    normalizedImageMime: admitted[0].mediaType, localRefsRecoverWithoutNativeReceipts: true,
    sourceStoreReuploadsActualBytesWithNewReceipts: true, workerPathsReadExactSourceBytes: true,
    rejectedFollowupKeepsReceipts: true, userMessageRetiresReceipts: true, sessionDisposalRetiresReceipts: true,
    noOrdinarySessionPersistence: true, calls,
    limitations: ['capture wrapper only; this transport deliberately omits the required upload/read capability', 'no browser interaction', 'both isolated roots use WSL; desktop-to-WSL network transfer not exercised', 'no actual Source message intake or worker/model invoked'],
  }, null, 2))
} finally {
  for (const { relay } of relays.reverse()) await relay.dispose()
  await ctx.fiber.dispose()
  assert(disk.startsWith(join(tmpdir(), 'dsh-native-attachments-proof-')))
  rmSync(disk, { recursive: true, force: true })
}
