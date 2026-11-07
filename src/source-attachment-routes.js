/** DTO-only private Source attachment routes. The parent handler MUST establish
 * its private bearer, non-browser request policy and owner allowlist first.
 * Nothing here accepts an owner/root/path from the request or writes a response.
 */
import { HttpError, readJson } from './security.js'
import { AttachmentError } from './source-attachments.js'

export const SOURCE_ATTACHMENT_PREFIX = '/superagent-desktop-inbox/conversations'
export const SOURCE_ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024
export const SOURCE_ATTACHMENT_MAX_BASE64_BYTES = 4 * Math.ceil(SOURCE_ATTACHMENT_MAX_FILE_BYTES / 3)
export const SOURCE_ATTACHMENT_MAX_JSON_BYTES = SOURCE_ATTACHMENT_MAX_BASE64_BYTES + 8192
const CONVERSATION = /^[a-zA-Z0-9_-]{1,100}$/
const REQUEST = /^[a-zA-Z0-9_-]{16,100}$/
const MESSAGE = /^[a-zA-Z0-9_-]{1,128}$/
const RECEIPT = /^[a-f0-9]{64}$/

function targetOf(req) {
  const target = req?.url
  // Origin-form only. Never normalize traversal, URL authority, encoded separators
  // or duplicate slashes into a valid attachment operation.
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\x00-\x20\x7f\\#%]/.test(target)) {
    throw new HttpError(400, 'Invalid attachment request target')
  }
  const queryAt = target.indexOf('?'), path = queryAt < 0 ? target : target.slice(0, queryAt)
  if (!path.startsWith(SOURCE_ATTACHMENT_PREFIX + '/')) return undefined
  const parts = path.slice(SOURCE_ATTACHMENT_PREFIX.length + 1).split('/')
  if (parts[1] !== 'attachments') return undefined
  if (!CONVERSATION.test(parts[0])) throw new HttpError(400, 'Invalid conversation identity')
  if (parts.length > 3 || (parts.length === 3 && !parts[2])) throw new HttpError(404, 'Unknown attachment operation')
  if (parts.length === 3 && !RECEIPT.test(parts[2])) throw new HttpError(400, 'Invalid attachment receipt')
  return { conversationId: parts[0], receipt: parts[2], query: queryAt < 0 ? undefined : target.slice(queryAt + 1) }
}
function downloadScope(query) {
  if (typeof query !== 'string') throw new HttpError(400, 'Attachment requestId and messageId are required')
  const pairs = query.split('&')
  if (pairs.length !== 2 || pairs.some(pair => !/^(requestId|messageId)=[a-zA-Z0-9_-]+$/.test(pair))) throw new HttpError(400, 'Unsupported attachment query')
  const values = Object.fromEntries(pairs.map(pair => pair.split('=')))
  if (Object.keys(values).length !== 2 || !REQUEST.test(values.requestId ?? '') || !MESSAGE.test(values.messageId ?? '')) throw new HttpError(400, 'Invalid attachment request or message identity')
  return values
}
function decodeUpload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
      Object.keys(value).some(key => !['requestId', 'name', 'mediaType', 'data'].includes(key)) ||
      typeof value.requestId !== 'string' || !REQUEST.test(value.requestId) || typeof value.name !== 'string' ||
      typeof value.mediaType !== 'string' || typeof value.data !== 'string') throw new HttpError(400, 'Expected requestId, name, mediaType and canonical base64 data only')
  const data = value.data
  if (data.length > SOURCE_ATTACHMENT_MAX_BASE64_BYTES) throw new HttpError(413, 'Attachment exceeds the 20 MiB file limit')
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  if (data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data) || data.indexOf('=') !== (padding ? data.length - padding : -1)) throw new HttpError(400, 'Attachment data must be canonical base64')
  if (data.length / 4 * 3 - padding > SOURCE_ATTACHMENT_MAX_FILE_BYTES) throw new HttpError(413, 'Attachment exceeds the 20 MiB file limit')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw new HttpError(400, 'Attachment data must be canonical base64')
  return { requestId: value.requestId, name: value.name, mediaType: value.mediaType, bytes }
}

/**
 * @returns {Promise<undefined|{status:number,body:object}>} undefined for another
 * conversation operation; attachment errors become the existing safe HttpError.
 * POST /:cid/attachments -> {attachment}; GET /:cid/attachments/:receipt with
 * exact requestId/messageId -> {attachment,data}. GET never exposes a draft or path.
 */
export async function handleSourceAttachment({ store, owner }, req) {
  try {
    const target = targetOf(req)
    if (!target) return undefined
    if (!store || typeof store.upload !== 'function' || typeof store.read !== 'function' || typeof store.resolve !== 'function' ||
        typeof owner !== 'string' || !owner) throw new HttpError(503, 'Source attachment storage is unavailable')
    const { conversationId, receipt, query } = target
    if (receipt === undefined) {
      if (req.method !== 'POST') throw new HttpError(405, 'Attachment uploads require POST')
      if (query !== undefined) throw new HttpError(400, 'Attachment upload queries are not supported')
      const value = decodeUpload(await readJson(req, SOURCE_ATTACHMENT_MAX_JSON_BYTES))
      // Only expired drafts/orphans are eligible; prepared and committed inputs remain pinned.
      if (typeof store.cleanup === 'function') store.cleanup()
      const attachment = store.upload({ owner, conversationId, ...value })
      return { status: 201, body: { attachment } }
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Committed attachment reads require GET')
    const scope = { owner, conversationId, receipt, ...downloadScope(query) }
    // resolve is deliberately committed-only; read also supports private drafts,
    // so do not expose it alone as the browser/transport download capability.
    store.resolve(scope)
    const result = store.read(scope)
    if (!Buffer.isBuffer(result.bytes) || result.bytes.length > SOURCE_ATTACHMENT_MAX_FILE_BYTES) throw new HttpError(503, 'Source attachment data is unavailable')
    return { status: 200, body: { attachment: result.attachment, data: result.bytes.toString('base64') } }
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error instanceof AttachmentError) throw new HttpError(error.status, error.message)
    throw new HttpError(503, 'Source attachment storage is unavailable')
  }
}
