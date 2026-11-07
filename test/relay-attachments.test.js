import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { admittedAttachmentParts, attachmentSignature, publicSourceAttachment, sourceAttachmentMetadata,
  relayAttachmentsAvailable, assertSourceAttachmentsMatch, RELAY_ATTACHMENT_LIMITS } from '../src/relay-attachments.js';

const digest = createHash('sha256').update('fixture').digest('hex');
const file = { type: 'file', attachment: { attachmentId: `sha256:${digest}`, name: 'fixture.txt', bytes: 7 } };
const image = { type: 'image', attachment: { attachmentId: `sha256:${digest}`, name: 'fixture.webp', bytes: 7, mediaType: 'image/webp', width: 1, height: 1 } };
const message = content => ({ id: 'message-fixture', role: 'user', source: { kind: 'user' }, content });
const metadata = { receipt: 'a'.repeat(64), attachmentId: `sha256:${digest}`, sha256: digest, name: 'fixture.txt', mediaType: 'application/octet-stream', size: 7, isImage: false };

test('admitted attachment parsing accepts durable reference shapes only, never browser bytes or receipts', () => {
  assert.deepEqual(admittedAttachmentParts(message([{ type: 'text', text: '' }, file, image])), [file, image]);
  for (const invalid of [
    { type: 'image', data: 'base64', mediaType: 'image/png' },
    { type: 'file', receiptId: 'native-upload-receipt' },
    { ...file, path: '/private/local/object' },
    { ...file, attachment: { ...file.attachment, data: 'base64' } },
    { ...image, attachment: { ...image.attachment, mediaType: 'image/svg+xml' } },
    { ...file, attachment: { ...file.attachment, attachmentId: '/private/file' } },
  ]) assert.throws(() => admittedAttachmentParts(message([invalid])), { code: 'unsupported-input' });
  assert.throws(() => admittedAttachmentParts(message(Array(11).fill(file))), { code: 'attachment-limit' });
  assert.throws(() => admittedAttachmentParts(message(Array(4).fill({ ...file, attachment: { ...file.attachment, bytes: 20 * 1024 * 1024 } }))), { code: 'attachment-limit' });
  assert.equal(RELAY_ATTACHMENT_LIMITS.maxRequestBytes, 64 * 1024 * 1024);
  assert.notEqual(attachmentSignature([file, image]), attachmentSignature([image, file]), 'request identity binds attachment order');
});

test('Source public attachment metadata cannot contain paths and must bind exact ordered request bytes', () => {
  assert.deepEqual(publicSourceAttachment(metadata), metadata);
  assert.deepEqual(assertSourceAttachmentsMatch(message([file]), [metadata]), [metadata]);
  assert.throws(() => publicSourceAttachment({ ...metadata, path: '/server/private/blob' }), { code: 'invalid-source-attachment' });
  assert.throws(() => publicSourceAttachment({ ...metadata, attachmentId: `sha256:${'b'.repeat(64)}` }), { code: 'invalid-source-attachment' });
  assert.throws(() => assertSourceAttachmentsMatch(message([file]), [{ ...metadata, size: 6 }]), { code: 'request-id-conflict' });
  assert.throws(() => assertSourceAttachmentsMatch(message([file]), []), { code: 'request-id-conflict' });
  assert.deepEqual(assertSourceAttachmentsMatch(message([file]), [], { partial: true }), []);
  assert.throws(() => sourceAttachmentMetadata(Array(11).fill(metadata)), { code: 'attachment-limit' });
});

test('attachment capability requires explicit Source support and complete local/remote read-write seams', () => {
  const store = { readImage() {}, readFileStream() {}, saveImages() {}, saveFile() {} };
  const ctx = { get: () => store }, transport = { upload() {}, attachment() {} };
  assert.equal(relayAttachmentsAvailable(ctx, transport, { attachments: true }), true);
  assert.equal(relayAttachmentsAvailable(ctx, transport, { attachments: false }), false);
  assert.equal(relayAttachmentsAvailable({ get: () => undefined }, transport, { attachments: true }), false);
  assert.equal(relayAttachmentsAvailable(ctx, { upload() {} }, { attachments: true }), false);
  assert.equal(relayAttachmentsAvailable({ get: () => ({ ...store, readFileStream: undefined }) }, transport, { attachments: true }), false);
});

test('real native Controller uploads bytes through new Source receipts and restores into an empty native store', {
  skip: !process.env.DSH_NATIVE_SDK && 'Set DSH_NATIVE_SDK for actual RC.1 attachment integration proof',
}, async () => {
  const { runAttachmentProof } = await import('../experiments/native-relay/attachments-proof.mjs');
  const result = await runAttachmentProof();
  assert.equal(result.actualController, true);
  assert.equal(result.actualFileUploads, true);
  assert.equal(result.actualSourceAttachmentStore, true);
  assert.equal(result.fileOnlySubmission, true);
  assert.equal(result.realWorkerPathsReadExactBytes, true);
  assert.equal(result.emptyNativeStoreRestoredSourceBytes, true);
  assert.equal(result.missingLocalUnknownRefsNeverPublished, true);
  assert.equal(result.failedReadsNeverInventRefs, true);
  assert.equal(result.unknownUploadNotReplayed, true);
  assert.equal(result.counts.llm, 0);
  assert.equal(result.counts.modelInfo, 0);
  assert.equal(result.counts.submits, 1);
});
