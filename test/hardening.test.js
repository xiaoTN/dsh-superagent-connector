import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { redact, readJson, safeLink } from '../src/security.js'
import { requestJson, upstreamBase } from '../src/upstream.js'
import { messageView } from '../src/source.js'

test('JSON output masks common credentials and the exact local bridge secret', () => {
  const secret = 'c'.repeat(64)
  const input = `Authorization: Bearer example-session-secret token=hello secret=world password=hunter2 "appSecret":"with spaces" ${secret}`
  const out = messageView([{ id: 'a', role: 'assistant', text: input, at: 'now' }], secret)
  const json = JSON.stringify(out)
  for (const value of ['example-session-secret', 'hello', 'world', 'hunter2', 'with spaces', secret]) assert.equal(json.includes(value), false)
  assert.match(redact('Bearer abcdef'), /REDACTED/)
  assert.equal(safeLink('https://github.com/a/b/pull/1#access_token=sensitive'), 'https://github.com/a/b/pull/1')
})

test('valid long Chinese input fits the request byte ceiling', async () => {
  const input = { text: '中'.repeat(12000), requestId: 'd'.repeat(36) }
  const req = Readable.from([Buffer.from(JSON.stringify(input))]); req.headers = { 'content-type': 'application/json' }
  assert.deepEqual(await readJson(req), input)
})

test('slow request bodies have a deadline', async () => {
  const req = new Readable({ read() {} }); req.headers = { 'content-type': 'application/json' }
  await assert.rejects(readJson(req, 65536, 20), /timed out/)
  assert.equal(req.destroyed, true)
})

test('oversized request bodies are rejected', async () => {
  const req = Readable.from([Buffer.alloc(65537)]); req.headers = { 'content-type': 'application/json' }
  await assert.rejects(readJson(req), /too large/)
})

test('upstream abort and byte limits are enforced and write routes are narrow', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/orchestrator/api/state') res.end('x'.repeat(500))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const base = upstreamBase('http://127.0.0.1:' + server.address().port)
    await assert.rejects(requestJson(base, '/orchestrator/api/state', { maxBytes: 100 }), /size limit/)
    await assert.rejects(requestJson(base, '/orchestrator/api/tickets', { signal: AbortSignal.timeout(20) }), /timed out/)
    await assert.rejects(requestJson(base, '/orchestrator/api/state', { method: 'POST' }), /method/)
  } finally { server.closeAllConnections(); server.close() }
})
