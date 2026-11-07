import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { AttachmentError, createAttachmentStore } from '../src/source-attachments.js'

// Real tiny, public image fixtures, not user uploads. No decoders or dependencies.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64')
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==', 'base64')
const SCOPE = Object.freeze({ owner: 'operator', conversationId: 'main', requestId: 'request-1' })
const request = (overrides = {}) => ({ ...SCOPE, name: 'note.txt', mediaType: 'text/plain', bytes: Buffer.from('hello'), ...overrides })
const failure = (code, status) => error => error instanceof AttachmentError && error.code === code && (!status || error.status === status)

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-source-attachments-'))
  assert.ok(isAbsolute(root)); assert.ok(basename(root).startsWith('dsh-source-attachments-'))
  t.after(() => { assert.equal(resolve(root), root); assert.ok(basename(root).startsWith('dsh-source-attachments-')); rmSync(root, { recursive: true, force: true }) })
  return { root, store: createAttachmentStore({ root, ...options }) }
}
function transaction(attachment, overrides = {}) { return { ...SCOPE, messageId: 'native-source-message', receipts: [attachment.receipt], ...overrides } }
function storedPath(root, receipt, extension = 'bin') { return join(root, 'files', receipt + '.' + extension) }
function canSymlink(t, target, path, type) {
  try { symlinkSync(target, path, type); return true } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('OS does not permit creating this test symlink'); return false }
    throw error
  }
}

test('uploads persist actual bytes with random receipts, digest and safe public metadata', t => {
  const { root, store } = fixture(t)
  const attachment = store.upload(request({ name: '../../folder\\secret\u202efile.txt' }))
  assert.match(attachment.receipt, /^[a-f0-9]{64}$/)
  assert.equal(attachment.sha256, createHash('sha256').update('hello').digest('hex'))
  assert.equal(attachment.attachmentId, 'sha256:' + attachment.sha256)
  assert.notEqual(attachment.receipt, attachment.sha256)
  assert.equal(attachment.name, 'secretfile.txt'); assert.equal(attachment.mediaType, 'text/plain')
  assert.equal(attachment.size, 5); assert.equal(attachment.isImage, false)
  assert.equal('path' in attachment, false); assert.equal(JSON.stringify(attachment).includes(root), false)
  assert.deepEqual(readFileSync(storedPath(root, attachment.receipt)), Buffer.from('hello'))
  const read = store.read({ ...SCOPE, receipt: attachment.receipt })
  assert.deepEqual(read.bytes, Buffer.from('hello')); assert.deepEqual(read.attachment, attachment)
  assert.deepEqual(readdirSync(join(root, 'files')), [attachment.receipt + '.bin'])
  assert.throws(() => store.resolve({ ...SCOPE, receipt: attachment.receipt }), failure('not_committed', 409))
})

test('duplicate uploads are durable and scoped, never another owner’s receipt', t => {
  const { root, store } = fixture(t)
  const first = store.upload(request())
  assert.deepEqual(store.upload(request()), first)
  assert.deepEqual(createAttachmentStore({ root }).upload(request()), first)
  for (const change of [{ owner: 'other' }, { conversationId: 'other' }, { requestId: 'other' }]) {
    const other = store.upload(request(change))
    assert.notEqual(other.receipt, first.receipt)
    for (const method of ['read', 'remove', 'resolve']) assert.throws(() => store[method]({ ...SCOPE, ...change, receipt: first.receipt }), failure('not_found', 404))
    assert.throws(() => store.prepare(transaction(first, change)), failure('not_found', 404))
  }
  assert.equal(readdirSync(join(root, 'files')).length, 4)
})

