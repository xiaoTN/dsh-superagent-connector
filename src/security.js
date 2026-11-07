import { timingSafeEqual } from 'node:crypto'

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

export async function readJson(req, limit = 65_536, timeoutMs = 10_000) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Expected application/json')
  }
  let timer
  const consume = async () => {
    let bytes = 0
    const chunks = []
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > limit) throw new HttpError(413, 'Message is too large')
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new HttpError(400, 'Invalid JSON') }
  }
  try {
    return await Promise.race([consume(), new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new HttpError(408, 'Message upload timed out')); req.destroy() }, timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

export function sameSecret(candidate, expected) {
  if (typeof candidate !== 'string' || !expected) return false
  const a = Buffer.from(candidate), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function validateMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['text', 'requestId', 'conversationId', 'attachments'].includes(k))) {
    throw new HttpError(400, 'Expected text, requestId, optional conversationId and attachment receipts only')
  }
  const attachments = value.attachments ?? []
  if (!Array.isArray(attachments) || attachments.length > 10 || new Set(attachments).size !== attachments.length
    || attachments.some(receipt => typeof receipt !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(receipt))) throw new HttpError(400, 'Invalid Source attachment receipts')
  if (typeof value.text !== 'string' || (!value.text.trim() && !attachments.length) || value.text.length > 12_000) {
    throw new HttpError(400, 'Message must contain 1–12000 characters')
  }
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value.requestId)) {
    throw new HttpError(400, 'Invalid requestId')
  }
  if (value.conversationId !== undefined && (typeof value.conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.conversationId))) throw new HttpError(400, 'Invalid conversation identity')
  return { text: value.text.trim(), requestId: value.requestId, ...(value.conversationId !== undefined ? { conversationId: value.conversationId } : {}),
    ...(value.attachments !== undefined ? { attachments } : {}) }
}

export function redact(value, secret) {
  let text = String(value ?? '')
  if (secret) text = text.split(secret).join('<REDACTED>')
  return text
    .replace(/\bsk-[a-zA-Z0-9_-]{16,}/g, '<REDACTED>')
    .replace(/\b(?:gh[pousr]_[a-zA-Z0-9_]{20,}|github_pat_[a-zA-Z0-9_]{20,})/g, '<REDACTED>')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/gi, 'Bearer <REDACTED>')
    .replace(/((?:["']?)(?:appSecret|app_secret|access_token|refresh_token|api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, '$1<REDACTED>')
}

export function safeLink(value) {
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password
      || !['github.com', 'applink.feishu.cn', 'applink.larksuite.com'].includes(u.hostname)
      || [...u.searchParams.keys()].some(k => /token|secret|key/i.test(k))) return null
    u.hash = ''
    return u.href
  } catch { return null }
}

export function isLoopbackRequest(req) {
  const ip = req.socket?.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false
  try {
    const u = new URL('http://' + req.headers.host)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash
  } catch { return false }
}
