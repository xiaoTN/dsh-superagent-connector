import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HttpError, isLoopbackRequest, json, readJson, redact, validateMessage } from './security.js'
import { boardSnapshot, requestJson, upstreamBase } from './upstream.js'
import { makeTaskboardExtension } from './taskboard.js'
import { projectAgentIdentity, validateAgentIdentity } from './identity.js'
import { createSourceTransport } from './source-transport.js'
import { createNativeHost } from './native-host.js'

export const PREFIX = '/@superagent-board/api'
export const name = 'superagent-connector'
export const inject = ['webServer', 'connection', 'taskBoard', 'agents', 'sessions', 'workspaceRegistry', 'attachments']

/** No loose-cookie/Origin fallback: authentication belongs to the actual DSH connection module. */
export function trusted(req, connection) {
  if (!isLoopbackRequest(req) || req.headers['x-superagent-board'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') return false
  if (!connection || typeof connection.requestRejection !== 'function' || connection.requestRejection(req) !== undefined) return false
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return false } catch { return false }
  }
  return true
}

export function handler({ base, token, connection, read = requestJson, nativeHost }) {
  let cache
  let cacheAt = 0
  let inFlight
  return async (req, res) => {
    try {
      if (!trusted(req, connection())) throw new HttpError(401, 'Sign in to the local DSH client to open Superagent')
      const path = new URL(req.url, 'http://localhost').pathname
      if (!['GET', 'POST', 'PUT'].includes(req.method)) throw new HttpError(405, 'Method not allowed')
      if (path === PREFIX + '/native' || path.startsWith(PREFIX + '/native/')) {
        if (!nativeHost) throw new HttpError(503, 'The native Superagent relay is unavailable')
        return await nativeHost.handle(req, res, PREFIX + '/native')
      }
      if (path === PREFIX + '/identity') {
        if (!['GET', 'PUT'].includes(req.method)) throw new HttpError(405, 'Method not allowed')
        const secret = token()
        const input = req.method === 'PUT' ? validateAgentIdentity(await readJson(req, 2048)) : undefined
        if (input && input.name.includes(secret)) throw new HttpError(400, 'Credentials cannot be an Agent name')
        const result = await read(base, '/superagent-desktop-inbox/identity', { method: req.method, token: secret, ...(input ? { body: input } : {}) })
        return json(res, 200, projectAgentIdentity(result))
      }
      if (path === PREFIX + '/board') {
        if (req.method !== 'GET') throw new HttpError(405, 'The board is read-only')
        if (!cache || Date.now() - cacheAt > 1500) {
          if (!inFlight) {
            inFlight = boardSnapshot(base, read).then(value => { cache = value; cacheAt = Date.now(); return value }).finally(() => { inFlight = undefined })
          }
          await inFlight
        }
        return json(res, 200, cache)
      }
      if (path !== PREFIX + '/chat') throw new HttpError(404, 'Not found')
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, 'Method not allowed')
      const secret = token()
      if (req.method === 'GET') {
        const result = await read(base, '/superagent-desktop-inbox/messages', { token: secret })
        if (!Array.isArray(result.messages) || result.messages.some(m => !m || typeof m.text !== 'string' || !['user', 'assistant'].includes(m.role))) {
          throw new HttpError(502, 'Unsupported Superagent inbox format')
        }
        return json(res, 200, { messages: result.messages.slice(-200).map(m => ({ id: String(m.id), role: m.role,
          text: redact(m.text), at: String(m.at), ...(m.status ? { status: String(m.status) } : {}),
          ...(Number.isSafeInteger(m.seq) && m.seq > 0 ? { seq: m.seq } : {}),
          ...(typeof m.conversationId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(m.conversationId) ? { conversationId: m.conversationId } : {}),
          ...(['request','ack','answer','attention','result','delivery','acknowledgement','reply','notice'].includes(m.kind) ? { kind: m.kind } : {}),
          ...(typeof m.ticketId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(m.ticketId) ? { ticketId: m.ticketId } : {}),
          ...(typeof m.requestId === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(m.requestId) ? { requestId: m.requestId } : {}) })), limit: 200, hasMore: result.hasMore === true })
      }
      const message = validateMessage(await readJson(req))
      const result = await read(base, '/superagent-desktop-inbox/messages', { method: 'POST', token: secret, body: message })
      if (result.accepted !== true || typeof result.id !== 'string') throw new HttpError(502, 'Superagent did not confirm message acceptance')
      return json(res, 202, { accepted: true, id: result.id, duplicate: result.duplicate === true })
    } catch (error) {
      return json(res, error instanceof HttpError ? error.status : 503,
        { error: error instanceof HttpError ? error.message : 'Superagent connection is not configured; check the private bridge token file' })
    }
  }
}

export function apply(ctx, config = {}) {
  const base = upstreamBase(config.url)
  const tokenPath = config.tokenFile ?? join(homedir(), '.dsh', 'superagent-board-token')
  const token = () => {
    const value = readFileSync(tokenPath, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Private bridge token is missing or invalid')
    return value
  }
  ctx.effect(() => ctx.taskBoard.registerExtension(makeTaskboardExtension(base, ctx.taskBoard, undefined,
    () => requestJson(base, '/superagent-desktop-inbox/identity', { token: token() }).then(projectAgentIdentity))), 'superagent: existing task-board provider')
  ctx.effect(() => {
    const nativeHost = createNativeHost(ctx, { sourceInstanceId: base.origin, outboxRoot: config.outboxRoot,
      transport: createSourceTransport({ base, token }) })
    let unregister
    try {
      const route = handler({ base, token, connection: () => ctx.get('connection'), nativeHost })
      unregister = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: route })
    } catch (error) { void nativeHost.dispose(); throw error }
    return async () => { unregister(); await nativeHost.dispose() }
  }, 'superagent: native Source conversation and authenticated ticket projection')
}