test('prepare/commit is scoped, ordered, immutable, idempotent and produces real worker paths', t => {
  const { root, store } = fixture(t)
  const first = store.upload(request()), second = store.upload(request({ name: 'second.txt', bytes: Buffer.from('next') }))
  const input = transaction(first, { receipts: [first.receipt, second.receipt] })
  const prepared = store.prepare(input)
  assert.deepEqual(prepared, { messageId: input.messageId, attachments: [first, second] })
  assert.deepEqual(store.prepare(input), prepared)
  assert.throws(() => store.resolve({ ...SCOPE, receipt: first.receipt, messageId: input.messageId }), failure('not_committed'))
  assert.throws(() => store.upload(request({ name: 'late.txt' })), failure('request_conflict'))
  assert.throws(() => store.prepare({ ...input, receipts: [...input.receipts].reverse() }), failure('request_conflict'))
  assert.throws(() => store.prepare({ ...input, messageId: 'wrong' }), failure('request_conflict'))
  assert.throws(() => store.commit({ ...input, receipts: [first.receipt] }), failure('request_conflict'))
  assert.throws(() => store.commit({ ...input, owner: 'other' }), failure('not_prepared'))
  assert.deepEqual(store.commit(input), prepared)
  assert.deepEqual(store.commit(input), prepared)
  assert.deepEqual(createAttachmentStore({ root }).commit(input), prepared)
  assert.deepEqual(store.upload(request()), first)
  const resolved = store.resolve({ ...SCOPE, messageId: input.messageId, receipt: first.receipt })
  assert.equal(resolved.path, storedPath(root, first.receipt)); assert.ok(isAbsolute(resolved.path))
  if (process.platform !== 'win32') assert.equal(lstatSync(resolved.path).mode & 0o222, 0)
  assert.deepEqual(readFileSync(resolved.path), Buffer.from('hello'))
  assert.deepEqual(store.read({ ...SCOPE, messageId: input.messageId, receipt: first.receipt }).bytes, Buffer.from('hello'))
  assert.throws(() => store.read({ ...SCOPE, receipt: first.receipt }), failure('invalid_message'))
  assert.throws(() => store.resolve({ ...SCOPE, receipt: first.receipt, messageId: 'other' }), failure('not_found'))
  assert.throws(() => store.remove({ ...SCOPE, receipt: first.receipt, messageId: input.messageId }), failure('request_conflict'))
  assert.throws(() => store.abort(input), failure('request_conflict'))
})

test('resolvePrepared is server-only, exact-message-bound, read-only and never commits a draft', t => {
  const { root, store } = fixture(t), file = store.upload(request()), input = transaction(file)
  const value = { ...SCOPE, receipt: file.receipt, messageId: input.messageId }
  assert.throws(() => store.resolvePrepared(value), failure('not_prepared'))
  assert.throws(() => store.resolvePrepared({ ...SCOPE, receipt: file.receipt }), failure('invalid_message'))
  store.prepare(input)
  const worker = store.resolvePrepared(value)
  assert.equal(worker.path, storedPath(root, file.receipt))
  assert.deepEqual(readFileSync(worker.path), Buffer.from('hello'))
  if (process.platform !== 'win32') assert.equal(lstatSync(worker.path).mode & 0o222, 0)
  for (const change of [{ owner: 'other' }, { conversationId: 'other' }, { requestId: 'other' }, { messageId: 'other' }]) {
    assert.throws(() => store.resolvePrepared({ ...value, ...change }), failure('not_found'))
  }
  assert.throws(() => store.resolve(value), failure('not_committed'), 'prepared resolution must not silently commit')
  assert.deepEqual(createAttachmentStore({ root }).resolvePrepared(value), worker)
  store.commit(input)
  assert.deepEqual(store.resolvePrepared(value), store.resolve(value))
})

test('crash window after prepare is recoverable, and TTL cannot erase prepared or committed files', t => {
  let at = 100
  const { root, store } = fixture(t, { clock: () => at, limits: { draftTtlMs: 10 } })
  const pending = store.upload(request()), orphan = store.upload(request({ requestId: 'unsent' }))
  const input = transaction(pending)
  store.prepare(input)
  at = 100000
  const restarted = createAttachmentStore({ root, clock: () => at, limits: { draftTtlMs: 10 } })
  assert.deepEqual(restarted.cleanup(), { expired: 1, orphaned: 0, temporary: 0 })
  assert.equal(existsSync(storedPath(root, orphan.receipt)), false)
  assert.deepEqual(restarted.commit(input).attachments, [pending])
  at += 100000
  assert.deepEqual(restarted.cleanup(), { expired: 0, orphaned: 0, temporary: 0 })
  assert.equal(existsSync(restarted.resolve({ ...SCOPE, messageId: input.messageId, receipt: pending.receipt }).path), true)
})

