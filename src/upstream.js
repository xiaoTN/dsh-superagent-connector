import { request } from 'node:http'
import { HttpError, redact, safeLink } from './security.js'

export function upstreamBase(raw = 'http://127.0.0.1:3082') {
  let u
  try { u = new URL(raw) } catch { throw new Error('Superagent URL must be a loopback HTTP origin') }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new Error('Superagent URL must be http://127.0.0.1:<port> with no path, query, or credentials')
  }
  return u
}

export function isScopedSourceRoute(path, method) {
  if (typeof path !== 'string' || path.length > 1024 || path.includes('#')) return false
  const [pathname, search = ''] = path.split('?')
  if (path.split('?').length > 2) return false
  const root = '/superagent-desktop-inbox/conversations'
  if (method === 'GET' && [root, root + '/capabilities'].includes(pathname)) return !search
  const attachment = pathname.match(/^\/superagent-desktop-inbox\/conversations\/[a-zA-Z0-9_-]{1,100}\/attachments(?:\/([a-zA-Z0-9_-]{16,128}))?$/)
  if (attachment) {
    if (method === 'POST') return !attachment[1] && !search
    if (method !== 'GET' || !attachment[1]) return false
    const query = new URLSearchParams(search)
    return [...query.keys()].every(key => ['requestId','messageId'].includes(key) && query.getAll(key).length === 1)
      && /^[a-zA-Z0-9_-]{16,100}$/.test(query.get('requestId') ?? '') && /^[a-zA-Z0-9_-]{1,128}$/.test(query.get('messageId') ?? '')
  }
  const match = pathname.match(/^\/superagent-desktop-inbox\/conversations\/([a-zA-Z0-9_-]{1,100})\/(events|receipt\/([a-zA-Z0-9_-]{16,100})|executions\/([a-zA-Z0-9_-]{1,128})(?:\/(interrupt|resume))?)$/)
  if (!match) return false
  if (method === 'POST') return !!match[5] && !search
  if (method !== 'GET' || match[5]) return false
  const allowed = match[2] === 'events' ? ['afterSeq','beforeSeq','limit'] : match[3] ? [] : ['throughSeq','beforeSeq','limit']
  const query = new URLSearchParams(search)
  for (const [key,value] of query) if (!allowed.includes(key) || query.getAll(key).length !== 1 || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) return false
  return true
}

/** Node HTTP pins the physical loopback target and ignores proxy environment variables. Never follows redirects. */
export function requestJson(base, path, { method = 'GET', body, token, timeout = 6000, maxBytes = 2_097_152, signal } = {}) {
  const scoped = isScopedSourceRoute(path, method)
  if (!scoped && !/^\/(?:orchestrator\/api\/(?:state|tickets)(?:\?[^#]*)?|superagent-desktop-inbox\/(?:messages|identity))$/.test(path)) {
    return Promise.reject(new HttpError(400, 'Unsupported upstream route'))
  }
  if (!(scoped || method === 'GET' || (method === 'POST' && path === '/superagent-desktop-inbox/messages')
    || (method === 'PUT' && path === '/superagent-desktop-inbox/identity'))) {
    return Promise.reject(new HttpError(405, 'Unsupported upstream method'))
  }
  if (signal?.aborted) return Promise.reject(new HttpError(504, 'Superagent request timed out'))
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = request({ hostname: base.hostname, port: base.port || 80, path, method,
      headers: { 'accept': 'application/json', 'accept-encoding': 'identity', 'x-orchestrator-request': '1',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy()
        const status = res.statusCode === 401 || res.statusCode === 403 ? 403
          : [400,404,409,413].includes(res.statusCode) && (scoped || path.includes('/identity')) ? res.statusCode
          : res.statusCode === 409 ? 409 : 503
        reject(new HttpError(status, res.statusCode === 403 ? 'Superagent denied the local operator; check Source enrollment' : 'Superagent endpoint is unavailable; check connection and Source setup'))
        return
      }
      let size = 0
      const chunks = []
      res.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) { req.destroy(); reject(new HttpError(502, 'Superagent response exceeded the size limit')); return }
        chunks.push(chunk)
      })
      res.on('error', () => reject(new HttpError(503, 'Superagent response was interrupted')))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new HttpError(502, 'Unsupported Superagent response')) }
      })
    })
    req.on('error', () => reject(new HttpError(503, 'Cannot reach the configured local Superagent')))
    const timer = setTimeout(() => { req.destroy(); reject(new HttpError(504, 'Superagent request timed out')) }, timeout)
    const abort = () => { reject(new HttpError(504, 'Superagent request timed out')); req.destroy() }
    signal?.addEventListener('abort', abort, { once: true })
    req.once('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) })
    if (bytes) req.write(bytes)
    req.end()
  })
}

const scalar = (value, max = 20_000) => redact(typeof value === 'string' ? value.slice(0, max) : '')
const validTicket = t => t && typeof t.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(t.id) && typeof t.title === 'string' && typeof t.stage === 'string'
export function projectTicket(t) {
  return { id: t.id, title: scalar(t.title, 1000), state: scalar(t.state, 32), stage: scalar(t.stage, 32),
    action: scalar(t.action, 32), updatedAt: scalar(t.updatedAt, 64), summary: scalar(t.summary),
    outcome: scalar(t.ended?.outcome, 32),
    threads: Array.isArray(t.threads) ? t.threads.flatMap(thread => { const url = safeLink(thread.url); return url ? [{ url, title: scalar(thread.title, 300) }] : [] }) : [] }
}

export async function boardSnapshot(base, read = requestJson) {
  const signal = AbortSignal.timeout(12_000)
  const get = path => {
    if (signal.aborted) throw new HttpError(504, 'Superagent board read timed out')
    return read(base, path, { signal })
  }
  const state = await get('/orchestrator/api/state')
  if (!state?.health || !state?.load) throw new HttpError(502, 'Unsupported Superagent state format')
  const items = new Map()
  let truncated = false
  for (const filter of ['open', 'ended']) {
    let offset = 0
    for (let page = 0; page < 10; page++) {
      const result = await get(`/orchestrator/api/tickets?state=${filter}&offset=${offset}&limit=100`)
      if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.items.some(t => !validTicket(t))) {
        throw new HttpError(502, 'Unsupported Superagent ticket format')
      }
      for (const ticket of result.items) items.set(ticket.id, projectTicket(ticket))
      if (result.next_offset === null) break
      if (!Number.isSafeInteger(result.next_offset) || result.next_offset <= offset) throw new HttpError(502, 'Unsupported Superagent pagination')
      offset = result.next_offset
      if (page === 9) truncated = true
    }
  }
  const health = state.health
  return { state: { runtime: scalar(health.runtime?.state, 32), feishu: scalar(health.feishu?.state, 32),
    github: scalar(health.github?.state, 32), local: scalar(health['desktop-inbox']?.state, 32),
    running: Number.isSafeInteger(state.load.running) ? state.load.running : 0,
    queued: Number.isSafeInteger(state.load.queued) ? state.load.queued : 0, paused: state.paused === true },
    items: [...items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), total: items.size,
    truncated, live: true, fetchedAt: new Date().toISOString() }
}
