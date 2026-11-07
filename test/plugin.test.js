import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { handler, PREFIX, trusted } from '../src/index.js'
import { boardSnapshot, requestJson, upstreamBase } from '../src/upstream.js'
import { makeInboxHandler, makeSource, messageView, OWNER, SOURCE, submit } from '../src/source.js'
import { redact, safeLink, validateMessage } from '../src/security.js'

const requestId = 'a35743da-2222-4222-8222-811bb23cfe52'
const message = { text: 'Describe this project. Do not modify anything.', requestId }
function req(method = 'GET', path = PREFIX + '/board', body, extra = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  return Object.assign(r, { method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1234',
    'x-superagent-board': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra } })
}
function response() {
  return { status: 0, body: null, headers: {}, writeHead(code, headers) { this.status = code; this.headers = headers }, end(body) { this.body = JSON.parse(body) } }
}
const connection = () => ({ requestRejection: () => undefined })
function sourceContext() {
  const kv = new Map(), triggers = new Map()
  const ctx = {
    state: { get: key => structuredClone(kv.get(key)), set: (key, value) => kv.set(key, structuredClone(value)) },
    triggers: { get: id => triggers.get(id) }, config: () => ({}), configured: () => true,
    receive(t) { if (triggers.has(t.id)) return 'duplicate'; triggers.set(t.id, t); return 'stored' },
    threads: { describe() {} },
    atomic(fn) {
      const oldKV = new Map(kv), oldTriggers = new Map(triggers)
      try { return fn() } catch (e) { kv.clear(); oldKV.forEach((v, k) => kv.set(k, v)); triggers.clear(); oldTriggers.forEach((v, k) => triggers.set(k, v)); throw e }
    },
  }
  return ctx
}

test('public route requires real DSH connection authentication, not a cookie-looking header', async () => {
  const r = req(); assert.equal(trusted(r, undefined), false)
  assert.equal(trusted(r, { requestRejection: () => 'denied' }), false)
  assert.equal(trusted(req('GET', PREFIX + '/board', undefined, { cookie: 'dsh-auth-forged=1' }), undefined), false)
  assert.equal(trusted(req('GET', PREFIX + '/board', undefined, { origin: 'https://evil.invalid' }), connection()), false)
  const res = response()
  await handler({ base: upstreamBase(), token: () => '', connection: () => undefined })(r, res)
  assert.equal(res.status, 401)
})