test('explicit failed-Source abort releases only the matching uncommitted batch', t => {
  let at = 1
  const { store } = fixture(t, { clock: () => at, limits: { draftTtlMs: 10 } })
  const file = store.upload(request()), input = transaction(file)
  store.prepare(input); at = 100
  assert.throws(() => store.abort({ ...input, messageId: 'wrong' }), failure('request_conflict'))
  assert.deepEqual(store.abort({ ...input, owner: 'other' }), { aborted: false })
  assert.deepEqual(store.abort(input), { aborted: true })
  assert.deepEqual(store.abort(input), { aborted: false })
  assert.deepEqual(store.read({ ...SCOPE, receipt: file.receipt }).bytes, Buffer.from('hello'))
  assert.throws(() => store.commit(input), failure('not_prepared'))
  store.prepare({ ...input, messageId: 'new-message' }); store.commit({ ...input, messageId: 'new-message' })
})

test('all four supported image types use real headers and create read_image files', t => {
  const { store } = fixture(t)
  for (const [type, bytes] of [['png', PNG], ['gif', GIF], ['webp', WEBP], ['jpeg', JPEG]]) {
    const scope = { ...SCOPE, requestId: type }
    const file = store.upload(request({ ...scope, name: 'pixel.' + type, mediaType: 'image/' + type, bytes }))
    assert.equal(file.isImage, true); assert.equal(file.width, 1); assert.equal(file.height, 1)
    const input = { ...scope, messageId: 'message-' + type, receipts: [file.receipt] }
    store.prepare(input); store.commit(input)
    assert.deepEqual(readFileSync(store.resolve({ ...scope, receipt: file.receipt, messageId: input.messageId }).path), bytes)
  }
})

test('MIME spoofing, malformed/truncated containers and unsupported images are real errors', t => {
  const { store } = fixture(t)
  for (const [bytes, mediaType] of [
    [PNG, 'image/jpeg'], [PNG, 'application/octet-stream'], [GIF, 'text/plain'], [JPEG, 'image/png'], [WEBP, 'image/gif'],
  ]) assert.throws(() => store.upload(request({ bytes, mediaType })), failure('media_type_mismatch', 415))
  for (const [bytes, mediaType] of [
    [Buffer.from('not an image'), 'image/png'], [PNG.subarray(0, 24), 'image/png'],
    [GIF.subarray(0, -1), 'image/gif'], [JPEG.subarray(0, -2), 'image/jpeg'], [WEBP.subarray(0, -1), 'image/webp'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'], [Buffer.from('BMxxxx'), 'image/bmp'],
  ]) assert.throws(() => store.upload(request({ bytes, mediaType })), failure('invalid_image', 415))
  const corrupt = Buffer.from(PNG); corrupt[corrupt.length - 5] ^= 1
  assert.throws(() => store.upload(request({ bytes: corrupt, mediaType: 'image/png' })), failure('invalid_image'))
  assert.throws(() => store.upload(request({ mediaType: 'image/png\r\nx-evil: hi' })), failure('invalid_media_type', 400))
  const text = store.upload(request({ bytes: Buffer.from('<svg/>'), mediaType: 'text/plain' }))
  assert.equal(text.mediaType, 'text/plain'); assert.equal(text.isImage, false)
})

test('empty ordinary files and Uint8Array work without pretending to be images', t => {
  const { store } = fixture(t)
  const empty = store.upload(request({ bytes: new Uint8Array(), mediaType: ' APPLICATION/OCTET-STREAM ' }))
  assert.equal(empty.size, 0); assert.equal(empty.mediaType, 'application/octet-stream'); assert.equal(empty.isImage, false)
  assert.deepEqual(store.read({ ...SCOPE, receipt: empty.receipt }).bytes, Buffer.alloc(0))
  assert.throws(() => store.upload(request({ bytes: 'base64 string is not bytes' })), failure('invalid_bytes'))
})

test('per-file hard ceiling rejects bytes before any write or image inspection', t => {
  const { root, store } = fixture(t)
  assert.throws(() => store.upload(request({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1), mediaType: 'image/png' })), failure('file_limit', 413))
  assert.deepEqual(readdirSync(join(root, 'files')), [])
})

