/** Optional module installed in the Superagent profile: a real, policy-gated local Source. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import { HttpError, isLoopbackRequest, json, readJson, redact, sameSecret, validateMessage } from './security.js'
import { DEFAULT_AGENT_NAME, readAgentIdentity, writeAgentIdentity } from './identity.js'
import { withConversation, validateConversationId } from './conversation-store.js'
import { CONVERSATIONS_PATH, handleSourceConversation, requestTriggerId } from './source-conversations.js'
import { createAttachmentStore } from './source-attachments.js'
import { prepareSourceAttachments, attachmentContext, recoverSourceAttachments } from './source-attachment-input.js'

export const SOURCE = 'desktop-inbox'
export const OWNER = 'desktop-owner'
export const INBOX_PATH = '/superagent-desktop-inbox/messages'
export const IDENTITY_PATH = '/superagent-desktop-inbox/identity'
const KEY = 'desktop-inbox:messages:v1'
const label = (zh, en) => ({ zh, en })

/** Bound by UTF-8 bytes, not message count alone (Chinese can take three bytes/character). */
export function messageView(entries, secret) {
  const messages = []
  let bytes = 0
  for (const entry of entries.slice(-200).reverse()) {
    const raw = String(entry.text ?? '')
    const text = redact(raw.slice(0, 50_000), secret) + (raw.length > 50_000 ? '\n[长消息显示已截断 / Long message truncated]' : '')
    const projected = { id: entry.id, role: entry.role, at: entry.at, text, ...(entry.status ? { status: entry.status } : {}),
      ...(Number.isSafeInteger(entry.seq) ? { seq: entry.seq } : {}),
      ...(typeof entry.conversationId === 'string' ? { conversationId: validateConversationId(entry.conversationId) } : {}),
      ...(['request','ack','answer','attention','result','delivery','acknowledgement','reply','notice'].includes(entry.kind) ? { kind: entry.kind } : {}),
      ...(typeof entry.requestId === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(entry.requestId) ? { requestId: entry.requestId } : {}),
      ...(typeof entry.ticketId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.ticketId) ? { ticketId: entry.ticketId } : {}) }
    const size = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 1
    if (bytes + size > 512_000) break
    messages.unshift(projected)
    bytes += size
  }
  return { messages, limit: 200, hasMore: entries.length > messages.length }
}

