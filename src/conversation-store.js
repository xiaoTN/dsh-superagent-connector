/** Durable Source observations. These are deliveries, never fabricated model/step events.
 * The single transaction seam deliberately includes Source.receive() in the caller callback. */
import { createHash } from 'node:crypto'
import { HttpError } from './security.js'
export const LEGACY_MESSAGES_KEY = 'desktop-inbox:messages:v1'
const PREFIX = 'desktop-inbox:conversation:v1:'
const MIGRATED = PREFIX + 'legacy-migrated'
const CATALOG = PREFIX + 'catalog'
const kinds = new Set(['request', 'ack', 'answer', 'attention', 'result', 'delivery', 'acknowledgement', 'reply', 'notice'])

export function validateConversationId(value = 'main') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new HttpError(400, 'Invalid conversation identity')
  return value
}
const headKey = id => PREFIX + id + ':head'
const eventKey = (id, seq) => PREFIX + id + ':event:' + seq
const seenKey = (id, key) => PREFIX + id + ':seen:' + createHash('sha256').update(key).digest('hex')
const head = (state, id) => state.get(headKey(id)) ?? { newestSeq: 0, createdAt: null, updatedAt: null }

function normalized(entry, conversationId, seq) {
  if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 256 || !['user','assistant'].includes(entry.role)
    || typeof entry.text !== 'string' || entry.text.length > 500000 || typeof entry.at !== 'string' || entry.at.length > 80) {
    throw new HttpError(502, 'Unsupported Source delivery')
  }
  return { seq, id: entry.id, role: entry.role, conversationId, text: entry.text, at: entry.at,
    kind: kinds.has(entry.kind) ? entry.kind : entry.role === 'user' ? 'request' : 'delivery',
    ...(entry.role === 'user' ? { textDigest: createHash('sha256').update(entry.text).digest('hex') } : {}),
    ...(typeof entry.status === 'string' ? { status: entry.status.slice(0, 32) } : {}),
    ...(typeof entry.requestId === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(entry.requestId) ? { requestId: entry.requestId } : {}),
    ...(typeof entry.ticketId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.ticketId) ? { ticketId: entry.ticketId } : {}),
    ...(Array.isArray(entry.attachments) ? { attachments: structuredClone(entry.attachments) } : {}) }
}
function append(state, conversationId, entry) {
  validateConversationId(conversationId)
  if (typeof entry?.id !== 'string') throw new HttpError(502, 'Source delivery identity is missing')
  const seen = state.get(seenKey(conversationId, entry.id))
  if (seen !== undefined) return state.get(eventKey(conversationId, seen))
  const current = head(state, conversationId)
  if (!Number.isSafeInteger(current.newestSeq) || current.newestSeq < 0 || current.newestSeq === Number.MAX_SAFE_INTEGER) throw new HttpError(503, 'Conversation sequence is unavailable')
  const value = normalized(entry, conversationId, current.newestSeq + 1)
  state.set(eventKey(conversationId, value.seq), value)
  state.set(seenKey(conversationId, entry.id), value.seq)
  state.set(headKey(conversationId), { newestSeq: value.seq, createdAt: current.createdAt ?? value.at, updatedAt: value.at })
  if (!current.newestSeq) {
    const ids = state.get(CATALOG) ?? []
    if (!ids.includes(conversationId)) state.set(CATALOG, [...ids, conversationId])
  }
  return value
}
function migrate(state) {
  if (state.get(MIGRATED) === true) return
  const legacy = state.get(LEGACY_MESSAGES_KEY) ?? []
  if (!Array.isArray(legacy)) throw new HttpError(503, 'Legacy inbox is unavailable')
  for (const entry of legacy) append(state, entry.conversationId ?? 'main', entry)
  state.set(MIGRATED, true)
}
function cursor(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'Invalid ' + name + ' cursor')
  return value
}
function page(state, conversationId, options = {}) {
  validateConversationId(conversationId)
  if (options.afterSeq !== undefined && options.beforeSeq !== undefined) throw new HttpError(400, 'Choose one paging direction')
  const limit = options.limit ?? 200
  const maxBytes = options.maxBytes ?? 512000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 512000) throw new HttpError(400, 'Invalid conversation page limits')
  const current = head(state, conversationId)
  const forward = options.afterSeq !== undefined
  const start = forward ? cursor(options.afterSeq, 'after') + 1 : Math.min(cursor(options.beforeSeq ?? current.newestSeq + 1, 'before') - 1, current.newestSeq)
  const events = []; let bytes = 0, truncated = false
  for (let seq = start; seq >= 1 && seq <= current.newestSeq && events.length < limit; seq += forward ? 1 : -1) {
    const stored = state.get(eventKey(conversationId, seq))
    if (!stored) throw new HttpError(503, 'Conversation history has a missing event')
    let event = stored, size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
    if (size > maxBytes && events.length === 0) {
      let text = event.text
      while (Buffer.byteLength(JSON.stringify({ ...event, text }), 'utf8') + 1 > maxBytes) {
        if (!text.length) throw new HttpError(502, 'Source delivery metadata exceeded the page budget')
        text = text.slice(0, Math.floor(text.length * 0.75))
      }
      event = { ...event, text, truncated: true }; size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1; truncated = true
    }
    if (bytes + size > maxBytes) break
    events.push(event); bytes += size
  }
  if (!forward) events.reverse()
  const oldestReturned = events[0]?.seq, newestReturned = events.at(-1)?.seq
  const hasMore = events.length > 0 && (forward ? newestReturned < current.newestSeq : oldestReturned > 1)
  return { version: 1, conversationId, events, oldestSeq: current.newestSeq ? 1 : 0, newestSeq: current.newestSeq,
    cursor: { afterSeq: newestReturned ?? (forward ? options.afterSeq : current.newestSeq) },
    ...(oldestReturned > 1 ? { nextCursor: { beforeSeq: oldestReturned } } : {}), hasMore, truncated }
}

/** Callback, migration, message append and real Trigger intake commit or roll back together. */
export function withConversation(context, operation) {
  return context.atomic(() => {
    migrate(context.state)
    return operation({
      append: (conversationId, entry) => append(context.state, conversationId, entry),
      page: (conversationId = 'main', options) => page(context.state, conversationId, options),
      list: () => (context.state.get(CATALOG) ?? []).map(id => ({ conversationId: id, ...head(context.state, id) })),
    })
  })
}
