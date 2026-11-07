import { createHash } from 'node:crypto';
import { SourceRelayError } from './relay-errors.js';

const MiB = 1024 * 1024;
export const RELAY_ATTACHMENT_LIMITS = Object.freeze({ maxFileBytes: 20 * MiB, maxRequestBytes: 64 * MiB, maxFiles: 10 });
const HEX = /^[a-f0-9]{64}$/u;
const ID = /^sha256:[a-f0-9]{64}$/u;
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const PUBLIC_KEYS = new Set(['receipt', 'attachmentId', 'sha256', 'name', 'mediaType', 'size', 'isImage', 'width', 'height']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new SourceRelayError(code, message); };
const detached = value => JSON.parse(JSON.stringify(value));
const dimensions = ref => Number.isSafeInteger(ref.width) && ref.width > 0 && Number.isSafeInteger(ref.height) && ref.height > 0;
const nameValid = name => typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\u0000-\u001f]/u.test(name);

/** Only genuine Controller-admitted reference blocks, never browser data/receipts/paths. */
export function admittedAttachmentParts(message) {
  const parts = [];
  let total = 0;
  for (const part of message.content) {
    if (part?.type === 'text' && typeof part.text === 'string') continue;
    const ref = part?.attachment;
    if (!['image', 'file'].includes(part?.type) || !ref || typeof ref !== 'object'
      || 'data' in part || 'receiptId' in part || 'path' in part || 'data' in ref || 'path' in ref
      || !ID.test(ref.attachmentId) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
      || ref.bytes > RELAY_ATTACHMENT_LIMITS.maxFileBytes
      || part.type === 'file' && !nameValid(ref.name)
      || part.type === 'image' && (!IMAGES.has(ref.mediaType) || !dimensions(ref) || ref.name !== undefined && !nameValid(ref.name))) {
      fail('unsupported-input', 'Source requires Controller-admitted durable image/file references within its byte limits');
    }
    parts.push(detached(part)); total += ref.bytes;
  }
  if (parts.length > RELAY_ATTACHMENT_LIMITS.maxFiles || total > RELAY_ATTACHMENT_LIMITS.maxRequestBytes) {
    fail('attachment-limit', 'Source attachment count or request byte budget exceeded');
  }
  return parts;
}

export function attachmentSignature(parts) {
  return JSON.stringify(parts.map(({ type, attachment: ref }) => [type, ref.attachmentId, ref.bytes, ref.name ?? '',
    ...(type === 'image' ? [ref.mediaType, ref.width, ref.height] : [])]));
}

export function relayAttachmentsAvailable(ctx, transport, capabilities) {
  const store = ctx.get?.('attachments');
  return capabilities?.attachments === true && typeof transport.upload === 'function' && typeof transport.attachment === 'function'
    && !!store && ['readImage', 'readFileStream', 'saveImages', 'saveFile'].every(key => typeof store[key] === 'function');
}

/** Validate/project public metadata. Nothing resembling a path or raw payload enters a log/outbox. */
export function publicSourceAttachment(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !PUBLIC_KEYS.has(key))
    || !HEX.test(value.receipt) || !HEX.test(value.sha256) || value.attachmentId !== `sha256:${value.sha256}`
    || !nameValid(value.name) || typeof value.mediaType !== 'string' || typeof value.isImage !== 'boolean'
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > RELAY_ATTACHMENT_LIMITS.maxFileBytes
    || value.isImage && (!IMAGES.has(value.mediaType) || !dimensions(value))) {
    fail('invalid-source-attachment', 'Source returned invalid public attachment metadata');
  }
  return { receipt: value.receipt, attachmentId: value.attachmentId, sha256: value.sha256, name: value.name,
    mediaType: value.mediaType, size: value.size, isImage: value.isImage,
    ...(value.isImage ? { width: value.width, height: value.height } : {}) };
}

export function sourceAttachmentMetadata(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > RELAY_ATTACHMENT_LIMITS.maxFiles) fail('attachment-limit', 'Invalid Source attachment batch');
  const result = values.map(publicSourceAttachment);
  if (result.reduce((sum, value) => sum + value.size, 0) > RELAY_ATTACHMENT_LIMITS.maxRequestBytes) fail('attachment-limit', 'Source attachment batch exceeds the local byte budget');
  return result;
}

/** Bind a Source receipt batch to the exact admitted local input, including ordered bytes. */
export function assertSourceAttachmentsMatch(message, values, { partial = false } = {}) {
  const parts = admittedAttachmentParts(message);
  const metadata = sourceAttachmentMetadata(values);
  if (metadata.length > parts.length || !partial && metadata.length !== parts.length) fail('request-id-conflict', 'Source attachment count disagrees with the durable request');
  for (const [index, value] of metadata.entries()) {
    const part = parts[index], ref = part.attachment;
    if (value.attachmentId !== ref.attachmentId || value.size !== ref.bytes || value.isImage !== (part.type === 'image')
      || part.type === 'image' && value.mediaType !== ref.mediaType) {
      fail('request-id-conflict', 'Source attachment bytes disagree with the durable request');
    }
  }
  return metadata;
}

