/** Private, synchronous attachment storage for the real Source (no HTTP or model hooks).
 *
 * prepare pins a request before Source.atomic; commit follows its successful durable
 * transaction. On restart replay commit from the Source's durable message records.
 * Prepared files deliberately never expire: filesystem and Source transactions are
 * separate, so TTL must not erase a successfully accepted message after a crash.
 * Explicit abort is safe ONLY when the caller knows Source.atomic did not commit.
 * Public metadata contains no local path; resolve is a server/worker-only interface.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const MiB = 1024 * 1024
const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 20 * MiB, maxRequestBytes: 100 * MiB, maxTotalBytes: 500 * MiB,
  maxFilesPerRequest: 10, maxTotalFiles: 1000, draftTtlMs: 24 * 60 * 60 * 1000,
})
const RECEIPT = /^[a-f0-9]{64}$/
const FILE = /^[a-f0-9]{64}\.(?:bin|png|jpg|webp|gif)$/
const TEMP = /^tmp-[a-f0-9]{64}$/
const WRITER = /^writer-([1-9][0-9]{0,9})-[a-f0-9]{64}$/
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const MAX_MANIFEST_BYTES = 4 * MiB
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const random = () => randomBytes(32).toString('hex')

export class AttachmentError extends Error {
  constructor(status, code, message) { super(message); this.name = 'AttachmentError'; this.status = status; this.code = code }
}
const fail = (status, code, message) => { throw new AttachmentError(status, code, message) }
const invalidImage = () => fail(415, 'invalid_image', 'Unsupported or malformed image data')

function scopeOf(value) {
  const scope = {}
  for (const key of ['owner', 'conversationId', 'requestId']) {
    if (typeof value?.[key] !== 'string' || !value[key].trim() || value[key].length > 256 || /[\x00-\x1f\x7f]/.test(value[key])) {
      fail(400, 'invalid_scope', 'Attachment owner, conversationId and requestId are required')
    }
    scope[key] = value[key]
  }
  return scope
}
const sameScope = (a, b) => ['owner', 'conversationId', 'requestId'].every(key => a[key] === b[key])
const scopeKey = scope => hash(JSON.stringify([scope.owner, scope.conversationId, scope.requestId]))
function messageIdOf(value) {
  if (typeof value?.messageId !== 'string' || !value.messageId.trim() || value.messageId.length > 256 || /[\x00-\x1f\x7f]/.test(value.messageId)) {
    fail(400, 'invalid_message', 'A committed Source messageId is required')
  }
  return value.messageId
}
function receiptOf(value) {
  if (typeof value !== 'string' || !RECEIPT.test(value)) fail(400, 'invalid_receipt', 'Invalid attachment receipt')
  return value
}
function displayName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 1024) fail(400, 'invalid_name', 'A file display name is required')
  // Names are labels, never paths; remove traversal, control and bidi presentation.
  const cleaned = name.replace(/\\/g, '/').split('/').pop().normalize('NFC')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim()
  if (!cleaned || /^\.+$/.test(cleaned)) fail(400, 'invalid_name', 'Invalid file display name')
  return Array.from(cleaned).slice(0, 200).join('')
}
function publicMetadata(entry) {
  return {
    receipt: entry.receipt, attachmentId: 'sha256:' + entry.sha256, sha256: entry.sha256,
    name: entry.name, mediaType: entry.mediaType, size: entry.size, isImage: entry.isImage,
    ...(entry.isImage ? { width: entry.width, height: entry.height } : {}),
  }
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535 || width * height > 100_000_000) invalidImage()
  return { width, height }
}

// Header/container inspection, not a claim that a decoder has decoded every pixel.
// Reject truncated containers, spoofed MIME and unsupported image formats outright.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let n = 0; n < 8; n++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function inspectPng(bytes) {
  let position = 8, size, imageData = false, ended = false
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position), end = position + length + 12
    if (end > bytes.length) invalidImage()
    const type = bytes.toString('ascii', position + 4, position + 8)
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(position + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalidImage()
    if (!size) {
      if (type !== 'IHDR' || length !== 13) invalidImage()
      size = dimensions(bytes.readUInt32BE(position + 8), bytes.readUInt32BE(position + 12))
      const depth = bytes[position + 16], color = bytes[position + 17]
      if (!({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color]?.includes(depth)) ||
          bytes[position + 18] !== 0 || bytes[position + 19] !== 0 || bytes[position + 20] > 1) invalidImage()
    } else if (type === 'IHDR') invalidImage()
    if (type === 'IDAT' && length > 0) imageData = true
    position = end
    if (type === 'IEND') { if (length !== 0) invalidImage(); ended = true; break }
  }
  if (!size || !imageData || !ended || position !== bytes.length) invalidImage()
  return size
}
function inspectJpeg(bytes) {
  let position = 2, size
  while (position < bytes.length) {
    if (bytes[position++] !== 0xff) invalidImage()
    while (bytes[position] === 0xff) position++
    const marker = bytes[position++]
    if (marker === 0xd9 || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalidImage()
    if (position + 2 > bytes.length) invalidImage()
    const length = bytes.readUInt16BE(position)
    if (length < 2 || position + length > bytes.length) invalidImage()
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || size) invalidImage()
      const components = bytes[position + 7]
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components || bytes[position + 2] !== 8) invalidImage()
      size = dimensions(bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3))
    }
    if (marker === 0xda) {
      if (!size || length < 6 || position + length >= bytes.length - 2 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalidImage()
      return size
    }
    position += length
  }
  invalidImage()
}
function inspectGif(bytes) {
  if (bytes.length < 14) invalidImage()
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
  let position = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), hasImage = false
  const subblocks = () => {
    while (position < bytes.length) {
      const length = bytes[position++]
      if (!length) return
      position += length
      if (position > bytes.length) invalidImage()
    }
    invalidImage()
  }
  while (position < bytes.length) {
    const marker = bytes[position++]
    if (marker === 0x3b) { if (!hasImage || position !== bytes.length) invalidImage(); return size }
    if (marker === 0x21) { if (position >= bytes.length) invalidImage(); position++; subblocks(); continue }
    if (marker !== 0x2c || position + 9 > bytes.length) invalidImage()
    const left = bytes.readUInt16LE(position), top = bytes.readUInt16LE(position + 2)
    const frame = dimensions(bytes.readUInt16LE(position + 4), bytes.readUInt16LE(position + 6))
    if (left + frame.width > size.width || top + frame.height > size.height) invalidImage()
    const packed = bytes[position + 8]
    position += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0)
    if (position >= bytes.length || bytes[position] < 2 || bytes[position] > 8) invalidImage()
    position++; subblocks(); hasImage = true
  }
  invalidImage()
}
function inspectWebp(bytes, depth = 0) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) invalidImage()
  let position = 12, size, hasImage = false
  while (position + 8 <= bytes.length) {
    const type = bytes.toString('ascii', position, position + 4), length = bytes.readUInt32LE(position + 4)
    const start = position + 8, end = start + length
    if (end + (length & 1) > bytes.length) invalidImage()
    if (type === 'VP8X') {
      if (position !== 12 || length !== 10) invalidImage()
      size = dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1)
    } else if (type === 'VP8 ') {
      if (length < 10 || (bytes[start] & 1) !== 0 || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalidImage()
      const frame = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff)
      if (size && (size.width !== frame.width || size.height !== frame.height)) invalidImage()
      size ??= frame; hasImage = true
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0)) invalidImage()
      const bits = bytes.readUInt32LE(start + 1)
      const frame = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
      if (size && (size.width !== frame.width || size.height !== frame.height)) invalidImage()
      size ??= frame; hasImage = true
    } else if (type === 'ANMF') {
      // Animated WebP contains a 16-byte frame header followed by a real VP8/L chunk.
      if (!size || length < 24 || depth !== 0) invalidImage()
      const frame = dimensions(bytes.readUIntLE(start + 6, 3) + 1, bytes.readUIntLE(start + 9, 3) + 1)
      if (bytes.readUIntLE(start, 3) * 2 + frame.width > size.width || bytes.readUIntLE(start + 3, 3) * 2 + frame.height > size.height) invalidImage()
      const nested = Buffer.alloc(12 + length - 16)
      nested.write('RIFF'); nested.writeUInt32LE(nested.length - 8, 4); nested.write('WEBP', 8)
      bytes.copy(nested, 12, start + 16, end)
      const inspected = inspectWebp(nested, depth + 1)
      if (inspected.width !== frame.width || inspected.height !== frame.height) invalidImage()
      hasImage = true
    }
    position = end + (length & 1)
  }
  if (!size || !hasImage || position !== bytes.length) invalidImage()
  return size
}
function inspectMedia(bytes, declared) {
  if (typeof declared !== 'string' || declared.length > 127 || !MIME.test(declared.trim().toLowerCase())) fail(400, 'invalid_media_type', 'A valid MIME mediaType is required')
  const mediaType = declared.trim().toLowerCase()
  let detected, size
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { detected = 'image/png'; size = inspectPng(bytes) }
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { detected = 'image/jpeg'; size = inspectJpeg(bytes) }
  else if (bytes.length >= 6 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6))) { detected = 'image/gif'; size = inspectGif(bytes) }
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') { detected = 'image/webp'; size = inspectWebp(bytes) }
  if (detected) {
    if (detected !== mediaType) fail(415, 'media_type_mismatch', 'Declared MIME does not match the image bytes')
    return { mediaType, isImage: true, ...size }
  }
  if (mediaType.startsWith('image/')) invalidImage()
  return { mediaType, isImage: false }
}

function ensureDirectory(path, create = false) {
  const absolute = resolve(path), base = parse(absolute).root
  let current = base
  for (const part of absolute.slice(base.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error
      mkdirSync(current, { mode: 0o700 }); stat = lstatSync(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(503, 'unsafe_path', 'Attachment directory must not contain symlinks or non-directories')
  }
  const stat = lstatSync(absolute)
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
    fail(503, 'unsafe_permissions', 'Attachment storage must be private to its OS account (mode 0700)')
  }
}
function safeFileStat(path, maxLinks = 1) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > maxLinks) fail(503, 'unsafe_path', 'Attachment file must be a regular private file without links')
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) fail(503, 'unsafe_permissions', 'Attachment file permissions are not private')
  return stat
}
function readPrivate(path, maxBytes, maxLinks = 1) {
  const initial = safeFileStat(path, maxLinks)
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink < 1 || stat.nlink > maxLinks || initial.ino !== stat.ino || initial.dev !== stat.dev) fail(503, 'unsafe_path', 'Attachment file changed during read')
    if (stat.size > maxBytes) fail(503, 'corrupt_store', 'Attachment file exceeds its recorded size limit')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function syncDirectory(path) {
  if (process.platform === 'win32') return // Windows does not expose directory fsync through node:fs.
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function durableNew(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}

export function createAttachmentStore({ root, clock = Date.now, limits: overrides = {} } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || /^[a-z]+:\/\//i.test(root)) fail(400, 'invalid_root', 'A private absolute filesystem root is required')
  if (typeof clock !== 'function' || !overrides || typeof overrides !== 'object') fail(400, 'invalid_config', 'Invalid attachment store configuration')
  for (const key of Object.keys(overrides)) if (!(key in DEFAULT_LIMITS)) fail(400, 'invalid_config', 'Unknown attachment limit: ' + key)
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) fail(400, 'invalid_config', 'Attachment limits must be positive safe integers')
  // Requests may lower these safety caps, never silently raise them.
  if (limits.maxFileBytes > 20 * MiB || limits.maxFilesPerRequest > 10 || limits.maxTotalFiles > 1000) fail(400, 'invalid_config', 'Attachment safety cap exceeded')
  root = resolve(root)
  const files = join(root, 'files'), manifestPath = join(root, 'manifest.json'), lockPath = join(root, 'lock')
  ensureDirectory(root, true); ensureDirectory(files, true)
  const now = () => {
    const value = Number(clock())
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + limits.draftTtlMs)) fail(503, 'invalid_clock', 'Attachment clock is invalid')
    return value
  }
  const checkDirectories = () => { ensureDirectory(root); ensureDirectory(files) }
  const filePath = entry => {
    if (!RECEIPT.test(entry.receipt) || !(entry.extension === 'bin' || Object.values(EXTENSIONS).includes(entry.extension))) fail(503, 'corrupt_store', 'Invalid attachment storage reference')
    const path = join(files, entry.receipt + '.' + entry.extension)
    if (relative(files, path).startsWith('..') || isAbsolute(relative(files, path))) fail(503, 'unsafe_path', 'Attachment path escaped private storage')
    return path
  }
  function save(manifest) {
    const bytes = Buffer.from(JSON.stringify(manifest))
    if (bytes.length > MAX_MANIFEST_BYTES) fail(413, 'store_limit', 'Attachment manifest limit exceeded')
    const temporary = join(root, 'tmp-' + random())
    try {
      durableNew(temporary, bytes)
      if (existsSync(manifestPath)) safeFileStat(manifestPath)
      renameSync(temporary, manifestPath); syncDirectory(root)
    } finally { if (existsSync(temporary)) { safeFileStat(temporary); unlinkSync(temporary) } }
  }
  function load() {
    if (!existsSync(manifestPath)) {
      // A dangling symlink must not be mistaken for a new store.
      try { lstatSync(manifestPath); fail(503, 'unsafe_path', 'Unsafe attachment manifest') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (readdirSync(files).length) fail(503, 'corrupt_store', 'Attachment manifest is missing for existing files')
      const empty = { version: 1, entries: {}, batches: {} }; save(empty); return empty
    }
    let manifest
    try { manifest = JSON.parse(readPrivate(manifestPath, MAX_MANIFEST_BYTES).toString('utf8')) } catch (error) {
      if (error instanceof AttachmentError) throw error
      fail(503, 'corrupt_store', 'Attachment manifest cannot be read')
    }
    validateManifest(manifest)
    return manifest
  }
  function validateManifest(manifest) {
    const corrupt = () => fail(503, 'corrupt_store', 'Attachment manifest is invalid')
    if (manifest?.version !== 1 || !manifest.entries || !manifest.batches || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries) || typeof manifest.batches !== 'object' || Array.isArray(manifest.batches)) corrupt()
    const entries = Object.entries(manifest.entries)
    if (entries.length > 1000) corrupt()
    for (const [receipt, entry] of entries) {
      if (!entry || !RECEIPT.test(receipt) || entry.receipt !== receipt || !RECEIPT.test(entry.sha256) || !['draft', 'prepared', 'committed'].includes(entry.state) ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 20 * MiB || !Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.expiresAt)) corrupt()
      try { scopeOf(entry); if (displayName(entry.name) !== entry.name) corrupt() } catch { corrupt() }
      if (!MIME.test(entry.mediaType) || typeof entry.isImage !== 'boolean' || entry.extension !== (EXTENSIONS[entry.mediaType] ?? 'bin') || entry.isImage !== Boolean(EXTENSIONS[entry.mediaType])) corrupt()
      if (entry.isImage) { try { dimensions(entry.width, entry.height) } catch { corrupt() } }
      if (entry.state !== 'draft' && (typeof entry.messageId !== 'string' || !entry.messageId)) corrupt()
      filePath(entry)
    }
    const assigned = new Set()
    for (const [key, batch] of Object.entries(manifest.batches)) {
      try { scopeOf(batch); messageIdOf(batch) } catch { corrupt() }
      if (key !== scopeKey(batch) || !['prepared', 'committed'].includes(batch.state) || !Array.isArray(batch.receipts) || batch.receipts.length < 1 || batch.receipts.length > 10 || new Set(batch.receipts).size !== batch.receipts.length) corrupt()
      for (const receipt of batch.receipts) {
        const entry = manifest.entries[receipt]
        if (!entry || assigned.has(receipt) || !sameScope(batch, entry) || entry.messageId !== batch.messageId || entry.state !== batch.state) corrupt()
        assigned.add(receipt)
      }
    }
    for (const [receipt, entry] of entries) if ((entry.state !== 'draft') !== assigned.has(receipt)) corrupt()
  }
  function processAlive(pid) {
    try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error }
  }
  function writerRecord(path, maxLinks = 1) {
    const stat = safeFileStat(path, maxLinks)
    let value
    try { value = JSON.parse(readPrivate(path, 1024, maxLinks).toString('utf8')) } catch { fail(503, 'store_busy', 'Attachment store has an invalid writer lock') }
    if (!Number.isInteger(value.pid) || value.pid < 1 || value.pid > 2147483647 || (value.token !== undefined && !RECEIPT.test(value.token))) fail(503, 'store_busy', 'Attachment store has an invalid writer lock')
    let sibling
    if (stat.nlink === 2) {
      // The only permitted hardlink is our fully written lock-installation record.
      if (!value.token) fail(503, 'unsafe_path', 'Unrecognized linked attachment writer lock')
      sibling = join(root, 'writer-' + value.pid + '-' + value.token)
      const other = safeFileStat(sibling, 2)
      if (other.ino !== stat.ino || other.dev !== stat.dev || other.nlink !== 2) fail(503, 'unsafe_path', 'Attachment writer lock links do not match')
    }
    return { ...value, stat, sibling }
  }
  function locked(operation) {
    checkDirectories()
    const token = random(), temporary = join(root, 'writer-' + process.pid + '-' + token)
    let acquired = false
    try {
      // Publish a complete record atomically. A crash can never leave an empty
      // lock with no PID, which would otherwise be impossible to reclaim safely.
      durableNew(temporary, JSON.stringify({ pid: process.pid, token }))
      for (let attempt = 0; attempt < 2; attempt++) {
        try { linkSync(temporary, lockPath); acquired = true; unlinkSync(temporary); break } catch (error) {
          if (error.code !== 'EEXIST' || acquired) throw error
          const previous = writerRecord(lockPath, 2)
          if (processAlive(previous.pid)) fail(503, 'store_busy', 'Attachment store is busy')
          const current = safeFileStat(lockPath, 2)
          if (current.ino !== previous.stat.ino || current.dev !== previous.stat.dev) fail(503, 'store_busy', 'Attachment writer lock changed')
          unlinkSync(lockPath)
          if (previous.sibling) { safeFileStat(previous.sibling); unlinkSync(previous.sibling) }
        }
      }
      if (!acquired) fail(503, 'store_busy', 'Attachment store is busy')
      return operation(load())
    } finally {
      if (existsSync(temporary)) { safeFileStat(temporary, 2); unlinkSync(temporary) }
      if (acquired) { safeFileStat(lockPath); unlinkSync(lockPath) }
    }
  }
  function entryFor(manifest, value) {
    const scope = scopeOf(value), receipt = receiptOf(value.receipt), entry = manifest.entries[receipt]
    // Do not expose whether another owner's receipt exists.
    if (!entry || !sameScope(entry, scope)) fail(404, 'not_found', 'Attachment not found for this request')
    if (entry.state === 'draft' && entry.expiresAt <= now()) fail(410, 'expired', 'Attachment draft expired')
    if (entry.state === 'committed' && messageIdOf(value) !== entry.messageId) fail(404, 'not_found', 'Attachment not found for this message')
    if (entry.state === 'prepared' && value.messageId !== undefined && messageIdOf(value) !== entry.messageId) fail(404, 'not_found', 'Attachment not found for this message')
    return entry
  }
  function verifiedBytes(entry) {
    let bytes
    try { bytes = readPrivate(filePath(entry), entry.size) } catch (error) {
      if (error instanceof AttachmentError) throw error
      fail(503, 'missing_file', 'Attachment data is unavailable')
    }
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) fail(503, 'integrity_error', 'Attachment data failed integrity verification')
    return bytes
  }
  function sealFile(entry) {
    // Linux/WSL workers receive a read-only artifact, not the writable draft.
    // The same OS account can of course chmod it; this is not an OS sandbox.
    if (process.platform === 'win32') return
    const path = filePath(entry), initial = safeFileStat(path), fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
    try {
      const current = fstatSync(fd)
      if (!current.isFile() || current.nlink !== 1 || current.ino !== initial.ino || current.dev !== initial.dev) fail(503, 'unsafe_path', 'Attachment changed while sealing')
      fchmodSync(fd, 0o400); fsyncSync(fd)
    } finally { closeSync(fd) }
  }
  function batchInput(value) {
    const scope = scopeOf(value), messageId = messageIdOf(value)
    if (!Array.isArray(value.receipts) || value.receipts.length < 1 || value.receipts.length > limits.maxFilesPerRequest || new Set(value.receipts).size !== value.receipts.length) fail(400, 'invalid_receipts', 'A unique nonempty receipt list is required')
    const receipts = value.receipts.map(receiptOf)
    return { ...scope, messageId, receipts }
  }
  function matchingBatch(manifest, input) {
    const batch = manifest.batches[scopeKey(input)]
    if (batch && (!sameScope(batch, input) || batch.messageId !== input.messageId || JSON.stringify(batch.receipts) !== JSON.stringify(input.receipts))) fail(409, 'request_conflict', 'Attachment request was already prepared for another message or receipt list')
    return batch
  }
  function batchResult(manifest, batch) { return { messageId: batch.messageId, attachments: batch.receipts.map(receipt => publicMetadata(manifest.entries[receipt])) } }

  const store = {
    upload(value) {
      const scope = scopeOf(value), name = displayName(value.name)
      if (!Buffer.isBuffer(value.bytes) && !(value.bytes instanceof Uint8Array)) fail(400, 'invalid_bytes', 'Attachment bytes must be a Buffer or Uint8Array')
      if (value.bytes.byteLength > limits.maxFileBytes) fail(413, 'file_limit', 'Attachment exceeds maxFileBytes')
      const bytes = Buffer.from(value.bytes), media = inspectMedia(bytes, value.mediaType), sha256 = hash(bytes)
      return locked(manifest => {
        const owned = Object.values(manifest.entries).filter(entry => sameScope(entry, scope))
        const duplicate = owned.find(entry => entry.sha256 === sha256 && entry.name === name && entry.mediaType === media.mediaType && !(entry.state === 'draft' && entry.expiresAt <= now()))
        if (duplicate) { verifiedBytes(duplicate); return publicMetadata(duplicate) }
        if (manifest.batches[scopeKey(scope)]) fail(409, 'request_conflict', 'Cannot add attachments to a prepared or committed request')
        const all = Object.values(manifest.entries)
        if (owned.length >= limits.maxFilesPerRequest) fail(413, 'count_limit', 'Too many attachments for this request')
        if (owned.reduce((sum, entry) => sum + entry.size, 0) + bytes.length > limits.maxRequestBytes) fail(413, 'request_limit', 'Attachment request byte limit exceeded')
        if (all.length >= limits.maxTotalFiles || all.reduce((sum, entry) => sum + entry.size, 0) + bytes.length > limits.maxTotalBytes) fail(413, 'store_limit', 'Attachment store quota exceeded')
        const at = now(), receipt = random()
        const entry = { ...scope, receipt, sha256, name, ...media, size: bytes.length, extension: EXTENSIONS[media.mediaType] ?? 'bin', state: 'draft', createdAt: at, expiresAt: at + limits.draftTtlMs }
        const temporary = join(files, 'tmp-' + random()), final = filePath(entry)
        try {
          durableNew(temporary, bytes)
          try { lstatSync(final); fail(503, 'receipt_collision', 'Attachment receipt already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
          renameSync(temporary, final); syncDirectory(files)
          manifest.entries[receipt] = entry; save(manifest)
        } finally { if (existsSync(temporary)) { safeFileStat(temporary); unlinkSync(temporary) } }
        return publicMetadata(entry)
      })
    },
    prepare(value) {
      const input = batchInput(value)
      return locked(manifest => {
        const previous = matchingBatch(manifest, input)
        if (previous) { for (const receipt of previous.receipts) verifiedBytes(manifest.entries[receipt]); return batchResult(manifest, previous) }
        const entries = input.receipts.map(receipt => entryFor(manifest, { ...input, receipt }))
        for (const entry of entries) { if (entry.state !== 'draft') fail(409, 'request_conflict', 'Attachment already belongs to another message'); verifiedBytes(entry) }
        const batch = { ...input, state: 'prepared' }
        for (const entry of entries) { entry.state = 'prepared'; entry.messageId = input.messageId }
        manifest.batches[scopeKey(input)] = batch; save(manifest)
        return batchResult(manifest, batch)
      })
    },
    commit(value) {
      const input = batchInput(value)
      return locked(manifest => {
        const batch = matchingBatch(manifest, input)
        if (!batch) fail(409, 'not_prepared', 'Prepare attachments before committing the Source message')
        for (const receipt of batch.receipts) { verifiedBytes(manifest.entries[receipt]); sealFile(manifest.entries[receipt]) }
        if (batch.state !== 'committed') {
          batch.state = 'committed'
          for (const receipt of batch.receipts) manifest.entries[receipt].state = 'committed'
          save(manifest)
        }
        return batchResult(manifest, batch)
      })
    },
    abort(value) {
      const scope = scopeOf(value), messageId = messageIdOf(value)
      return locked(manifest => {
        const key = scopeKey(scope), batch = manifest.batches[key]
        if (!batch) return { aborted: false }
        if (!sameScope(batch, scope) || batch.messageId !== messageId || batch.state === 'committed') fail(409, 'request_conflict', 'Cannot abort another message or a committed attachment request')
        for (const receipt of batch.receipts) {
          const entry = manifest.entries[receipt]; entry.state = 'draft'; delete entry.messageId; entry.expiresAt = now() + limits.draftTtlMs
        }
        delete manifest.batches[key]; save(manifest); return { aborted: true }
      })
    },
    read(value) { return locked(manifest => { const entry = entryFor(manifest, value); return { attachment: publicMetadata(entry), bytes: verifiedBytes(entry) } }) },
    resolve(value) {
      return locked(manifest => {
        const entry = entryFor(manifest, value)
        if (entry.state !== 'committed') fail(409, 'not_committed', 'Only committed Source attachments have worker paths')
        verifiedBytes(entry)
        return { ...publicMetadata(entry), path: filePath(entry) }
      })
    },
    /** Server only: build a Source trigger's real-file context before Source.atomic.
     * This is NOT a public download or proof that the Source transaction committed.
     */
    resolvePrepared(value) {
      const messageId = messageIdOf(value)
      return locked(manifest => {
        const entry = entryFor(manifest, value)
        if (!['prepared', 'committed'].includes(entry.state)) fail(409, 'not_prepared', 'Prepare the Source message before resolving attachment paths')
        if (entry.messageId !== messageId) fail(404, 'not_found', 'Attachment not found for this message')
        verifiedBytes(entry); sealFile(entry)
        return { ...publicMetadata(entry), path: filePath(entry) }
      })
    },
    remove(value) {
      return locked(manifest => {
        const entry = entryFor(manifest, value)
        if (entry.state !== 'draft') fail(409, 'request_conflict', 'Cannot remove a prepared or committed Source attachment')
        const path = filePath(entry); safeFileStat(path)
        delete manifest.entries[entry.receipt]; save(manifest); unlinkSync(path); syncDirectory(files)
        return { removed: true }
      })
    },
    cleanup() {
      return locked(manifest => {
        const at = now(), expired = Object.values(manifest.entries).filter(entry => entry.state === 'draft' && entry.expiresAt <= at)
        // Validate every candidate before changing the manifest or deleting anything.
        const known = new Set(Object.values(manifest.entries).filter(entry => !expired.includes(entry)).map(entry => entry.receipt + '.' + entry.extension))
        const candidates = readdirSync(files).filter(name => !known.has(name))
        for (const name of candidates) {
          if (!FILE.test(name) && !TEMP.test(name)) fail(503, 'unsafe_path', 'Unexpected file in private attachment storage')
          safeFileStat(join(files, name))
        }
        const rootTemps = readdirSync(root).filter(name => {
          if (TEMP.test(name)) return true
          const writer = WRITER.exec(name)
          return writer && Number(writer[1]) <= 2147483647 && !processAlive(Number(writer[1]))
        })
        for (const name of rootTemps) safeFileStat(join(root, name))
        for (const entry of expired) delete manifest.entries[entry.receipt]
        if (expired.length) save(manifest)
        for (const name of candidates) unlinkSync(join(files, name))
        for (const name of rootTemps) unlinkSync(join(root, name))
        syncDirectory(files); syncDirectory(root)
        const expiredFiles = new Set(expired.map(entry => entry.receipt + '.' + entry.extension))
        return { expired: expired.length, orphaned: candidates.filter(name => !expiredFiles.has(name)).length, temporary: rootTemps.length }
      })
    },
  }
  locked(() => {}) // Validate/recover the manifest and a dead writer lock at construction.
  return Object.freeze(store)
}