test('upstream is pinned to physical loopback; credentials, path, redirects and public hosts refused', async () => {
  for (const value of ['https://127.0.0.1:3082', 'http://example.com', 'http://127.0.0.1.evil', 'http://localhost', 'http://a:b@127.0.0.1', 'http://127.0.0.1/path']) {
    assert.throws(() => upstreamBase(value))
  }
  await assert.rejects(requestJson(upstreamBase(), '/orchestrator/api/settings'), /Unsupported/)
  const server = createServer((_req, res) => { res.writeHead(302, { location: 'http://example.com' }); res.end() }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try { await assert.rejects(requestJson(upstreamBase('http://127.0.0.1:' + server.address().port), '/orchestrator/api/state'), /unavailable/) }
  finally { server.close() }
})

test('board projects open and ended pages, preserving non-success endings and excluding private environment', async () => {
  const paths = []
  const data = await boardSnapshot(upstreamBase(), async (_b, path) => {
    paths.push(path)
    if (path.endsWith('/state')) return { health: { runtime: { state: 'ready' } }, load: { running: 0, queued: 1 } }
    const ended = path.includes('state=ended')
    return { items: [{ id: ended ? 'ended' : 'open', title: 'A task', state: ended ? 'ended' : 'open', stage: ended ? 'ended' : 'working', action: ended ? '' : 'queued',
      ended: { outcome: 'stopped' }, directory: '/private/path', environment: { SECRET: 'do-not-expose' }, summary: 'key sk-abcdefghijklmnopqrstuvwxyz1234',
      threads: [{ url: 'https://github.com/xiaoTN/example/pull/2', title: 'PR' }, { url: 'https://evil.invalid/?token=SECRET' }] }], total: 1, next_offset: null }
  })
  assert.equal(data.items.length, 2); assert.equal(paths.length, 3)
  assert.equal(data.items.find(t => t.stage === 'ended').outcome, 'stopped')
  assert.equal(JSON.stringify(data).includes('do-not-expose'), false)
  assert.equal(JSON.stringify(data).includes('/private/path'), false)
  assert.equal(data.items[0].threads.length, 1)
  assert.match(data.items[0].summary, /REDACTED/)
})

test('schema changes produce an error instead of an empty healthy board', async () => {
  await assert.rejects(boardSnapshot(upstreamBase(), async () => ({})), /Unsupported/)
  await assert.rejects(boardSnapshot(upstreamBase(), async (_b, path) => path.endsWith('/state')
    ? { health: {}, load: {} } : { items: [], total: 0, next_offset: 0 }), /pagination/)
})

test('message validation refuses actor spoofing, huge content and invalid idempotency keys', () => {
  assert.deepEqual(validateMessage(message), message)
  for (const bad of [{ ...message, actor: 'admin' }, { ...message, text: '' }, { ...message, text: 'a'.repeat(12001) }, { ...message, requestId: 'x' }]) assert.throws(() => validateMessage(bad))
  assert.equal(safeLink('javascript:alert(1)'), null)
  assert.equal(safeLink('https://github.com/a/b?token=hello'), null)
  assert.equal(redact('api_key=secret-value').includes('secret-value'), false)
})

test('submit is atomic and idempotent; local messages go through the real Trigger interface', () => {
  const ctx = sourceContext()
  const first = submit(ctx, message), second = submit(ctx, message)
  assert.equal(first.id, second.id); assert.equal(second.duplicate, true)
  assert.equal(ctx.triggers.get(first.id).actor.id, OWNER)
  assert.equal(ctx.triggers.get(first.id).source, SOURCE)
  assert.equal(ctx.triggers.get(first.id).human, true)
  assert.equal(ctx.triggers.get(first.id).addressed, 'direct')
  assert.throws(() => submit(ctx, { ...message, text: 'changed' }), /already used/)
  const broken = sourceContext(); broken.receive = () => { throw new Error('fail') }
  assert.throws(() => submit(broken, message)); assert.equal(broken.state.get('desktop-inbox:messages:v1'), undefined)
})

test('Source token and allowlist required; server identity cannot be chosen by client', async () => {
  const ctx = sourceContext(), token = 'a'.repeat(64)
  let allowed = false
  const handle = makeInboxHandler({ context: ctx, token, registry: { policyPart: () => ({ allowed: allowed ? [{ id: OWNER }] : [] }) } })
  let res = response()
  await handle(req('POST', '/', message, { authorization: 'Bearer invalid' }), res)
  assert.equal(res.status, 401)
  res = response(); await handle(req('POST', '/', message, { authorization: 'Bearer ' + token }), res)
  assert.equal(res.status, 403)
  allowed = true; res = response(); await handle(req('POST', '/', message, { authorization: 'Bearer ' + token }), res)
  assert.equal(res.status, 202)
  const kind = makeSource(() => ctx)
  const outbound = { id: 'reply-1', text: 'Connected', channel: { address: { conversation: 'main' } } }
  await kind.channel.send({}, outbound); await kind.channel.send({}, outbound)
  res = response(); await handle(req('GET', '/', undefined, { authorization: 'Bearer ' + token }), res)
  assert.equal(res.body.messages.length, 2)
  assert.equal(res.body.messages[1].role, 'assistant')
})

test('host forwards only explicitly sent text and returns accepted, never claims task completed', async () => {
  const calls = []
  const handle = handler({ base: upstreamBase(), token: () => 'secret', connection,
    read: async (_base, path, options) => { calls.push({ path, options }); return { accepted: true, id: 'id' } } })
  const res = response(); await handle(req('POST', PREFIX + '/chat', message), res)
  assert.equal(res.status, 202); assert.equal(res.body.accepted, true)
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/superagent-desktop-inbox/messages')
  const denied = response(); await handle(req('POST', PREFIX + '/board', {}), denied)
  assert.equal(denied.status, 405); assert.equal(calls.length, 1)
})
