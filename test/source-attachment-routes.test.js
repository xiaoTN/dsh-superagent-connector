import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { createAttachmentStore } from '../src/source-attachments.js'
import { HttpError } from '../src/security.js'
import {
  handleSourceAttachment, SOURCE_ATTACHMENT_PREFIX, SOURCE_ATTACHMENT_MAX_BASE64_BYTES,
  SOURCE_ATTACHMENT_MAX_FILE_BYTES, SOURCE_ATTACHMENT_MAX_JSON_BYTES,
} from '../src/source-attachment-routes.js'

const OWNER = 'desktop-owner', CONVERSATION = 'main', REQUEST = 'native-request-0123456789', MESSAGE = 'source-message-123'
const PATH = SOURCE_ATTACHMENT_PREFIX + '/' + CONVERSATION + '/attachments'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const body = (extra = {}) => ({ requestId: REQUEST, name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64'), ...extra })
const status = expected => error => error instanceof HttpError && error.status === expected
function request(method, url, value, headers = {}) {
  const bytes = value === undefined ? Buffer.alloc(0) : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  const req = Readable.from([bytes]); req.method = method; req.url = url; req.headers = { 'content-type': 'application/json', ...headers }
  return req
}
function fixture(t, limits) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-source-attachment-routes-'))
  t.after(() => { assert(basename(root).startsWith('dsh-source-attachment-routes-')); rmSync(root, { recursive: true, force: true }) })
  const store = createAttachmentStore({ root, ...(limits ? { limits } : {}) }), options = { store, owner: OWNER }
  return { root, store, options, handle: req => handleSourceAttachment(options, req) }
}
function binding(file, change = {}) { return { owner: OWNER, conversationId: CONVERSATION, requestId: REQUEST, messageId: MESSAGE, receipts: [file.receipt], ...change } }
const download = (receipt, query = 'requestId=' + REQUEST + '&messageId=' + MESSAGE) => PATH + '/' + receipt + '?' + query

test('upload intake reclaims expired drafts before enforcing the total file quota',async t=>{
  const root=mkdtempSync(join(tmpdir(),'dsh-source-attachment-routes-'))
  t.after(()=>{assert(basename(root).startsWith('dsh-source-attachment-routes-'));rmSync(root,{recursive:true,force:true})})
  let clock=1
  const store=createAttachmentStore({root,clock:()=>clock,limits:{maxTotalFiles:1,draftTtlMs:1}})
  store.upload({owner:OWNER,conversationId:CONVERSATION,requestId:REQUEST,name:'expired.txt',mediaType:'text/plain',bytes:Buffer.from('old')})
  clock=5
  const result=await handleSourceAttachment({store,owner:OWNER},request('POST',PATH,body({requestId:'fresh-request-0123456789'})))
  assert.equal(result.status,201)
  assert.equal(result.body.attachment.name,'note.txt')
})

test('upload route returns only safe public metadata and durable real bytes', async t => {
  const { root, store, handle } = fixture(t)
  const result = await handle(request('POST', PATH, body({ name: '../../private\\note.txt' })))
  assert.equal(result.status, 201)
  assert.deepEqual(Object.keys(result.body), ['attachment'])
  const file = result.body.attachment
  assert.equal(file.name, 'note.txt'); assert.equal(file.size, 5); assert.equal(file.isImage, false)
  assert.match(file.receipt, /^[a-f0-9]{64}$/); assert.match(file.sha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(result).includes(root), false); assert.equal('path' in file, false)
  assert.deepEqual(store.read({ owner: OWNER, conversationId: CONVERSATION, requestId: REQUEST, receipt: file.receipt }).bytes, Buffer.from('hello'))
})

test('downloads require committed exact owner/conversation/request/message binding', async t => {
  const { root, store, handle, options } = fixture(t)
  const file = (await handle(request('POST', PATH, body()))).body.attachment
  await assert.rejects(handle(request('GET', download(file.receipt))), status(409), 'draft must not be exposed')
  store.prepare(binding(file))
  const prepared = store.resolvePrepared({ ...binding(file), receipt: file.receipt })
  assert.deepEqual(readFileSync(prepared.path), Buffer.from('hello'))
  await assert.rejects(handle(request('GET', download(file.receipt))), status(409), 'server-only prepared paths must not authorize download')
  store.commit(binding(file))
  const result = await handle(request('GET', download(file.receipt)))
  assert.equal(result.status, 200); assert.deepEqual(result.body.attachment, file)
  assert.deepEqual(Buffer.from(result.body.data, 'base64'), Buffer.from('hello'))
  assert.equal(JSON.stringify(result).includes(root), false)
  await assert.rejects(handleSourceAttachment({ ...options, owner: 'other' }, request('GET', download(file.receipt))), status(404))
  await assert.rejects(handle(request('GET', download(file.receipt).replace('/main/', '/other/'))), status(404))
  await assert.rejects(handle(request('GET', download(file.receipt, 'requestId=another-request-123456&messageId=' + MESSAGE))), status(404))
  await assert.rejects(handle(request('GET', download(file.receipt, 'requestId=' + REQUEST + '&messageId=wrong'))), status(404))
})

test('repeated upload is idempotent only inside its original scope', async t => {
  const { handle, options } = fixture(t)
  const first = await handle(request('POST', PATH, body()))
  assert.deepEqual(await handle(request('POST', PATH, body())), first)
  const changed = [
    await handleSourceAttachment({ ...options, owner: 'other' }, request('POST', PATH, body())),
    await handle(request('POST', PATH.replace('/main/', '/other/'), body())),
    await handle(request('POST', PATH, body({ requestId: 'other-request-123456' }))),
  ]
  for (const result of changed) assert.notEqual(result.body.attachment.receipt, first.body.attachment.receipt)
})

test('canonical base64 is enforced without MIME changes or data-URL fallbacks', async t => {
  const { handle } = fixture(t)
  for (const data of ['Zg', 'Zg=', 'Zh==', 'Zg===', 'Zg==\n', 'Z g==', 'data:text/plain;base64,Zg==', '-_==', '====', 'a===', 'AAAA=AAA']) {
    await assert.rejects(handle(request('POST', PATH, body({ data }))), status(400), data)
  }
  const empty = await handle(request('POST', PATH, body({ data: '', name: 'empty.bin', mediaType: 'application/octet-stream' })))
  assert.equal(empty.body.attachment.size, 0)
  const image = await handle(request('POST', PATH, body({ data: PNG.toString('base64'), name: 'pixel.png', mediaType: 'image/png' })))
  assert.equal(image.body.attachment.isImage, true); assert.equal(image.body.attachment.mediaType, 'image/png')
  for (const mediaType of ['text/plain', 'application/octet-stream', 'image/jpeg']) await assert.rejects(handle(request('POST', PATH, body({ data: PNG.toString('base64'), mediaType }))), status(415))
  await assert.rejects(handle(request('POST', PATH, body({ mediaType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }))), status(415))
})

test('JSON schema rejects caller-owned identities, paths, extra fields and malformed bodies', async t => {
  const { handle } = fixture(t)
  for (const value of [null, [], 'null', '{}', '{broken', body({ owner: 'other' }), body({ conversationId: 'other' }), body({ path: '/etc/passwd' }), body({ root: '/tmp' }), body({ receipt: 'a'.repeat(64) }), body({ data: 1 }), body({ requestId: 'short' }), body({ mediaType: undefined }), body({ name: undefined })]) {
    await assert.rejects(handle(request('POST', PATH, value)), status(400))
  }
  await assert.rejects(handle(request('POST', PATH, body(), { 'content-type': 'text/plain' })), status(415))
})

test('method, route and request targets reject normalized aliases, URLs and path traversal', async t => {
  const { handle } = fixture(t), receipt = 'a'.repeat(64)
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) await assert.rejects(handle(request(method, PATH)), status(405))
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) await assert.rejects(handle(request(method, download(receipt), body())), status(405))
  for (const target of ['https://example.test' + PATH, '//' + 'example.test' + PATH, PATH + '#hash', PATH + '\\evil', PATH + '/%2e%2e', PATH.replace('/main/', '/%6dain/'), PATH + '\n', PATH + '/..', PATH + '/https://example.test/a']) {
    await assert.rejects(handle(request('GET', target)), error => error instanceof HttpError && [400, 404, 405].includes(error.status), target)
  }
  for (const target of [PATH + '/', PATH + '/' + receipt + '/extra']) await assert.rejects(handle(request('GET', target)), status(404))
  assert.equal(await handle(request('GET', SOURCE_ATTACHMENT_PREFIX + '/main/events')), undefined)
  assert.equal(await handle(request('GET', '/unrelated')), undefined)
})

