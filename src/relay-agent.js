import { createHash } from 'node:crypto';
import { SourceRelayError } from './relay-errors.js';
import { createRelayWorld } from './relay-world.js';
import { admittedAttachmentParts, attachmentSignature, relayAttachmentsAvailable, assertSourceAttachmentsMatch,
  sourceAttachmentMetadata, readAdmittedAttachments, uploadAdmittedAttachments, restoreSourceUserMessage } from './relay-attachments.js';
export { SourceRelayError } from './relay-errors.js';

export const RELAY_EVENT = 'superagent/source';
export const RELAY_STATE_EVENT = 'superagent/relay';
// Source v1 validateMessage protocol uses JavaScript string.length (UTF-16 code units).
// Enforce only for NEW admission, not for reading/reconciling existing durable drafts.
export const RELAY_TEXT_MAX_CHARS = 12_000;
const PREFIX = 'superagent-source-';
const STATES = new Set(['queued', 'unknown', 'accepted', 'canceled']);

const fail = (code, message) => { throw new SourceRelayError(code, message); };
const copy = value => JSON.parse(JSON.stringify(value));
const isPromise = value => value && typeof value.then === 'function';

/** Source identities cannot collide with an ordinary, caller-supplied Session id. */
export function relaySessionId(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 512
    || conversationId.trim() !== conversationId || /[\u0000-\u001f]/u.test(conversationId)) {
    fail('invalid-conversation', 'A canonical Source conversationId is required');
  }
  return `${PREFIX}${createHash('sha256').update(conversationId).digest('hex')}`;
}

/** Canonical Source id; keep the original rpcId on the human message for native echo. */
export function relayRequestId(nativeId) {
  if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 512) fail('invalid-request-id', 'Invalid native request identity');
  return createHash('sha256').update(`native-input\0${nativeId}`).digest('hex');
}

function input(message) {
  if (!message || message.role !== 'user' || typeof message.id !== 'string' || !message.id
    || message.source?.kind !== 'user' || !Array.isArray(message.content)) {
    fail('unsupported-input', 'Source requires a Controller-admitted human message');
  }
  const attachments = admittedAttachmentParts(message);
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
  if (!text && !attachments.length) fail('empty-input', 'A non-empty Source request or real attachment is required');
  const requestId = relayRequestId(message.source.rpcId ?? message.id);
  return { requestId, text, message: copy(message), attachmentSignature: attachmentSignature(attachments) };
}

/**
 * A genuine structural Agent, never an AgentLoop or a model/provider alias.
 * Outbox.save is a synchronous durability barrier BEFORE native admission.
 * Recovered/uncertain requests are only reconciled: no automatic resend.
 */
