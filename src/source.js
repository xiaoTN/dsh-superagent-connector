/** Optional module installed in the Superagent profile: a real, policy-gated local Source. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { HttpError, isLoopbackRequest, json, readJson, redact, sameSecret, validateMessage } from './security.js'

export const SOURCE = 'desktop-inbox'
export const OWNER = 'desktop-owner'
export const INBOX_PATH = '/superagent-desktop-inbox/messages'
const KEY = 'desktop-inbox:messages:v1'
const label = (zh, en) => ({ zh, en })

/** Bound by UTF-8 bytes, not message count alone (Chinese can take three bytes/character). */
export function messageView(entries, secret) {
  const messages = []
  let bytes = 0
  for (const entry of entries.slice(-200).reverse()) {
    const raw = String(entry.text ?? '')
    const text = redact(raw.slice(0, 50_000), secret) + (raw.length > 50_000 ? '\n[长消息显示已截断 / Long message truncated]' : '')
    const projected = { id: entry.id, role: entry.role, at: entry.at, text, ...(entry.status ? { status: entry.status } : {}) }
    const size = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 1
    if (bytes + size > 512_000) break
    messages.unshift(projected)
    bytes += size
  }
  return { messages, limit: 200, hasMore: entries.length > messages.length }
}
const digest = (id) => createHash('sha256').update(SOURCE + ':' + id).digest('hex').slice(0, 32)

export function makeSource(getContext) {
  return {
    kind: SOURCE,
    title: label('客户端对话', 'Desktop chat'),
    description: label('本机已认证 DSH 客户端的项目对话', 'Project chat from the authenticated local DSH client'),
    schema: z.object({}).strict(), fields: [], health: ['desktop-inbox'],
    scope: () => ({ listened: true, observed: false }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.literal(OWNER), name: z.string().max(100).optional() })).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: label('可发起工作的本机账号', 'Allowed local operator'), columns: [
        { key: 'id', type: 'text', label: label('账号', 'Account'), pattern: OWNER },
      ] }],
      explicit: label('已认证本机账号发给 Superagent 的消息是明确请求', 'Authenticated operator messages are explicit requests'),
    },
    channel: {
      allowed: address => address.conversation === 'main',
      async send(_host, message) {
        if (message.channel.address.conversation !== 'main') return 'gone'
        const context = getContext()
        context.atomic(() => {
          const entries = context.state.get(KEY) ?? []
          if (entries.some(entry => entry.id === message.id)) return
          entries.push({ id: message.id, role: 'assistant', text: message.text, at: new Date().toISOString(), ticketId: message.ticketId })
          context.state.set(KEY, entries.slice(-2000))
        })
        return 'sent'
      },
      link: () => ({ url: '', label: label('客户端对话', 'Desktop chat') }),
    },
    threadContext: {
      messageId: trigger => trigger.id,
      async read(_commands, _trigger, _part, _cursor) {
        const entries = getContext().state.get(KEY) ?? []
        return { messages: entries.slice(-50).map(entry => ({ id: entry.id, from: entry.role === 'user' ? OWNER : 'Superagent',
          text: entry.text, at: entry.at, ...(entry.role === 'assistant' ? { bot: true } : {}) })), body: {} }
      },
    },
  }
}

/** Uses the Superagent store's transaction, so an inbox record and a Trigger commit together. */
export function submit(context, value) {
  const { text, requestId } = validateMessage(value)
  if (!context.config(SOURCE) || !context.configured()) throw new HttpError(503, 'Superagent is not ready')
  return context.atomic(() => {
    const id = digest(requestId)
    const existing = context.triggers.get(id)
    if (existing && existing.text !== text) throw new HttpError(409, 'requestId was already used for another message')
    if (existing) return { accepted: true, id, duplicate: true }
    const entries = context.state.get(KEY) ?? []
    const at = new Date().toISOString()
    const trigger = {
      id, source: SOURCE, threads: [{ source: SOURCE, id: 'main' }],
      actor: { source: SOURCE, id: OWNER }, human: true, addressed: 'direct', at, text,
      channel: { source: SOURCE, thread: 'main', address: { conversation: 'main' } },
      meta: { conversation: 'main', messageId: id },
    }
    const result = context.receive(trigger)
    if (result && typeof result.then === 'function') throw new HttpError(503, 'Unsupported async intake version')
    if (result === 'filtered') throw new HttpError(409, 'The Source rejected this message')
    entries.push({ id, role: 'user', text, at, status: 'received' })
    context.state.set(KEY, entries.slice(-2000))
    context.threads.describe(SOURCE + ':main', { label: 'Desktop Superagent chat' })
    return { accepted: true, id, duplicate: result === 'duplicate' }
  })
}

export function makeInboxHandler({ context, registry, token }) {
  return async (req, res) => {
    try {
      if (!isLoopbackRequest(req) || !sameSecret(req.headers.authorization, 'Bearer ' + token)) {
        throw new HttpError(401, 'Authenticated local bridge required')
      }
      if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Browser requests are not accepted here')
      if (req.method === 'GET') {
        const all = context.state.get(KEY) ?? []
        return json(res, 200, messageView(all, token))
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const policy = registry.policyPart(SOURCE)
      if (!policy?.allowed?.some(entry => entry.id === OWNER)) throw new HttpError(403, 'Local operator is not on the Superagent allowlist')
      const result = submit(context, await readJson(req))
      return json(res, 202, result)
    } catch (error) {
      return json(res, error instanceof HttpError ? error.status : 503,
        { error: error instanceof HttpError ? error.message : 'Superagent intake is unavailable' })
    }
  }
}

export const name = 'superagent-desktop-source'
export const inject = ['orchestrator', 'webServer']
export function apply(ctx, config = {}) {
  const tokenFile = config.tokenFile ?? join(homedir(), '.config', 'dsh-superagent-board', 'token')
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Provision a private 32-byte bridge token before enabling the Source')
  let context
  const kind = makeSource(() => context)
  ctx.effect(() => {
    const unregister = ctx.orchestrator.sources.register(kind)
    context = ctx.orchestrator.context(kind)
    let dispose
    try {
      dispose = ctx.webServer.register({ kind: 'exact', path: INBOX_PATH,
        handler: makeInboxHandler({ context, registry: ctx.orchestrator.sources, token }) })
    } catch (error) { unregister(); throw error }
    let closed = false
    context.ready.then(() => { if (!closed) context.report(SOURCE, { state: 'ready', detail: 'Authenticated desktop chat connected' }) }).catch(() => {})
    return () => { closed = true; dispose(); unregister() }
  }, 'superagent-board: authenticated desktop Source')
}