test('query scope is mandatory, unique and exact; no alternate owners/URLs/empty aliases', async t => {
  const { handle } = fixture(t), receipt = 'a'.repeat(64)
  await assert.rejects(handle(request('GET', PATH + '/' + receipt)), status(400))
  for (const query of ['', 'requestId=' + REQUEST, 'messageId=' + MESSAGE, 'requestId=' + REQUEST + '&messageId=' + MESSAGE + '&owner=other',
    'requestId=' + REQUEST + '&requestId=' + REQUEST, 'requestId=' + REQUEST + '&messageId=',
    'requestId=' + REQUEST + '&messageId=' + MESSAGE + '&', 'requestId=short&messageId=' + MESSAGE,
    'requestId=' + REQUEST + '&messageId=https://example.test/path', 'requestId=%61bc&messageId=' + MESSAGE]) {
    await assert.rejects(handle(request('GET', download(receipt, query))), status(400), query)
  }
  for (const suffix of ['?', '?owner=other', '?requestId=' + REQUEST]) await assert.rejects(handle(request('POST', PATH + suffix, body())), status(400))
})

test('unknown, expired, over-quota and unavailable stores map to safe HTTP errors', async t => {
  const { handle, options } = fixture(t, { maxFilesPerRequest: 1 })
  await assert.rejects(handle(request('GET', download('a'.repeat(64)))), status(404))
  await handle(request('POST', PATH, body()))
  await assert.rejects(handle(request('POST', PATH, body({ name: 'second.txt' }))), status(413))
  await assert.rejects(handleSourceAttachment({ owner: OWNER }, request('POST', PATH, body())), status(503))
  const aging = fixture(t)
  let at = 0
  const timedStore = createAttachmentStore({ root: aging.root, clock: () => at, limits: { draftTtlMs: 10 } })
  const timedOptions = { owner: OWNER, store: timedStore }
  const draft = (await handleSourceAttachment(timedOptions, request('POST', PATH, body()))).body.attachment
  at = 10
  await assert.rejects(handleSourceAttachment(timedOptions, request('GET', download(draft.receipt))), status(410))
  const badStore = { upload() { throw Error('private arbitrary /filesystem/path') }, read() {}, resolve() {} }
  await assert.rejects(handleSourceAttachment({ ...options, store: badStore }, request('POST', PATH, body())), error => error instanceof HttpError && error.status === 503 && !error.message.includes('/filesystem'))
})

