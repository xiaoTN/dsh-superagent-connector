import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readAgentIdentity, writeAgentIdentity, validateAgentIdentity, DEFAULT_AGENT_NAME } from '../src/identity.js'
import { INBOX_PATH, IDENTITY_PATH, makeInboxHandler, makeSource, OWNER } from '../src/source.js'
import { handler, PREFIX } from '../src/index.js'
import { upstreamBase } from '../src/upstream.js'

function context() {
  const kv = new Map()
  return { state: { get: key => structuredClone(kv.get(key)), set: (key, value) => kv.set(key, structuredClone(value)) }, atomic(fn) { return fn() } }
}
const response = () => ({ status: 0, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } })
function req(method, path, body, authorized = true) {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1234',
      'x-superagent-board': '1', 'content-type': 'application/json', authorization: authorized ? 'Bearer ' + 'b'.repeat(64) : 'Bearer invalid' },
  })
}

test('independent identity defaults once and persists across new Source handlers; revision prevents overwrites', () => {
  const store = context()
  assert.equal(DEFAULT_AGENT_NAME, 'SuperAgent')
  assert.deepEqual(readAgentIdentity(store), { agent: { name: 'SuperAgent' }, revision: 0 })
  const first = writeAgentIdentity(store, { name: '研究助手 Ω', revision: 0 })
  assert.deepEqual(first, { agent: { name: '研究助手 Ω' }, revision: 1 })
  assert.deepEqual(readAgentIdentity({ state: store.state }), first)
  assert.throws(() => writeAgentIdentity(store, { name: 'stale overwrite', revision: 0 }), e => e.status === 409)
  assert.deepEqual(writeAgentIdentity(store, { name: '第二个名字', revision: 1 }), { agent: { name: '第二个名字' }, revision: 2 })
})

test('name validation refuses empty, huge, invisible/control, secrets, extra fields and invalid revisions', () => {
  for (const value of [{ name: '', revision: 0 }, { name: 'x'.repeat(81), revision: 0 }, { name: 'a\nb', revision: 0 },
    { name: 'a\u202eb', revision: 0 }, { name: 'password=hunter2', revision: 0 }, { name: 'ok', revision: -1 },
    { name: 'ok', revision: 0, actor: 'admin' }]) assert.throws(() => validateAgentIdentity(value))
  assert.deepEqual(validateAgentIdentity({ name: '  助手 <小明> 🤖  ', revision: 0 }), { name: '助手 <小明> 🤖', revision: 0 })
})

test('private identity uses real bridge auth + local allowlist and changes neither Triggers nor Feishu', async () => {
  const store = context(); let allowed = false
  const route = makeInboxHandler({ context: store, token: 'b'.repeat(64), registry: { policyPart: () => ({ allowed: allowed ? [{ id: OWNER }] : [] }) } })
  let res = response(); await route(req('GET', IDENTITY_PATH, undefined, false), res); assert.equal(res.status, 401)
  res = response(); await route(req('PUT', IDENTITY_PATH, { name: '测试实例', revision: 0 }), res); assert.equal(res.status, 403)
  allowed = true; res = response(); await route(req('PUT', IDENTITY_PATH, { name: '测试实例', revision: 0 }), res)
  assert.equal(res.status, 200); assert.equal(res.body.agent.name, '测试实例')
  res = response(); await route(req('GET', IDENTITY_PATH), res); assert.equal(res.body.agent.name, '测试实例')
  res = response(); await route(req('PUT', INBOX_PATH, { name: 'wrong route', revision: 1 }), res); assert.equal(res.status, 405)
  const source = makeSource(() => store)
  assert.match(source.facts().cli.zh, /测试实例/)
  assert.equal(JSON.stringify(source.facts()).includes('XTN'), false)
})

test('desktop identity forwards only name+revision to fixed private identity path after DSH auth', async () => {
  const calls = []
  const route = handler({ base: upstreamBase(), token: () => 'secret', connection: () => ({ requestRejection: () => undefined }),
    read: async (_base, path, options) => { calls.push({ path, options }); return { agent: { name: '自动实例名' }, revision: 3, secrets: 'must-not-pass' } },
  })
  let res = response(); await route(req('GET', PREFIX + '/identity'), res)
  assert.equal(res.status, 200); assert.deepEqual(res.body, { agent: { name: '自动实例名' }, revision: 3 })
  res = response(); await route(req('PUT', PREFIX + '/identity', { name: '下一名', revision: 3 }), res)
  assert.equal(res.status, 200)
  assert.equal(calls.at(-1).path, IDENTITY_PATH)
  assert.deepEqual(calls.at(-1).options.body, { name: '下一名', revision: 3 })
  res = response(); await route(req('PUT', PREFIX + '/identity', { name: 'x', revision: 3, environment: {} }), res)
  assert.equal(res.status, 400); assert.equal(calls.length, 2)
})
