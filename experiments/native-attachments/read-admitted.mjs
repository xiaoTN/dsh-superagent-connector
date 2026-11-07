/** Minimal server-side handoff. This consumes Controller-admitted refs, NOT browser receipts.
 * Call in the relay's asynchronous pump AFTER followup synchronously persists the
 * original native message/refs to its private outbox. It does not open a Session writer.
 * Returned bytes must travel to the real Source attachment intake; local ids and
 * host paths are NOT portable attachment credentials.
 */
export async function readAdmittedAttachments(agent, message, {
  maxFileBytes = 20 * 1024 * 1024, maxRequestBytes = 100 * 1024 * 1024, maxFiles = 10, signal,
} = {}) {
  if (message?.role !== 'user' || message.source?.kind !== 'user' || !Array.isArray(message.content)) throw Error('Expected Controller-admitted user message')
  const parts = message.content.filter(part => part.type !== 'text')
  if (parts.length > maxFiles) throw Error('Source request attachment count limit exceeded')
  const uploads = []
  let total = 0
  for (const part of parts) {
    signal?.throwIfAborted()
    if (!['image', 'file'].includes(part.type) || !part.attachment || 'receiptId' in part || 'data' in part) throw Error('Expected durable admitted attachment reference')
    const ref = part.attachment
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > maxFileBytes) throw Error('Source maxFileBytes exceeded')
    if (total + ref.bytes > maxRequestBytes) throw Error('Source maxRequestBytes exceeded')
    let bytes, mediaType
    if (part.type === 'image') {
      const stored = await agent.ctx.attachments.readImage(ref, signal)
      bytes = Buffer.from(stored.data)
      mediaType = stored.ref.mediaType // Use the real normalized object's MIME, never spoof it.
    } else {
      const chunks = []
      let size = 0
      for await (const chunk of agent.ctx.attachments.readFileStream(ref, signal)) {
        signal?.throwIfAborted()
        size += chunk.byteLength
        if (size > maxFileBytes || total + size > maxRequestBytes) throw Error('Source attachment byte limit exceeded')
        chunks.push(Buffer.from(chunk))
      }
      bytes = Buffer.concat(chunks, size)
      // The native verbatim FileRef carries NO MIME. Do not infer image readability
      // from its name or change its type. Arbitrary files remain binary files.
      mediaType = 'application/octet-stream'
    }
    if (bytes.length !== ref.bytes || bytes.length > maxFileBytes || total + bytes.length > maxRequestBytes) throw Error('Source attachment size/integrity mismatch')
    total += bytes.length
    uploads.push({ name: ref.name ?? (part.type === 'image' ? 'image' : 'file'), mediaType, bytes, localRef: structuredClone(ref) })
  }
  return uploads
}