test('20 MiB real byte ceiling accepts the exact limit and rejects larger canonical data', async t => {
  const { handle } = fixture(t)
  assert.equal(SOURCE_ATTACHMENT_MAX_FILE_BYTES, 20 * 1024 * 1024)
  const exact = Buffer.alloc(SOURCE_ATTACHMENT_MAX_FILE_BYTES).toString('base64')
  assert.equal(exact.length, SOURCE_ATTACHMENT_MAX_BASE64_BYTES)
  const result = await handle(request('POST', PATH, body({ name: 'large.bin', mediaType: 'application/octet-stream', data: exact })))
  assert.equal(result.body.attachment.size, SOURCE_ATTACHMENT_MAX_FILE_BYTES)
  // Same encoded length, one additional decoded byte: no-padding base64 must fail before allocation/storage.
  await assert.rejects(handle(request('POST', PATH, body({ data: 'A'.repeat(SOURCE_ATTACHMENT_MAX_BASE64_BYTES) }))), status(413))
  await assert.rejects(handle(request('POST', PATH, body({ data: 'A'.repeat(SOURCE_ATTACHMENT_MAX_BASE64_BYTES + 4) }))), status(413))
  await assert.rejects(handle(request('POST', PATH, ' '.repeat(SOURCE_ATTACHMENT_MAX_JSON_BYTES + 1))), status(413))
})