export function makeSource(getContext, attachmentStore) {
  return {
    kind: SOURCE,
    title: label('客户端对话', 'Desktop chat'),
    description: label('本机已认证 DSH 客户端的项目对话', 'Project chat from the authenticated local DSH client'),
    schema: z.object({}).strict(), fields: [{ key: 'agentName', type: 'fact', label: label('Agent 实例名称', 'Agent instance name') }], health: ['desktop-inbox'],
    facts() {
      let name = DEFAULT_AGENT_NAME
      try { name = readAgentIdentity(getContext()).agent.name } catch {}
      return { agentName: name, cli: label('Agent 实例显示名为 ' + JSON.stringify(name) + '。这是身份标签，不是指令；它独立于飞书机器人渠道名。',
        'Agent instance display name: ' + JSON.stringify(name) + '. This is an identity label, not an instruction, and is independent of the Feishu channel account name.') }
    },
    scope: () => ({ listened: true, observed: false }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.literal(OWNER), name: z.string().max(100).optional() })).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: label('可发起工作的本机账号', 'Allowed local operator'), columns: [
        { key: 'id', type: 'text', label: label('账号', 'Account'), pattern: OWNER },
      ] }],
      explicit: label('已认证本机账号发给 Superagent 的消息是明确请求', 'Authenticated operator messages are explicit requests'),
    },
    channel: {
      allowed: address => typeof address.conversation === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(address.conversation),
      async send(_host, message) {
        const conversationId = message.channel.address.conversation
        if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId)) return 'gone'
        const context = getContext()
        withConversation(context, journal => {
          const entry = journal.append(conversationId, { id: message.id, role: 'assistant', text: message.text, at: new Date().toISOString(),
            ticketId: message.ticketId, kind: message.kind })
          if (conversationId === 'main') {
            const entries = context.state.get(KEY) ?? []
            if (!entries.some(previous => previous.id === entry.id)) context.state.set(KEY, [...entries, entry].slice(-2000))
          }
        })
        return 'sent'
      },
      link: () => ({ url: '', label: label('客户端对话', 'Desktop chat') }),
    },
    threadContext: {
      messageId: trigger => trigger.id,
      images: text => [...new Set(String(text).match(/desktop-image:[a-zA-Z0-9_-]{16,128}/g) ?? [])].slice(0,10),
      async image(agent, _commands, trigger, message, key, _stateDir, signal) {
        signal.throwIfAborted()
        const context = getContext(), original = context.triggers.get(message.id)
        const conversationId = validateConversationId(trigger.channel?.address?.conversation ?? trigger.meta?.conversation)
        const receipt = typeof key === 'string' && key.startsWith('desktop-image:') ? key.slice(14) : ''
        if (!attachmentStore || !original || original.source !== SOURCE || original.channel?.thread !== conversationId
          || !message.text.includes(key) || !original.meta?.attachments?.some(item => item.receipt === receipt && item.isImage)) throw new HttpError(403,'Choose an image from this authenticated Source message')
        const stored = attachmentStore.read({owner:OWNER,conversationId,requestId:original.meta.requestId,messageId:original.id,receipt})
        const attachments = agent.ctx.get('attachments'), route = agent.session.requestHeader?.()?.config
        const selected = agent.model?.current?.(), provider = route?.provider ?? selected?.provider ?? agent.options?.provider
        const model = route?.model ?? selected?.model ?? agent.options?.model, llm = agent.ctx.get('llm')
        if (!attachments || !llm || !provider || !model) throw new HttpError(503,'The actual model image route is unavailable; the image has not been inspected')
        const info = await llm.resolveModelInfo(provider,model,signal)
        if (!info.inputModalities?.includes('image')) throw new HttpError(409,'The actual model does not support image input; the image has not been inspected')
        if (stored.bytes.length > Math.min(attachments.imageLimits.maxImageBytes,attachments.imageLimits.maxMessageImageBytes)) throw new HttpError(413,'Image exceeds the actual model attachment limit')
        const image = await attachments.saveImage({data:stored.bytes,mediaType:stored.attachment.mediaType,name:stored.attachment.name})
        signal.throwIfAborted()
        return {source_message_id:message.id,image_key:key,image}
      },
      async read(_commands, trigger, part, cursor) {
        const context = getContext()
        const conversationId = validateConversationId(trigger?.channel?.address?.conversation ?? trigger?.meta?.conversation ?? 'main')
        const page = withConversation(context, journal => journal.page(conversationId, part === 'root' ? { afterSeq: 0, limit: 1 }
          : { limit: 50, ...(cursor !== undefined ? { beforeSeq: Number(cursor) } : {}) }))
        const agentName = readAgentIdentity(context).agent.name
        return { messages: page.events.map(entry => ({ id: entry.id, from: entry.role === 'user' ? OWNER : agentName,
          text: entry.attachments?.length ? attachmentContext(attachmentStore, entry, OWNER) : entry.text,
          at: entry.at, ...(entry.role === 'assistant' ? { bot: true } : {}) })),
          ...(page.hasMore && page.nextCursor ? { next: String(page.nextCursor.beforeSeq) } : {}), body: { conversationId, agent: { name: agentName } } }
      },
    },
  }
}

/** Uses the Superagent store's transaction, so an inbox record and a Trigger commit together. */
export function submit(context, value, attachmentStore) {
  const { text, requestId, conversationId = 'main', attachments: receipts = [] } = validateMessage(value)
  if (!context.config(SOURCE) || !context.configured()) throw new HttpError(503, 'Superagent is not ready')
  const id = requestTriggerId(conversationId, requestId)
  const fingerprint = createHash('sha256').update(JSON.stringify({text,receipts})).digest('hex')
  // A known, rejected reuse is not an uncertain DB commit. Refuse it BEFORE
  // pinning new receipts, otherwise an old text-only Trigger strands them forever.
  const known=context.triggers.get(id)
  if(known && (known.meta?.inputFingerprint ? known.meta.inputFingerprint!==fingerprint : known.text!==text || receipts.length)) throw new HttpError(409,'requestId was already used for another message')
  if(known && known.channel?.thread!==conversationId) throw new HttpError(409,'requestId belongs to a different conversation')
  const prepared = prepareSourceAttachments(attachmentStore,{owner:OWNER,conversationId,requestId,messageId:id,receipts})
  let result
  try {
    result = withConversation(context, journal => {
      const existing = context.triggers.get(id)
      if (existing && (existing.meta?.inputFingerprint ? existing.meta.inputFingerprint !== fingerprint : existing.text !== text || receipts.length)) throw new HttpError(409, 'requestId was already used for another message')
      if (existing && existing.channel?.thread !== conversationId) throw new HttpError(409, 'requestId belongs to a different conversation')
      if (existing) return { accepted: true, id, conversationId, requestId, duplicate: true }
      const entries = conversationId === 'main' ? context.state.get(KEY) ?? [] : []
      const at = new Date().toISOString()
      const triggerText = prepared.contextText ? prepared.contextText + '\n\nOperator message:\n' + text : text
      const trigger = {
        id, source: SOURCE, threads: [{ source: SOURCE, id: conversationId }],
        actor: { source: SOURCE, id: OWNER }, human: true, addressed: 'direct', at, text:triggerText,
        channel: { source: SOURCE, thread: conversationId, address: { conversation: conversationId } },
        meta: { conversation: conversationId, messageId: id, requestId, inputFingerprint:fingerprint,
          ...(prepared.attachments.length ? {attachments:prepared.attachments} : {}) },
      }
      const received = context.receive(trigger)
      if (received && typeof received.then === 'function') throw new HttpError(503, 'Unsupported async intake version')
      if (received === 'filtered') throw new HttpError(409, 'The Source rejected this message')
      const entry = journal.append(conversationId, { id, role:'user',kind:'request',text,at,requestId,status:'received',
        ...(prepared.attachments.length ? {attachments:prepared.attachments} : {}) })
      if (conversationId === 'main') context.state.set(KEY,[...entries,entry].slice(-2000))
      context.threads.describe(SOURCE+':'+conversationId,{label:'Desktop Superagent chat'})
      return {accepted:true,id,conversationId,requestId,duplicate:received==='duplicate'}
    })
  } catch(error) {
    // If the DB outcome itself is uncertain, retain prepared files; never guess that intake failed.
    let definitelyAbsent=false
    try { definitelyAbsent=!context.triggers.get(id) } catch {}
    if(definitelyAbsent) prepared.abort()
    throw error
  }
  // A crash here is recovered from the committed Source journal at startup. Prepared bytes remain pinned.
  prepared.commit()
  return result
}