test('request byte quota, ten-file ceiling, root byte/count quotas and dedup are enforced', t => {
  const { store } = fixture(t, { limits: { maxFileBytes: 6, maxRequestBytes: 8, maxTotalBytes: 12 } })
  const a = store.upload(request())
  assert.deepEqual(store.upload(request()), a)
  assert.throws(() => store.upload(request({ bytes: Buffer.alloc(7) })), failure('file_limit'))
  assert.throws(() => store.upload(request({ name: 'second.txt' })), failure('request_limit'))
  store.upload(request({ requestId: 'two' }))
  assert.throws(() => store.upload(request({ requestId: 'three' })), failure('store_limit'))
  const count = fixture(t).store
  for (let n = 0; n < 10; n++) count.upload(request({ name: n + '.txt', bytes: Buffer.from([n]) }))
  assert.throws(() => count.upload(request({ name: '11.txt', bytes: Buffer.from([11]) })), failure('count_limit'))
  const totalCount = fixture(t, { limits: { maxTotalFiles: 1 } }).store
  totalCount.upload(request())
  assert.throws(() => totalCount.upload(request({ requestId: 'other' })), failure('store_limit'))
})

test('expired drafts cannot be read/prepared and cleanup releases quota without following paths', t => {
  let at = 0
  const { root, store } = fixture(t, { clock: () => at, limits: { draftTtlMs: 10, maxTotalFiles: 1 } })
  const file = store.upload(request()); at = 10
  assert.throws(() => store.read({ ...SCOPE, receipt: file.receipt }), failure('expired', 410))
  assert.throws(() => store.prepare(transaction(file)), failure('expired', 410))
  assert.deepEqual(store.cleanup(), { expired: 1, orphaned: 0, temporary: 0 })
  assert.equal(existsSync(storedPath(root, file.receipt)), false)
  assert.throws(() => store.read({ ...SCOPE, receipt: file.receipt }), failure('not_found'))
  assert.ok(store.upload(request()))
})

test('scoped deletion removes only a draft and repeated deletion is not another owner’s success', t => {
  const { root, store } = fixture(t)
  const file = store.upload(request())
  assert.throws(() => store.remove({ ...SCOPE, requestId: 'wrong', receipt: file.receipt }), failure('not_found'))
  assert.deepEqual(store.remove({ ...SCOPE, receipt: file.receipt }), { removed: true })
  assert.equal(existsSync(storedPath(root, file.receipt)), false)
  assert.throws(() => store.remove({ ...SCOPE, receipt: file.receipt }), failure('not_found'))
})

test('untrusted receipt paths and URLs never reach the filesystem', t => {
  const { store } = fixture(t)
  for (const receipt of ['../secret', '/etc/passwd', 'C:\\Windows\\win.ini', 'https://example.test/a.png', 'file:///etc/passwd', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64) + '.png']) {
    for (const method of ['read', 'resolve', 'remove']) assert.throws(() => store[method]({ ...SCOPE, receipt }), failure('invalid_receipt', 400))
    assert.throws(() => store.prepare({ ...SCOPE, messageId: 'm', receipts: [receipt] }), failure('invalid_receipt', 400))
  }
  for (const field of ['owner', 'conversationId', 'requestId']) {
    assert.throws(() => store.upload(request({ [field]: '' })), failure('invalid_scope'))
    assert.throws(() => store.upload(request({ [field]: 'a\nspoof' })), failure('invalid_scope'))
  }
})

test('invalid configuration and duplicate/empty receipt batches fail closed', t => {
  const { root, store } = fixture(t)
  for (const bad of ['relative/path', 'https://example.test/root', 'file:///tmp/root']) assert.throws(() => createAttachmentStore({ root: bad }), failure('invalid_root'))
  for (const limits of [{ maxFilesPerRequest: 11 }, { maxFileBytes: 21 * 1024 * 1024 }, { maxTotalFiles: 1001 }, { draftTtlMs: 0 }, { unknown: 1 }]) assert.throws(() => createAttachmentStore({ root, limits }), failure('invalid_config'))
  const file = store.upload(request())
  for (const receipts of [[], [file.receipt, file.receipt], 'not an array']) assert.throws(() => store.prepare({ ...SCOPE, messageId: 'm', receipts }), failure('invalid_receipts'))
  assert.throws(() => store.prepare({ ...SCOPE, receipts: [file.receipt] }), failure('invalid_message'))
  for (const name of ['', '..', '../', '...']) assert.throws(() => store.upload(request({ name })), failure('invalid_name'))
})

