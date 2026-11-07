import test from 'node:test'
import assert from 'node:assert/strict'
import { messageView } from '../src/source.js'
import { trusted } from '../src/index.js'

test('large Chinese histories and assistant replies remain below upstream byte ceiling', () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ id: String(i), role: 'user', text: '中'.repeat(12000), at: '2026-01-01T00:00:00Z' }))
  entries.push({ id: 'long-reply', role: 'assistant', text: '大'.repeat(2_000_000), at: '2026-01-01T00:01:00Z' })
  const value = messageView(entries)
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 513_000)
  assert.equal(value.hasMore, true)
  assert.equal(value.messages.at(-1).id, 'long-reply')
  assert.match(value.messages.at(-1).text, /truncated/)
})

test('even authenticated remote peers cannot use local desktop endpoints', () => {
  const req = { socket: { remoteAddress: '192.0.2.123' }, headers: { host: '127.0.0.1:1234', 'x-superagent-board': '1' } }
  assert.equal(trusted(req, { requestRejection: () => undefined }), false)
})