async function readLocal(store, part, signal) {
  signal?.throwIfAborted();
  const ref = part.attachment;
  let bytes, mediaType;
  if (part.type === 'image') {
    const stored = await store.readImage(ref, signal);
    bytes = Buffer.from(stored.data);
    mediaType = stored.ref.mediaType; // The real normalizer may have changed PNG into WebP.
    if (!IMAGES.has(mediaType) || stored.ref.attachmentId !== ref.attachmentId) fail('attachment-integrity', 'Native image verification failed');
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of store.readFileStream(ref, signal)) {
      signal?.throwIfAborted(); size += chunk.byteLength;
      if (size > ref.bytes || size > RELAY_ATTACHMENT_LIMITS.maxFileBytes) fail('attachment-limit', 'Native file stream exceeded its admitted size');
      chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks, size);
    mediaType = 'application/octet-stream'; // Native verbatim FileRef has no MIME: never infer from its name.
  }
  if (bytes.length !== ref.bytes || `sha256:${hash(bytes)}` !== ref.attachmentId) fail('attachment-integrity', 'Native attachment byte digest/length mismatch');
  return { name: ref.name ?? 'image', mediaType, bytes };
}

/** Verify a recovered local draft before publishing its attachment refs as readable content. */
export async function readAdmittedAttachments(agent, message, { signal } = {}) {
  const parts = admittedAttachmentParts(message);
  if (!parts.length) return [];
  const store = agent.ctx.get?.('attachments');
  if (!store || typeof store.readImage !== 'function' || typeof store.readFileStream !== 'function') fail('unsupported-attachments', 'Native attachment draft cannot currently be read');
  const uploads = [];
  for (const part of parts) uploads.push(await readLocal(store, part, signal));
  return uploads;
}

/** Read actual local bytes first; only new Source receipts, not local references, cross hosts. */
export async function uploadAdmittedAttachments(agent, request, { signal, onUploaded } = {}) {
  const parts = admittedAttachmentParts(request.message);
  if (!parts.length) return [];
  if (!relayAttachmentsAvailable(agent.ctx, agent.transport, agent.capabilities)) fail('unsupported-attachments', 'Source attachment transfer is unavailable');
  // Bounded, serial reads prove every input before beginning an external upload.
  const uploads = await readAdmittedAttachments(agent, request.message, { signal });
  const metadata = [];
  for (const upload of uploads) {
    signal?.throwIfAborted();
    const response = await agent.transport.upload({ conversationId: agent.conversationId, requestId: request.requestId,
      name: upload.name, mediaType: upload.mediaType, data: upload.bytes.toString('base64') }, { signal });
    signal?.throwIfAborted();
    const value = publicSourceAttachment(response?.attachment);
    if (value.sha256 !== hash(upload.bytes) || value.size !== upload.bytes.length || value.mediaType !== upload.mediaType) {
      fail('attachment-integrity', 'Source upload did not acknowledge these exact transferred bytes');
    }
    metadata.push(value);
    assertSourceAttachmentsMatch(request.message, metadata, { partial: true });
    onUploaded?.(detached(metadata)); // Persist only public receipt metadata, NEVER bytes/base64.
  }
  return metadata;
}

function decodeSourceBytes(data, metadata) {
  if (typeof data !== 'string' || data.length > Math.ceil(RELAY_ATTACHMENT_LIMITS.maxFileBytes / 3) * 4) fail('attachment-limit', 'Source attachment payload exceeds its byte budget');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || bytes.length !== metadata.size || hash(bytes) !== metadata.sha256) {
    fail('attachment-integrity', 'Source attachment payload digest/length mismatch');
  }
  return bytes;
}

/** Pure Source reads can be retried; a native reference is emitted only after real storage succeeds. */
export async function restoreSourceUserMessage(agent, event, request, { signal } = {}) {
  const metadata = sourceAttachmentMetadata(event.attachments);
  if (request) assertSourceAttachmentsMatch(request.message, metadata);
  const parts = [];
  if (metadata.length) {
    if (!relayAttachmentsAvailable(agent.ctx, agent.transport, agent.capabilities)) fail('unsupported-attachments', 'Source history attachments cannot currently be read');
    if (typeof event.requestId !== 'string' || !event.requestId) fail('invalid-source-attachment', 'Source attachment history requires its owning request identity');
    const downloads = [];
    for (const value of metadata) {
      signal?.throwIfAborted();
      const response = await agent.transport.attachment({ conversationId: agent.conversationId, requestId: event.requestId,
        messageId: event.id, receipt: value.receipt }, { signal });
      signal?.throwIfAborted();
      const observed = publicSourceAttachment(response?.attachment);
      if (JSON.stringify(observed) !== JSON.stringify(value)) fail('attachment-integrity', 'Source attachment read returned different scoped metadata');
      downloads.push({ value, bytes: decodeSourceBytes(response.data, value) });
    }
    const store = agent.ctx.get('attachments');
    const images = downloads.filter(item => item.value.isImage);
    signal?.throwIfAborted();
    const imageRefs = images.length ? await store.saveImages(images.map(item => ({ data: item.bytes, mediaType: item.value.mediaType, name: item.value.name }))) : [];
    let imageIndex = 0;
    for (const item of downloads) {
      signal?.throwIfAborted();
      const attachment = item.value.isImage ? imageRefs[imageIndex++] : await store.saveFile({ data: item.bytes, name: item.value.name });
      const part = { type: item.value.isImage ? 'image' : 'file', attachment };
      // Use provider-returned refs unchanged. Verify the imported blob is genuinely readable.
      await readLocal(store, part, signal);
      parts.push(part);
    }
  }
  if (request) {
    let index = 0;
    return { ...detached(request.message), content: request.message.content.map(part => part.type === 'text' ? detached(part) : parts[index++]) };
  }
  return { id: `superagent-user-${event.id}`, role: 'user', source: { kind: 'user', ...(event.requestId ? { rpcId: event.requestId } : {}) },
    content: [...event.text === '' ? [] : [{ type: 'text', text: event.text }], ...parts] };
}
