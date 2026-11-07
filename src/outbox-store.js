/** Private synchronous admission journal. A native receipt must never precede this durable save. */
import { createHash, randomBytes } from 'node:crypto'
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { HttpError } from './security.js'
import { validateConversationId } from './conversation-store.js'

const MAX_BYTES = 10 * 1024 * 1024
function privateDirectory(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new HttpError(503, 'Outbox requires an absolute private directory')
  const target = resolve(root), parts = relative(parse(target).root, target).split(/[\\/]/).filter(Boolean)
  let current = parse(target).root
  for (const part of parts) {
    current = join(current, part)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(503, 'Outbox directory cannot contain symbolic links')
  }
  return realpathSync(target)
}
function lossless(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || active.has(value)) throw new HttpError(503, 'Outbox state must be lossless JSON')
  if (!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new HttpError(503, 'Outbox state must be plain JSON')
  active.add(value)
  for (const child of Object.values(value)) lossless(child, active)
  active.delete(value)
}
function encode(value, conversationId) {
  if (value?.version !== 1 || value.conversationId !== conversationId || !Array.isArray(value.requests) || value.requests.length > 256) throw new HttpError(503, 'Invalid relay outbox state')
  const seen = new Set()
  for (const request of value.requests) {
    if (!request || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(request.requestId) || seen.has(request.requestId)
      || typeof request.text !== 'string' || !['queued','unknown','accepted','canceled'].includes(request.state)) throw new HttpError(503, 'Invalid relay request record')
    seen.add(request.requestId)
  }
  lossless(value)
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > MAX_BYTES) throw new HttpError(413, 'Relay outbox exceeds its private storage budget')
  return bytes
}
export function createOutboxStore({ root, conversationId }) {
  validateConversationId(conversationId)
  const directory = privateDirectory(root)
  const filename = createHash('sha256').update(conversationId).digest('hex') + '.json'
  const path = join(directory, filename)
  const check = file => {
    if (dirname(file) !== directory) throw new HttpError(503, 'Unexpected outbox path')
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new HttpError(503, 'Outbox file cannot be a symbolic link')
    if (realpathSync(directory) !== directory) throw new HttpError(503, 'Outbox directory changed')
  }
  return {
    load() {
      check(path)
      if (!existsSync(path)) return undefined
      if (lstatSync(path).size > MAX_BYTES) throw new HttpError(503, 'Relay outbox exceeds its storage budget')
      let value
      try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new HttpError(503, 'Private relay outbox is unreadable; refusing to discard pending requests') }
      encode(value, conversationId)
      return value
    },
    save(value) {
      const bytes = encode(value, conversationId)
      check(path)
      const temporary = join(directory, '.outbox-' + randomBytes(24).toString('hex'))
      let fd
      try {
        check(temporary)
        fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
        writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined
        check(path); renameSync(temporary, path)
        let dirfd
        try { dirfd = openSync(directory, 'r'); fsyncSync(dirfd) }
        catch (error) { if (process.platform !== 'win32' || !['EPERM','EISDIR','EACCES','EINVAL'].includes(error.code)) throw error }
        finally { if (dirfd !== undefined) closeSync(dirfd) }
      } finally {
        if (fd !== undefined) closeSync(fd)
        check(temporary)
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    },
  }
}