test('all-or-nothing prepare leaves earlier receipts draft when a later receipt is wrong', t => {
  const { store } = fixture(t)
  const file = store.upload(request())
  assert.throws(() => store.prepare(transaction(file, { receipts: [file.receipt, 'f'.repeat(64)] })), failure('not_found'))
  assert.deepEqual(store.remove({ ...SCOPE, receipt: file.receipt }), { removed: true })
})

test('file tampering and missing bytes are never served or committed as good attachments', t => {
  const { root, store } = fixture(t)
  const file = store.upload(request()), path = storedPath(root, file.receipt)
  writeFileSync(path, 'jello', { mode: 0o600 })
  assert.throws(() => store.read({ ...SCOPE, receipt: file.receipt }), failure('integrity_error', 503))
  assert.throws(() => store.prepare(transaction(file)), failure('integrity_error'))
  assert.throws(() => store.upload(request()), failure('integrity_error'))
  unlinkSync(path)
  assert.throws(() => store.read({ ...SCOPE, receipt: file.receipt }), failure('missing_file'))
})

test('missing manifest with existing files and corrupt manifest never reset committed ownership', t => {
  const { root, store } = fixture(t)
  const file = store.upload(request()); store.prepare(transaction(file)); store.commit(transaction(file))
  const manifest = join(root, 'manifest.json'), original = readFileSync(manifest)
  writeFileSync(manifest, '{invalid', { mode: 0o600 })
  assert.throws(() => createAttachmentStore({ root }), failure('corrupt_store'))
  writeFileSync(manifest, original, { mode: 0o600 }); unlinkSync(manifest)
  assert.throws(() => createAttachmentStore({ root }), failure('corrupt_store'))
  assert.equal(existsSync(storedPath(root, file.receipt)), true)
})

test('manifest path injection and ownership-state inconsistency are rejected on restart', t => {
  const { root, store } = fixture(t)
  const file = store.upload(request()), path = join(root, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')), original = JSON.stringify(manifest)
  manifest.entries[file.receipt].extension = '../../escape'
  writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
  assert.throws(() => createAttachmentStore({ root }), failure('corrupt_store'))
  const another = JSON.parse(original); another.entries[file.receipt].state = 'committed'; another.entries[file.receipt].messageId = 'm'
  writeFileSync(path, JSON.stringify(another), { mode: 0o600 })
  assert.throws(() => createAttachmentStore({ root }), failure('corrupt_store'))
})

test('crash leftovers are cleaned without deleting committed files', t => {
  const { root, store } = fixture(t)
  const file = store.upload(request()); store.prepare(transaction(file)); store.commit(transaction(file))
  writeFileSync(join(root, 'files', 'b'.repeat(64) + '.png'), PNG, { mode: 0o600 })
  writeFileSync(join(root, 'files', 'tmp-' + 'c'.repeat(64)), 'incomplete', { mode: 0o600 })
  writeFileSync(join(root, 'tmp-' + 'd'.repeat(64)), 'incomplete manifest', { mode: 0o600 })
  assert.deepEqual(store.cleanup(), { expired: 0, orphaned: 2, temporary: 1 })
  assert.deepEqual(readdirSync(join(root, 'files')), [file.receipt + '.bin'])
  assert.equal(store.read({ ...SCOPE, receipt: file.receipt, messageId: 'native-source-message' }).bytes.toString(), 'hello')
})

test('a live writer lock is not stolen and an unambiguous dead writer can recover', t => {
  const { root, store } = fixture(t), lock = join(root, 'lock')
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  assert.throws(() => store.upload(request()), failure('store_busy'))
  assert.equal(existsSync(lock), true); unlinkSync(lock)
  // PID 2147483647 is outside normal OS PID allocation on supported hosts.
  writeFileSync(lock, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 })
  const restarted = createAttachmentStore({ root })
  assert.ok(restarted.upload(request())); assert.equal(existsSync(lock), false)
})