class SourceRelayAgent {
  constructor(ctx, options) {
    this.id = relaySessionId(options.conversationId);
    this.conversationId = options.conversationId;
    this.transport = options.transport;
    this.outbox = options.outbox;
    this.options = Object.freeze({});
    this.model = Object.freeze({
      current: () => undefined,
      select: () => fail('unsupported-model-selection', 'Models are owned by the real SuperAgent, not this relay'),
    });
    this.requests = new Map();
    this.lists = { 'next-turn': [], 'next-step': [] };
    this.capabilities = Object.freeze({});
    this.executions = [];
    this.cursor = 0;
    this.observed = new Map();
    this.humanMessages = new Set();
    this.localBusy = 0;
    this.remoteRunning = false;
    this.ready = false;
    this.closed = false;
    this.abort = new AbortController();
    this.waiters = new Set();
    this.pumping = undefined;
    this.refreshing = undefined;
    this.maintenance = undefined;
    this.controlPending = undefined;
    this.lastError = undefined;
    this.load();
    const self = this;
    this.inbox = Object.freeze({
      get nextTurn() { return Object.freeze([...self.lists['next-turn']]); },
      get nextStep() { return Object.freeze([...self.lists['next-step']]); },
      clear() { self.clearQueued(); },
      append(target, message) { self.send(message, target, false); },
      prepend(target, message) { self.enqueue(message, target, 0); },
      replace(id, message) { return self.replaceQueued(id, message); },
      remove(id) { return self.removeQueued(id); },
      splice(target, start, count, inserted) { return self.spliceQueued(target, start, count, inserted); },
    });
    this.ownerCtx = ctx;
  }
  get status() { return this.localBusy > 0 || this.remoteRunning ? 'running' : 'idle'; }
  setCapabilities(value) {
    this.capabilities = Object.freeze({ ...value, steer: false, modelSelection: false, permissionSelection: false,
      attachments: relayAttachmentsAvailable(this.ctx, this.transport, value) });
  }
  assertOpen() { if (this.closed) fail('relay-disposed', 'Source relay is unloaded; no ordinary Agent fallback is permitted'); }
  load() {
    if (!this.outbox) return;
    if (typeof this.outbox.load !== 'function' || typeof this.outbox.save !== 'function') fail('outbox-required', 'Outbox requires synchronous load/save');
    const state = this.outbox.load();
    if (isPromise(state)) fail('outbox-not-synchronous', 'Outbox.load must be synchronous');
    if (state === undefined || state === null) return;
    if (state.version !== 1 || state.conversationId !== this.conversationId || !Array.isArray(state.requests)) fail('outbox-corrupt', 'Outbox identity/version mismatch');
    for (const item of state.requests) {
      const parsed = input(item.message);
      // V1 outboxes written before Source normalization retained outer whitespace.
      // Normalize that legacy field too, while keeping the original native message intact.
      if (!STATES.has(item.state) || parsed.requestId !== item.requestId || typeof item.text !== 'string'
        || parsed.text !== item.text.trim() || this.requests.has(item.requestId)) fail('outbox-corrupt', 'Invalid or duplicate outbox request');
      const sourceAttachments = item.sourceAttachments === undefined ? undefined
        : assertSourceAttachmentsMatch(parsed.message, item.sourceAttachments, { partial: true });
      this.requests.set(item.requestId, { ...parsed, state: item.state === 'queued' ? 'unknown' : item.state,
        ...(sourceAttachments === undefined ? {} : { sourceAttachments }) });
    }
    // A crash can occur after handoff and before an acknowledgement. Never wake restored work.
    this.persist(this.requests);
  }
  persist(requests) {
    if (!this.outbox) fail('outbox-required', 'Sending requires a synchronous durable outbox; draft was not accepted');
    const result = this.outbox.save({ version: 1, conversationId: this.conversationId, requests: copy([...requests.values()]) });
    if (isPromise(result)) fail('outbox-not-synchronous', 'Outbox.save must complete durability synchronously');
  }
  transition(requestId, state, patch = {}) {
    const previous = this.requests.get(requestId);
    const next = new Map(this.requests);
    next.set(requestId, { ...previous, ...patch, state });
    this.persist(next);
    this.requests = next;
  }
  notify(name, payload) { if (!this.closed) this.dispatch.emit(name, payload); }
  updateStatus(operation) {
    const before = this.status;
    const result = operation();
    if (this.status !== before) this.notify('agent/status', { status: this.status });
    if (this.status === 'idle' && !this.maintenance) { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
    return result;
  }
  record(data) { if (!this.closed) this.session.append(RELAY_STATE_EVENT, { customSource: 'superagent', conversationId: this.conversationId, ...copy(data) }); }
  human(message, key) {
    if (this.humanMessages.has(key)) return;
    this.session.append('user/message', message, { surfaceOp: 'append' });
    this.humanMessages.add(key);
  }
  async restoreDrafts() {
    for (const request of this.requests.values()) {
      if (request.state === 'unknown') {
        let readable = true;
        if (admittedAttachmentParts(request.message).length) {
          try { await readAdmittedAttachments(this, request.message, { signal: this.abort.signal }); }
          catch (error) { readable = false; if (!this.closed) this.error(error, 'restore-local-attachments'); }
        }
        if (this.closed) return;
        // A prior genuine ref is not proof that its bytes exist in this host's store now.
        // Missing local objects remain uncertain; confirmed Source history can re-import them.
        if (readable) this.human(request.message, request.requestId);
        this.record({ operation: 'submit', requestId: request.requestId, outcome: 'unknown', recovered: true, attachmentsReadable: readable });
      }
      // Confirmed history is reconstructed ONLY from Source, never the local outbox.
    }
  }
  error(error, operation) {
    this.lastError = error;
    this.record({ operation, outcome: 'unavailable',
      code: error instanceof SourceRelayError ? error.code : 'transport-error',
      message: error instanceof SourceRelayError ? error.message : 'Source transport failed; outcome may be unknown. Reconcile before retrying.',
    });
  }
  queueEvent(target, start, removedCount, inserted, canceled = false) {
    this.session.append('agent/inbox/spliced', { target, start, removedCount, inserted, ...(canceled ? { outcome: 'canceled' } : {}) });
    this.lists[target].splice(start, removedCount, ...inserted);
    for (const message of inserted) this.notify('agent/inbox/inserted', { message });
  }
  enqueue(message, target, position = Infinity) {
    this.assertOpen();
    if (!['next-turn', 'next-step'].includes(target)) fail('invalid-inbox', 'Invalid inbox target');
    if (this.capabilities.submit !== true) fail('source-unavailable', 'Source submission is unavailable');
    if (target === 'next-step' && this.status === 'running') fail('unsupported-steer', 'Source cannot steer a worker step; queue a follow-up instead');
    const parsed = input(message);
    const existing = this.requests.get(parsed.requestId);
    if (existing) {
      if (existing.text !== parsed.text || existing.attachmentSignature !== parsed.attachmentSignature) {
        fail('request-id-conflict', 'Request identity is already bound to different text or ordered attachments');
      }
      return; // accepted, queued and UNKNOWN all prohibit resubmission.
    }
    this.spliceQueued(target, position, 0, [parsed.message]); // Durable before Controller/InputHub success.
    this.record({ operation: 'submit', requestId: parsed.requestId, outcome: 'queued' });
  }
  send(message, target, wakeup) { this.enqueue(message, target); if (wakeup) this.wake(); }
  followup(message) { this.send(message, 'next-turn', true); }
  steer(message) { this.send(message, 'next-step', true); }
  inject() { fail('unsupported-context', 'Source relay does not accept model-facing injected context'); }
  removeQueued(id) {
    this.assertOpen();
    for (const target of ['next-turn', 'next-step']) {
      const index = this.lists[target].findIndex(message => message.id === id);
      if (index >= 0) { this.spliceQueued(target, index, 1, []); return true; }
    }
    return false;
  }
  clearQueued() {
    this.spliceQueued('next-step', 0, Infinity, []);
    this.spliceQueued('next-turn', 0, Infinity, []);
  }
  replaceQueued(id, message) {
    this.assertOpen();
    for (const target of ['next-turn', 'next-step']) {
      const index = this.lists[target].findIndex(item => item.id === id);
      if (index >= 0) { this.spliceQueued(target, index, 1, [message]); return true; }
    }
    return false;
  }
  spliceQueued(target, start, count, inserted) {
    this.assertOpen();
    if (!['next-turn', 'next-step'].includes(target) || !Array.isArray(inserted)) fail('invalid-inbox', 'Invalid inbox splice');
    if (inserted.length && this.capabilities.submit !== true) fail('source-unavailable', 'Source submission is unavailable');
    const list = this.lists[target];
    const offset = Number.isNaN(Math.trunc(start)) ? 0 : Math.trunc(start);
    const normalized = offset < 0 ? Math.max(list.length + offset, 0) : Math.min(offset, list.length);
    const countValue = Number.isNaN(Math.trunc(count)) ? 0 : Math.trunc(count);
    const removedCount = Math.min(Math.max(countValue, 0), list.length - normalized);
    if (!removedCount && !inserted.length) return [];
    const removed = list.slice(normalized, normalized + removedCount);
    const parsed = inserted.map(input);
    if (parsed.some(item => item.text.length > RELAY_TEXT_MAX_CHARS)) {
      fail('input-too-long', `Source messages support at most ${RELAY_TEXT_MAX_CHARS} characters; the draft was not accepted`);
    }
    if (!this.capabilities.attachments && parsed.some(item => admittedAttachmentParts(item.message).length > 0)) {
      fail('unsupported-attachments', 'Source attachments require verified native storage and cross-host upload/read transport');
    }
    const candidate = list.toSpliced(normalized, removedCount, ...parsed.map(item => item.message));
    const other = this.lists[target === 'next-turn' ? 'next-step' : 'next-turn'];
    const ids = new Set(), requestIds = new Set();
    for (const message of [...candidate, ...other]) {
      const requestId = input(message).requestId;
      if (ids.has(message.id) || requestIds.has(requestId)) fail('duplicate-pending-input', 'Message/request identity is already pending');
      ids.add(message.id); requestIds.add(requestId);
    }
    const removedRequests = new Set(removed.map(message => input(message).requestId));
    const next = new Map(this.requests);
    for (const message of removed) next.set(input(message).requestId, { ...next.get(input(message).requestId), state: 'canceled' });
    for (const item of parsed) {
      if (this.requests.has(item.requestId) && !removedRequests.has(item.requestId)) fail('request-id-conflict', 'Cannot reinsert a known or uncertain request');
      next.set(item.requestId, { ...item, state: 'queued' });
    }
    this.persist(next); this.requests = next;
    this.queueEvent(target, normalized, removedCount, parsed.map(item => item.message), removedCount > 0);
    for (const message of removed) this.notify('agent/inbox/discarded', { message });
    return removed;
  }
  wake() {
    if (this.closed) return;
    if (!this.ready || this.pumping || this.maintenance) { this.wakeRequested = true; return; }
    this.wakeRequested = false;
    this.updateStatus(() => { this.localBusy += 1; });
    this.pumping = Promise.resolve().then(() => this.pump()).catch(error => { if (!this.closed) this.error(error, 'submit'); }).finally(() => {
      this.pumping = undefined;
      const replacement = this.wakeRequested && this.lists['next-turn'].length + this.lists['next-step'].length > 0;
      this.wakeRequested = false;
      if (replacement) this.wake(); // Claim replacement BEFORE resolving old whenIdle waiters.
      this.updateStatus(() => { this.localBusy -= 1; });
    });
  }
  async pump() {
    while (!this.closed) {
      const target = this.lists['next-step'].length ? 'next-step' : 'next-turn';
      const message = this.lists[target][0];
      if (!message) break;
      const parsed = input(message);
      this.transition(parsed.requestId, 'unknown'); // Durable BEFORE any side effect, including a timeout.
      this.human(parsed.message, parsed.requestId); // True human input also settles InputHub's identified echo.
      this.queueEvent(target, 0, 1, []);
      this.record({ operation: 'submit', requestId: parsed.requestId, outcome: 'unknown' });
      try {
        const sourceAttachments = await uploadAdmittedAttachments(this, parsed, { signal: this.abort.signal,
          onUploaded: metadata => this.transition(parsed.requestId, 'unknown', { sourceAttachments: metadata }) });
        if (this.closed) return;
        const ack = await this.transport.submit({ conversationId: this.conversationId, text: parsed.text, requestId: parsed.requestId,
          ...(sourceAttachments.length ? { attachments: sourceAttachments.map(item => item.receipt) } : {}) }, { signal: this.abort.signal });
        if (this.closed) return;
        if (ack?.accepted !== true || ack.conversationId !== this.conversationId || ack.requestId !== parsed.requestId) fail('invalid-ack', 'Source did not acknowledge this exact request');
        this.transition(parsed.requestId, 'accepted');
        this.record({ operation: 'submit', requestId: parsed.requestId, outcome: 'accepted', receipt: ack });
      } catch (error) {
        if (this.closed) return;
        this.error(error, 'submit'); // Unknown stays immutable and is NEVER retried by this driver.
      }
      await this.refresh().catch(error => { if (!this.closed) this.error(error, 'snapshot'); });
    }
  }
  refresh() {
    this.assertOpen();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.observe().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  async observe() {
    let pages = 0;
    do {
      const snapshot = await this.transport.snapshot(this.conversationId, { afterSeq: this.cursor, limit: 200 }, { signal: this.abort.signal });
      if (this.closed) return;
      if (snapshot?.version !== 1 || snapshot.conversationId !== this.conversationId || !Array.isArray(snapshot.events)) fail('invalid-snapshot', 'Source snapshot identity/version mismatch');
      if (snapshot.capabilities) this.setCapabilities(snapshot.capabilities);
      let advanced = false;
      for (const event of snapshot.events) {
        if (event.conversationId !== this.conversationId || !Number.isSafeInteger(event.seq) || event.seq <= 0
          || typeof event.id !== 'string' || !event.id || !['user', 'assistant'].includes(event.role)
          || typeof event.text !== 'string' || typeof event.kind !== 'string') fail('invalid-source-event', 'Invalid Source observation');
        const fingerprint = JSON.stringify(event);
        if (event.seq <= this.cursor) {
          if (this.observed.get(event.seq) !== fingerprint) fail('source-history-conflict', 'Source sequence was rewritten');
          continue;
        }
        if (event.seq !== this.cursor + 1) fail('source-history-gap', 'Source history must begin at seq 1 and remain contiguous; bounded trace is a separate view');
        const request = event.role === 'user' && event.requestId ? this.requests.get(event.requestId) : undefined;
        if (event.textDigest !== undefined && (typeof event.textDigest !== 'string' || !/^[a-f0-9]{64}$/iu.test(event.textDigest))) {
          fail('invalid-source-event', 'Source text digest must be a SHA-256 hex value');
        }
        if (request) {
          // Source text is a redacted presentation; digest binds the original normalized input.
          const matches = event.textDigest === undefined ? request.text === event.text
            : createHash('sha256').update(request.text).digest('hex') === event.textDigest.toLowerCase();
          if (!matches) fail('request-id-conflict', 'Source receipt disagrees with the durable normalized draft');
        }
        const attachments = sourceAttachmentMetadata(event.attachments);
        if (request) assertSourceAttachmentsMatch(request.message, attachments);
        const humanKey = event.requestId ?? event.id;
        const humanMessage = event.role === 'user' && !this.humanMessages.has(humanKey)
          ? await restoreSourceUserMessage(this, event, request, { signal: this.abort.signal }) : undefined;
        if (this.closed) return;
        // Required, log-only owner event: never model/provider/assistant/stream/step facts.
        this.session.append(RELAY_EVENT, { customSource: 'superagent', conversationId: this.conversationId, event: copy(event) });
        this.observed.set(event.seq, fingerprint); this.cursor = event.seq; advanced = true;
        if (event.role === 'user') {
          if (humanMessage) this.human(humanMessage, humanKey);
          if (request && request.state !== 'accepted') this.transition(event.requestId, 'accepted',
            attachments.length ? { sourceAttachments: attachments } : {});
        }
      }
      this.executions = copy(snapshot.executions ?? snapshot.activeAssignments?.map(item => ({ ...item, state: 'running', actions: { interrupt: true } })) ?? []);
      this.updateStatus(() => {
        const sourceBusy = snapshot.state === 'running' || snapshot.state === 'pending';
        const executionBusy = this.executions.some(item => item.state === 'running' || item.state === 'pending'
          || item.state === 'paused' && item.interruption !== 'settled');
        const unconfirmedPause = snapshot.state === 'paused' && snapshot.interruption !== 'settled'
          && !this.executions.some(item => item.state === 'paused' && item.interruption === 'settled');
        this.remoteRunning = sourceBusy || executionBusy || unconfirmedPause;
      });
      if (!snapshot.hasMore) break;
      if (!advanced || ++pages >= 100) fail('source-history-budget', 'Source history could not converge within the page budget');
    } while (!this.closed);
  }
  interrupt(selection) { return this.control('interrupt', selection); }
  resume(selection) { return this.control('resume', selection); }
  control(action, selection) {
    this.assertOpen();
    if (this.controlPending) fail('control-pending', 'A Source control already has an unresolved result');
    if (this.capabilities[action] !== true) fail('unsupported-control', `Source ${action} is unavailable`);
    const candidates = this.executions.filter(item => item.actions?.[action] === true
      && (selection === undefined || item.ticketId === selection.ticketId && item.assignmentId === selection.expectedAssignmentId
        && (selection.expectedControlSeq === undefined || item.controlSeq === selection.expectedControlSeq)));
    if (candidates.length !== 1 || !candidates[0].assignmentId || !Number.isSafeInteger(candidates[0].controlSeq)
      || candidates[0].controlSeq < 0) fail('needs-selection', 'Choose one exact current Source ticket/assignment/control sequence; nothing was interrupted');
    const selected = candidates[0];
    this.updateStatus(() => { this.localBusy += 1; });
    const request = { conversationId: this.conversationId, ticketId: selected.ticketId, expectedAssignmentId: selected.assignmentId, expectedControlSeq: selected.controlSeq, action };
    this.controlPending = Promise.resolve().then(() => this.transport.control(request, { signal: this.abort.signal })).then(async result => {
      if (this.closed) return;
      this.record({ operation: action, outcome: 'acknowledged', ticketId: selected.ticketId, assignmentId: selected.assignmentId, result });
      await this.refresh();
      return result;
    }).catch(error => { if (!this.closed) this.error(error, action); throw error; }).finally(() => {
      this.controlPending = undefined;
      this.updateStatus(() => { this.localBusy -= 1; });
    });
    return this.controlPending;
  }
  cancel(cause, options = {}) {
    this.assertOpen();
    if (cause?.kind === 'disposed') { this.stopLocal(); return; }
    if (cause?.kind !== 'user') fail('unsupported-cancel', 'Only an explicit user Stop may interrupt the real Source');
    if (this.maintenance) this.maintenance.abort.abort(cause);
    if (!options.keepInbox) this.clearQueued();
    if (this.status === 'idle') return;
    // Synchronous preflight rejects ambiguous/unavailable Stop instead of acknowledging it.
    // cancel is void in the public contract; subsequent transport failures are owner events.
    void this.interrupt().catch(() => {});
  }
  whenIdle() {
    if (this.closed || this.status === 'idle' && !this.maintenance) return Promise.resolve();
    return new Promise(resolve => this.waiters.add(resolve));
  }
  runMaintenance(task) {
    this.assertOpen();
    if (this.status !== 'idle' || this.maintenance) fail('agent-busy', 'Relay is not idle');
    const abort = new AbortController();
    this.maintenance = { abort };
    let operation;
    try { operation = task(abort.signal); } catch (error) { operation = Promise.reject(error); }
    return Promise.resolve(operation).finally(() => {
      this.maintenance = undefined;
      if (!this.closed && this.lists['next-turn'].length + this.lists['next-step'].length) this.wake();
      if (this.status === 'idle' && !this.maintenance) { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
    });
  }
  stopLocal() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    clearTimeout(this.timer);
    this.abort.abort(new SourceRelayError('relay-disposed', 'Local observer disposed; backend tickets are unchanged'));
    this.maintenance?.abort.abort({ kind: 'disposed' });
    for (const resolve of this.waiters) resolve(); this.waiters.clear();
    // DO NOT call transport.control here. Unload is not a user's Stop.
  }
  poll(ms) {
    if (!ms || this.closed) return;
    this.timer = setTimeout(async () => {
      try { await this.refresh(); } catch (error) { if (!this.closed) this.error(error, 'snapshot'); }
      this.poll(ms);
    }, ms);
    this.timer.unref?.();
  }
}

/** Exact structural driver identity, not a label/preset that an ordinary Loop can imitate. */
export function isSourceRelayAgent(agent) { return agent instanceof SourceRelayAgent; }

/**
 * Mount before exposing Source sessions. AgentRegistry/AgentLoop await this official
 * serial publication seam before releasing queued input; a refusal rolls the factory back.
 * Guard only Source identities/lineage, never ordinary Agents. Native fork currently
 * omits parentSession, so also recognize the inherited required Source owner marker.
 */
export function installSourceRelayGuards(ctx) {
  return ctx.on('agent/created', ({ agent }) => {
    if (isSourceRelayAgent(agent)) return;
    const header = agent.session.header;
    const sourceId = id => typeof id === 'string' && id.startsWith(PREFIX);
    const inheritsSource = header.isSeeded && agent.session.snapshotEvents(0, 1).some(event =>
      (event.type === RELAY_STATE_EVENT || event.type === RELAY_EVENT) && event.data?.customSource === 'superagent');
    if (sourceId(agent.id) || sourceId(header.parentSession) || inheritsSource) {
      fail('ordinary-source-fallback-forbidden', 'Source sessions and their forks cannot run an ordinary Agent driver');
    }
  }, { global: true, prepend: true });
}

/**
 * Create an ephemeral, real SessionStore+AgentRegistry facade over durable Source history.
 * No SessionPersistence writer is opened. A cold Controller request therefore cannot
 * resume it through the ordinary factory; re-open this module to reconstruct from Source.
 * SDK imports are public host exports, lazy so pure contract tests need no DSH install.
 */
export async function createSourceRelay(ctx, options) {
  const { conversationId, cwd, transport, outbox, pollMs = 1000 } = options;
  const id = relaySessionId(conversationId);
  if (!transport || ['capabilities', 'snapshot', 'submit', 'control'].some(key => typeof transport[key] !== 'function')) fail('invalid-transport', 'Source transport requires capabilities/snapshot/submit/control');
  if (!Number.isSafeInteger(pollMs) || pollMs < 0) fail('invalid-poll', 'pollMs must be a nonnegative safe integer');
  if (ctx.sessions.get(id) || ctx.agents.get(id)) fail('relay-already-open', 'Source conversation already has a live native facade');
  const persistence = ctx.get?.('sessionPersistence');
  if (persistence && await persistence.stat(id)) fail('unsafe-persistence-collision', 'A persisted Session already uses the reserved Source identity');
  const { loadRelaySdk } = await import('./relay-sdk.js');
  const sdk = await loadRelaySdk(ctx, options.sdk);
  let agent, world, lifecycle, disposed = false;
  try {
    lifecycle = ctx.effect(async function* () {
      world = createRelayWorld(ctx, async worldCtx => {
        if (disposed) fail('relay-disposed', 'Source relay owner is unloaded');
        const created = new SourceRelayAgent(worldCtx, { conversationId, transport, outbox });
        agent = created;
        let inner;
        try {
          inner = worldCtx.effect(async function* () {
            const scope = sdk.createScope(worldCtx, created);
            created.ctx = scope.ctx;
            created.dispatch = sdk.agentEvents(created.ctx, created);
            yield scope.rawDispose;
            const session = created.ctx.sessions.prepare(id, { meta: { cwd } });
            created.session = session;
            yield created.ctx.sessions.enter(session);
            created.ctx.sessions.announce(session);
            created.record({ operation: 'open', outcome: 'source-backed', version: 1 });
            yield () => created.stopLocal();
            await created.restoreDrafts();
            const capabilities = await transport.capabilities({ signal: created.abort.signal });
            created.setCapabilities(capabilities);
            await created.refresh();
            // Exact disposers preserve stop -> unregister -> Session detach -> scope teardown.
            yield await created.ctx.agents.register(created);
            yield () => created.stopLocal();
            created.ready = true;
            if (created.wakeRequested && created.lists['next-turn'].length + created.lists['next-step'].length) created.wake();
            created.poll(pollMs);
          }, `superagent.sourceRelayScope(${id})`);
          await inner;
        } catch (error) {
          created.stopLocal();
          await inner?.();
          throw error;
        }
      });
      yield world.dispose;
      await world.await();
    }, `superagent.sourceRelay(${id})`);
    await lifecycle;
  } catch (error) {
    disposed = true;
    agent?.stopLocal();
    await lifecycle?.();
    throw error;
  }
  const current = () => {
    if (disposed || !agent?.ready || agent.closed) fail('relay-world-unavailable', 'Source Agent world is unavailable; no ordinary fallback is permitted');
    return agent;
  };
  let disposal;
  return Object.freeze({
    // Dependency replacement rebuilds only this Source facade from its durable authority.
    get agent() { return agent; }, sessionId: id,
    get active() { return !disposed && !!agent?.ready && !agent.closed; },
    whenReady: async () => { await world.await(); return current(); },
    refresh: () => current().refresh(),
    interrupt: selection => current().interrupt(selection),
    resume: selection => current().resume(selection),
    get capabilities() { return !disposed && agent && !agent.closed ? agent.capabilities
      : Object.freeze({ ...agent?.capabilities, submit: false, attachments: false, interrupt: false, resume: false }); },
    get outboxState() { return copy([...(agent?.requests.values() ?? [])]); },
    dispose: () => disposal ??= (async () => { disposed = true; agent?.stopLocal(); await lifecycle(); })(),
  });
}
