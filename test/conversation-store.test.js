import test from 'node:test'
import assert from 'node:assert/strict'
import { withConversation, validateConversationId, LEGACY_MESSAGES_KEY } from '../src/conversation-store.js'

function context() {
  const values = new Map()
  return { state: { get: key => structuredClone(values.get(key)), set: (key, value) => values.set(key, structuredClone(value)) },
    atomic(fn) { const before = structuredClone(values); try { return fn() } catch(error) { values.clear(); before.forEach((v,k) => values.set(k,v)); throw error } }, values }
}
const entry = (id, text = id) => ({ id, role: 'user', text, at: '2026-11-07T20:00:00.000Z', requestId: 'request-0000000001' })

test('durable Source journal preserves monotonic ordered identity, conversation isolation and idempotence', () => {
  const ctx = context()
  withConversation(ctx, journal => {
    assert.equal(journal.append('one', entry('one')).seq, 1)
    assert.equal(journal.append('one', entry('two')).seq, 2)
    assert.equal(journal.append('one', entry('one')).seq, 1)
    assert.equal(journal.append('two', entry('other')).seq, 1)
  })
  const result = withConversation({ ...ctx }, journal => journal.page('one', { afterSeq: 0, limit: 1 }))
  assert.deepEqual(result.events.map(e => e.id), ['one']); assert.equal(result.hasMore, true)
  const next = withConversation(ctx, journal => journal.page('one', { afterSeq: 1, limit: 10 }))
  assert.deepEqual(next.events.map(e => e.id), ['two']); assert.equal(next.events[0].requestId, 'request-0000000001')
  assert.equal(next.newestSeq, 2)
})

test('legacy main history migrates once without reclassifying old deliveries as model events', () => {
  const ctx = context()
  ctx.state.set(LEGACY_MESSAGES_KEY, [entry('old-user'), { id: 'old-reply', role: 'assistant', text: 'actual delivery', at: '2026-11-07T20:01:00Z', ticketId: 'real-ticket' }])
  const result = withConversation(ctx, journal => journal.page('main', { afterSeq: 0 }))
  assert.equal(result.events.length, 2); assert.equal(result.events[1].ticketId, 'real-ticket')
  assert.equal(result.events[1].kind, 'delivery')
  assert.equal(result.events[0].kind, 'request')
  withConversation(ctx, journal => journal.append('main', { id: 'ack', role: 'assistant', text: 'ack', at: '2026-11-07T20:02:00Z', kind: 'ack' }))
  assert.equal(withConversation(ctx, journal => journal.page('main', { afterSeq: 0 })).events.length, 3)
})

test('journal appends share Source intake transactions and roll back cursor/dedupe on failure', () => {
  const ctx = context()
  assert.throws(() => withConversation(ctx, journal => { journal.append('main', entry('new')); throw Error('intake failed') }))
  assert.equal(withConversation(ctx, journal => journal.page('main', { afterSeq: 0 })).events.length, 0)
  assert.equal(withConversation(ctx, journal => journal.append('main', entry('new'))).seq, 1)
})

test('backward pagination keeps order, byte budgets and complete cursor identity', () => {
  const ctx = context()
  withConversation(ctx, journal => { for (let n=1;n<=5;n++) journal.append('main', entry('id-'+n, '中'.repeat(40000))) })
  const page = withConversation(ctx, journal => journal.page('main', { beforeSeq: 6, limit: 2 }))
  assert.deepEqual(page.events.map(e => e.seq), [4,5]); assert.equal(page.hasMore, true)
  const bounded = withConversation(ctx, journal => journal.page('main', { afterSeq: 0, limit: 100, maxBytes: 150000 }))
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 151000)
  assert.equal(bounded.events[0].seq, 1); assert.equal(bounded.hasMore, true)
  assert.throws(() => withConversation(ctx, journal => journal.page('main', { beforeSeq: 3, afterSeq: 0 })))
})

test('conversation/cursor validation never accepts paths, URLs, controls or unsafe numbers', () => {
  for (const id of ['../other', 'http://example.com', 'one:two', '', 'a\nb']) assert.throws(() => validateConversationId(id))
  assert.equal(validateConversationId(undefined), 'main')
  const ctx=context()
  for (const afterSeq of [-1, 1.2, Infinity, Number.MAX_SAFE_INTEGER+1]) assert.throws(() => withConversation(ctx, j => j.page('main',{afterSeq})))
})