test('crash during atomic writer-lock publication recovers linked record and partial orphan', t => {
  const { root } = fixture(t), dead = 2147483647, token = 'e'.repeat(64)
  const writer = join(root, 'writer-' + dead + '-' + token), lock = join(root, 'lock')
  writeFileSync(writer, JSON.stringify({ pid: dead, token }), { mode: 0o600 }); linkSync(writer, lock)
  const partial = join(root, 'writer-' + dead + '-' + 'f'.repeat(64))
  writeFileSync(partial, '', { mode: 0o600 })
  const restarted = createAttachmentStore({ root })
  assert.equal(existsSync(writer), false); assert.equal(existsSync(lock), false)
  assert.deepEqual(restarted.cleanup(), { expired: 0, orphaned: 0, temporary: 1 })
  assert.equal(existsSync(partial), false)
})

test('hardlinked attachment data cannot be read, committed, removed or swept', t => {
  const { root, store } = fixture(t), file = store.upload(request())
  const alias = join(root, 'alias'); linkSync(storedPath(root, file.receipt), alias)
  assert.throws(() => store.read({ ...SCOPE, receipt: file.receipt }), failure('unsafe_path'))
  assert.throws(() => store.prepare(transaction(file)), failure('unsafe_path'))
  assert.throws(() => store.remove({ ...SCOPE, receipt: file.receipt }), failure('unsafe_path'))
  unlinkSync(alias)
  assert.deepEqual(store.read({ ...SCOPE, receipt: file.receipt }).bytes, Buffer.from('hello'))
})

test('symlinked root/ancestor directories are rejected, including junctions on Windows', t => {
  const { root } = fixture(t), external = join(root, 'external'), alias = join(root, 'alias')
  mkdirSync(external, { mode: 0o700 })
  if (!canSymlink(t, external, alias, process.platform === 'win32' ? 'junction' : 'dir')) return
  assert.throws(() => createAttachmentStore({ root: alias }), failure('unsafe_path'))
  assert.throws(() => createAttachmentStore({ root: join(alias, 'nested') }), failure('unsafe_path'))
  assert.equal(existsSync(join(external, 'nested')), false)
})

test('directory replacement after creation is rejected before upload/read/cleanup', t => {
  const { root, store } = fixture(t), external = join(root, 'external'), files = join(root, 'files')
  mkdirSync(external, { mode: 0o700 }); rmSync(files, { recursive: true })
  if (!canSymlink(t, external, files, process.platform === 'win32' ? 'junction' : 'dir')) return
  for (const call of [() => store.upload(request()), () => store.cleanup(), () => store.read({ ...SCOPE, receipt: 'a'.repeat(64) })]) assert.throws(call, failure('unsafe_path'))
  assert.deepEqual(readdirSync(external), [])
})

test('symlink files, including dangling references, are never followed', t => {
  const { root, store } = fixture(t), file = store.upload(request()), external = join(root, 'external.txt'), path = storedPath(root, file.receipt)
  writeFileSync(external, 'external-private', { mode: 0o600 }); unlinkSync(path)
  if (!canSymlink(t, external, path, 'file')) return
  assert.throws(() => store.read({ ...SCOPE, receipt: file.receipt }), failure('unsafe_path'))
  assert.throws(() => store.remove({ ...SCOPE, receipt: file.receipt }), failure('unsafe_path'))
  assert.equal(readFileSync(external, 'utf8'), 'external-private')
  unlinkSync(path); symlinkSync(join(root, 'does-not-exist'), path, 'file')
  assert.throws(() => store.read({ ...SCOPE, receipt: file.receipt }), failure('unsafe_path'))
})

test('manifest symlinks never load arbitrary JSON or overwrite external files', t => {
  const { root, store } = fixture(t), external = join(root, 'external.json'), manifest = join(root, 'manifest.json')
  writeFileSync(external, readFileSync(manifest), { mode: 0o600 }); unlinkSync(manifest)
  if (!canSymlink(t, external, manifest, 'file')) return
  assert.throws(() => createAttachmentStore({ root }), failure('unsafe_path'))
  assert.throws(() => store.upload(request()), failure('unsafe_path'))
  assert.deepEqual(readdirSync(join(root, 'files')), [])
})