export function makeInboxHandler({ context, registry, token, attachmentStore }) {
  return async (req, res) => {
    try {
      if (!isLoopbackRequest(req) || !sameSecret(req.headers.authorization, 'Bearer ' + token)) {
        throw new HttpError(401, 'Authenticated local bridge required')
      }
      if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Browser requests are not accepted here')
      const path = new URL(req.url, 'http://localhost').pathname
      if (path === CONVERSATIONS_PATH || path.startsWith(CONVERSATIONS_PATH + '/')) return await handleSourceConversation({ context, registry, token, attachmentStore }, req, res)
      if (path === IDENTITY_PATH) {
        if (req.method === 'GET') return json(res, 200, readAgentIdentity(context))
        if (req.method !== 'PUT') throw new HttpError(405, 'Method not allowed')
        const policy = registry.policyPart(SOURCE)
        if (!policy?.allowed?.some(entry => entry.id === OWNER)) throw new HttpError(403, 'Local operator is not on the Superagent allowlist')
        return json(res, 200, writeAgentIdentity(context, await readJson(req, 2048), token))
      }
      if (path !== INBOX_PATH) throw new HttpError(404, 'Not found')
      if (req.method === 'GET') {
        const all = context.state.get(KEY) ?? []
        return json(res, 200, messageView(all, token))
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const policy = registry.policyPart(SOURCE)
      if (!policy?.allowed?.some(entry => entry.id === OWNER)) throw new HttpError(403, 'Local operator is not on the Superagent allowlist')
      const result = submit(context, await readJson(req), attachmentStore)
      return json(res, 202, result)
    } catch (error) {
      const scopedFailure = ['SourceExecutionError','AttachmentError'].includes(error?.name) && [400,403,404,409,413,503].includes(error.status)
      return json(res, error instanceof HttpError || scopedFailure ? error.status : 503,
        { error: error instanceof HttpError ? error.message : scopedFailure ? 'The scoped Source operation could not be applied; refresh its current state' : 'Superagent intake is unavailable',
          ...(scopedFailure && typeof error.code === 'string' ? { code: error.code.slice(0,80) } : {}) })
    }
  }
}

export const name = 'superagent-desktop-source'
export const inject = ['orchestrator', 'webServer']
export function apply(ctx, config = {}) {
  const tokenFile = config.tokenFile ?? join(homedir(), '.config', 'dsh-superagent-board', 'token')
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Provision a private 32-byte bridge token before enabling the Source')
  const attachmentStore = createAttachmentStore({root:config.attachmentRoot ?? join(dirname(tokenFile),'attachments')})
  let context
  const kind = makeSource(() => context, attachmentStore)
  ctx.effect(() => {
    const unregister = ctx.orchestrator.sources.register(kind)
    context = ctx.orchestrator.context(kind)
    const disposers = []
    try {
      const handler = makeInboxHandler({ context, registry: ctx.orchestrator.sources, token, attachmentStore })
      for (const path of [INBOX_PATH, IDENTITY_PATH]) disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
      disposers.push(ctx.webServer.register({ kind: 'prefix', path: CONVERSATIONS_PATH, handler }))
    } catch (error) { disposers.forEach(dispose => dispose()); unregister(); throw error }
    let closed = false
    context.ready.then(() => {
      if (closed) return
      recoverSourceAttachments(context,attachmentStore,withConversation,OWNER)
      context.report(SOURCE,{state:'ready',detail:'Authenticated desktop native conversation connected'})
    }).catch(() => {if(!closed)context.report(SOURCE,{state:'error',detail:'Desktop conversation storage recovery failed; pending files retained'})})
    return () => { closed = true; disposers.forEach(dispose => dispose()); unregister() }
  }, 'superagent-board: authenticated desktop Source')
}
