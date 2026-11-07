import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createSourceRelay, relaySessionId, relayRequestId, installSourceRelayGuards, RELAY_EVENT } from '../src/relay-agent.js';

const sdkRoot = process.env.DSH_NATIVE_SDK;
const sdkTest = (name, fn) => test(name, { skip: !sdkRoot && 'Set DSH_NATIVE_SDK to the installed @deepseek-ai directory for actual RC.1 integration' }, fn);
let modules;
async function actualSdk() {
  return modules ??= (async () => {
    const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(sdkRoot, name, file)).href);
    const [cordis, session, agent, projection, query, scope, controller, commands] = await Promise.all([
      load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-session-projection'), load('dsh-session-query'), load('dsh-scope'),
      load('dsh-api-session-controller', 'lib/types/agent.js'), load('dsh-api-session-controller', 'lib/types/commands.js'),
    ]);
    return { ...cordis, ...session, ...agent, ...projection, ...query, ...scope, ...controller, ...commands };
  })();
}
const message = (id, text = id) => ({ id: `message-${id}`, role: 'user', source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text }] });
const capabilities = { version: 1, submit: true, interrupt: true, resume: true };
const deferred = () => Promise.withResolvers();
async function harness(t, overrides = {}) {
  const sdk = await actualSdk();
  const ctx = new sdk.Context();
  await ctx.plugin(sdk.SessionStore);
  await ctx.plugin(sdk.SessionProjectionRegistry);
  await ctx.plugin(sdk.AgentRegistry);
  await ctx.plugin(sdk.SessionQueryEngine);
  let ordinaryCalls = 0;
  const removeFactory = ctx.agents.setFactory({ createAgent() { ordinaryCalls++; throw Error('ordinary create forbidden'); }, resume() { ordinaryCalls++; throw Error('ordinary resume forbidden'); } });
  const events = [];
  const controls = [];
  const submitted = [];
  let executions = [];
  let saved;
  const outbox = overrides.outbox ?? { load: () => structuredClone(saved), save: state => { saved = structuredClone(state); } };
  const transport = {
    capabilities: async () => capabilities,
    snapshot: async (conversationId, cursor) => ({ version: 1, conversationId, events: events.filter(event => event.seq > cursor.afterSeq), executions, hasMore: false }),
    submit: async request => { submitted.push(request); return { accepted: true, ...request }; },
    control: async request => { controls.push(request); return { accepted: true }; },
    ...overrides.transport,
  };
  const controller = new sdk.ApiSessionAgentController(ctx);
  const relays = [];
  const owners = [];
  const cwd = process.platform === 'win32' ? 'C:\\relay-proof' : '/relay-proof';
  const open = async (options = {}) => {
    let relay;
    const owner = await ctx.plugin({ inject: ['sessions', 'agents'], async apply(ownerCtx) {
      relay = await createSourceRelay(ownerCtx, { conversationId: 'main', cwd, transport, outbox, pollMs: 0, sdk, ...options });
    } });
    // Cordis records startup failure on the fiber; expose it as test failure instead of returning undefined.
    if (!relay) { await owner.dispose(); throw Error('Relay owner failed to initialize'); }
    owners.push(owner); relays.push(relay);
    return { relay, owner };
  };
  t.after(async () => { for (const relay of relays) await relay.dispose(); for (const owner of owners) await owner.dispose(); await ctx.fiber.dispose(); });
  return { ctx, sdk, open, outbox, transport, events, submitted, controls, controller, removeFactory,
    get ordinaryCalls() { return ordinaryCalls; }, get saved() { return saved; },
    set executions(value) { executions = value; } };
}

test('Source Session identity is stable, prefixed, collision-free and rejects noncanonical values', () => {
  assert.match(relaySessionId('main'), /^superagent-source-[a-f0-9]{64}$/u);
  assert.equal(relaySessionId('main'), relaySessionId('main'));
  assert.notEqual(relaySessionId('main'), relaySessionId('Main'));
  assert.notEqual(relaySessionId('a:b'), relaySessionId('a/b'));
  assert.match(relayRequestId('short / native id:✓'), /^[a-zA-Z0-9_-]{16,100}$/u);
  assert.equal(relayRequestId('short / native id:✓'), relayRequestId('short / native id:✓'));
  for (const value of ['', ' main', 'main ', '\nmain', null, 'x'.repeat(513)]) assert.throws(() => relaySessionId(value));
});

sdkTest('native admission is synchronous-durable; unknown acknowledgement is never resent on refresh/reload', async t => {
  const h = await harness(t, { transport: { submit: async request => { h.submitted.push(request); throw Error('connection lost; acceptance unknown'); } } });
  const { relay, owner } = await h.open();
  relay.agent.followup(message('request-unknown-0001', 'keep this exact draft'));
  assert.equal(h.saved.requests[0].state, 'queued', 'barrier committed before followup returns');
  await relay.agent.pumping;
  assert.equal(h.saved.requests[0].state, 'unknown');
  assert.equal(h.submitted[0].requestId, relayRequestId('request-unknown-0001'));
  assert.equal(h.saved.requests[0].message.source.rpcId, 'request-unknown-0001');
  assert.equal(h.submitted.length, 1);
  assert.equal(relay.outboxState[0].message.content[0].text, 'keep this exact draft');
  relay.agent.followup(message('request-unknown-0001', 'keep this exact draft'));
  await relay.agent.pumping;
  await relay.refresh();
  assert.equal(h.submitted.length, 1);
  assert.throws(() => relay.agent.followup(message('request-unknown-0001', 'different text')), { code: 'request-id-conflict' });
  await owner.dispose();
  assert.equal(h.ctx.sessions.get(relay.sessionId), undefined);
  const cold = await h.controller.resolveAgent(relay.sessionId);
  assert.equal(cold.error.code, 'session/not-found');
  assert.equal(h.ordinaryCalls, 0);
  const { relay: restored } = await h.open();
  await restored.refresh();
  assert.equal(h.submitted.length, 1, 'restoration must only reconcile');
  assert.equal(restored.outboxState[0].state, 'unknown');
  h.events.push({ seq: 1, id: 'source-user-1', role: 'user', kind: 'request', conversationId: 'main', requestId: relayRequestId('request-unknown-0001'), text: 'keep this exact draft', at: 1 });
  h.events.push({ seq: 2, id: 'source-answer-2', role: 'assistant', kind: 'answer', conversationId: 'main', text: 'actual Source delivery', at: 2, ticketId: 'ticket-1' });
  await restored.refresh();
  assert.equal(restored.outboxState[0].state, 'accepted');
  const journal = restored.agent.session.snapshotEvents();
  assert.equal(journal.filter(event => event.type === 'user/message').length, 1, 'reconciliation cannot duplicate human echo');
  assert.equal(journal.filter(event => event.type === RELAY_EVENT).length, 2);
  assert(!journal.some(event => /^(assistant|model|request|step|turn|tool)\//u.test(event.type)));
  assert.deepEqual(restored.agent.session.deriveMessages().map(item => item.role), ['user']);
});

sdkTest('regression: coordinator pending and unsettled interruption cannot settle native running/whenIdle', async t => {
  let snapshot = { state: 'pending', executions: [] };
  const h = await harness(t, { transport: { snapshot: async conversationId => ({ version: 1, conversationId, events: [], hasMore: false, ...snapshot }) } });
  const { relay } = await h.open();
  assert.equal(relay.agent.status, 'running', 'a Source request awaiting coordinator admission is still pending');
  let idleSettled = false;
  const idle = relay.agent.whenIdle().then(() => { idleSettled = true; });
  for (const interruption of ['requested', 'failed', undefined]) {
    snapshot = { state: 'paused', executions: [{ ticketId: 'ticket-1', assignmentId: 'assignment-1', state: 'paused', interruption, actions: { interrupt: false, resume: false } }] };
    await relay.refresh();
    assert.equal(relay.agent.status, 'running', `${interruption ?? 'missing'} interruption confirmation is not a settled Stop`);
    assert.equal(idleSettled, false);
  }
  snapshot = { state: 'paused', executions: [{ ticketId: 'ticket-1', assignmentId: 'assignment-1', state: 'paused', interruption: 'settled', actions: { interrupt: false, resume: true } }] };
  await relay.refresh();
  await idle;
  assert.equal(relay.agent.status, 'idle');
  assert.equal(idleSettled, true);
  assert.equal(h.controls.length, 0, 'observing pending state must not issue another Stop');
});

sdkTest('regression: Source trims submission while native echo preserves the exact human draft', async t => {
  const text = '  request with leading/trailing whitespace \n';
  const h = await harness(t, { transport: { submit: async request => {
    h.submitted.push(request);
    h.events.push({ seq: 1, id: 'trimmed-user', role: 'user', kind: 'request', conversationId: 'main', requestId: request.requestId, text: request.text.trim(), at: 1 });
    throw Error('acknowledgement lost');
  } } });
  const { relay } = await h.open();
  relay.agent.followup(message('request-trim-000001', text));
  await relay.agent.pumping;
  assert.equal(h.submitted[0].text, text.trim());
  assert.equal(relay.outboxState[0].state, 'accepted');
  assert.equal(relay.outboxState[0].text, text.trim());
  assert.equal(relay.agent.session.deriveMessages()[0].content[0].text, text);
  assert.equal(h.submitted.length, 1);
});

sdkTest('regression: Source textDigest reconciles a redacted delivery without weakening legacy identity checks', async t => {
  const text = 'example token=demonstration-value';
  const h = await harness(t, { transport: { submit: async request => {
    h.submitted.push(request);
    h.events.push({ seq: 1, id: 'redacted-user', role: 'user', kind: 'request', conversationId: 'main', requestId: request.requestId,
      text: 'example token=[REDACTED]', textDigest: createHash('sha256').update(request.text).digest('hex'), at: 1 });
    throw Error('acknowledgement lost');
  } } });
  const { relay } = await h.open();
  relay.agent.followup(message('request-digest-0001', text));
  await relay.agent.pumping;
  assert.equal(relay.outboxState[0].state, 'accepted');
  assert.equal(h.submitted.length, 1);
  assert.equal(relay.agent.session.deriveMessages()[0].content[0].text, text);
  const legacy = message('request-legacy-0001', 'legacy draft');
  relay.agent.send(legacy, 'next-turn', false);
  h.events.push({ seq: 2, id: 'legacy-conflict', role: 'user', kind: 'request', conversationId: 'main', requestId: relayRequestId(legacy.source.rpcId), text: 'different legacy text', at: 2 });
  await assert.rejects(relay.refresh(), { code: 'request-id-conflict' });
  h.events[1].textDigest = '0'.repeat(64);
  await assert.rejects(relay.refresh(), { code: 'request-id-conflict' });
  h.events[1].text = 'legacy draft';
  await assert.rejects(relay.refresh(), { code: 'request-id-conflict' }); // Digest, not display text, is authoritative when present.
  h.events[1].textDigest = 'not-a-digest';
  await assert.rejects(relay.refresh(), { code: 'invalid-source-event' });
});

sdkTest('regression: pre-normalization v1 outbox migrates whitespace without losing or replaying an uncertain draft', async t => {
  const raw = '  legacy uncertain draft \n';
  const native = message('request-upgrade-001', raw);
  let state = { version: 1, conversationId: 'main', requests: [{ requestId: relayRequestId(native.source.rpcId), text: raw, message: native, state: 'unknown' }] };
  const h = await harness(t, { outbox: { load: () => structuredClone(state), save: value => { state = structuredClone(value); } } });
  const { relay } = await h.open();
  assert.equal(state.requests[0].text, raw.trim());
  assert.equal(state.requests[0].message.content[0].text, raw);
  assert.equal(relay.outboxState[0].state, 'unknown');
  assert.equal(h.submitted.length, 0);
  h.events.push({ seq: 1, id: 'upgraded-user', role: 'user', kind: 'request', conversationId: 'main', requestId: state.requests[0].requestId, text: raw.trim(), at: 1 });
  await relay.refresh();
  assert.equal(relay.outboxState[0].state, 'accepted');
  assert.equal(h.submitted.length, 0);
});

sdkTest('fresh Native 12000-character admission rejects 12001 before echo, outbox or transport', async t => {
  let uploads = 0;
  const h = await harness(t, { transport: { upload: async () => { uploads++; throw Error('must not upload'); } } });
  h.ctx.provide('attachments', { admitPromptContent: async content => content });
  h.ctx.provide('fileUploads', { bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) });
  const { relay } = await h.open();
  const commands = new h.sdk.SessionCommandController(h.ctx, h.controller);
  const text = 'x'.repeat(12000);
  const accepted = await commands.prompt({ sessionId: relay.sessionId, requestId: 'native-at-limit-0001', mode: 'queue',
    content: [{ type: 'text', text: `  ${text}  ` }] }, { kind: 'user', rpcId: 'native-at-limit-0001' });
  assert.equal(accepted.accepted, true);
  await relay.agent.pumping;
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].text.length, 12000);
  const beforeSeq = relay.agent.session.seq, beforeState = structuredClone(h.saved);
  await assert.rejects(commands.prompt({ sessionId: relay.sessionId, requestId: 'native-over-limit-01', mode: 'queue',
    content: [{ type: 'text', text: 'x'.repeat(12001) }] }, { kind: 'user', rpcId: 'native-over-limit-01' }),
  error => error.code === 'session/agent-busy' && /12000/u.test(error.details?.reason ?? ''));
  assert.equal(relay.agent.session.seq, beforeSeq, 'rejected native admission must not append an inbox splice or echo');
  assert.deepEqual(h.saved, beforeState);
  assert.equal(h.submitted.length, 1);
  assert.equal(uploads, 0);
});

sdkTest('fresh queue batch/replace rejects normalized long text atomically and preserves the prior draft', async t => {
  const h = await harness(t);
  const { relay } = await h.open();
  const existing = message('queue-short-original', 'keep this queued draft');
  relay.agent.send(existing, 'next-turn', false);
  const before = structuredClone(h.saved), beforeSeq = relay.agent.session.seq;
  assert.throws(() => relay.agent.inbox.replace(existing.id, message(existing.source.rpcId, 'y'.repeat(12001))), { code: 'input-too-long' });
  assert.throws(() => relay.agent.inbox.splice('next-turn', Infinity, 0,
    [message('queue-new-short-0001', 'short'), message('queue-new-long-00001', 'z'.repeat(12001))]), { code: 'input-too-long' });
  assert.deepEqual(h.saved, before);
  assert.equal(relay.agent.session.seq, beforeSeq);
  assert.deepEqual(relay.agent.inbox.nextTurn, [existing]);
  assert.equal(h.submitted.length, 0);
});

sdkTest('legacy unknown long text remains recoverable without fresh admission or automatic resend', async t => {
  const text = 'u'.repeat(12001), native = message('legacy-long-unknown-01', text);
  const { createOutboxStore } = await import('../src/outbox-store.js');
  const directory = mkdtempSync(join(tmpdir(), 'dsh-relay-long-outbox-proof-'));
  t.after(() => { assert(directory.startsWith(join(tmpdir(), 'dsh-relay-long-outbox-proof-'))); rmSync(directory, { recursive: true, force: true }); });
  const store = createOutboxStore({ root: directory, conversationId: 'main' });
  store.save({ version: 1, conversationId: 'main', requests: [{ requestId: relayRequestId(native.source.rpcId), text, message: native, state: 'unknown' }] });
  const h = await harness(t, { outbox: store });
  const { relay } = await h.open();
  await relay.refresh();
  assert.equal(relay.outboxState[0].text, text);
  assert.equal(relay.outboxState[0].state, 'unknown');
  assert.equal(relay.agent.session.deriveMessages()[0].content[0].text, text);
  assert.equal(store.load().requests[0].text, text);
  assert.equal(h.submitted.length, 0);
  const commands = new h.sdk.SessionCommandController(h.ctx, h.controller);
  assert.equal((await commands.prompt({ sessionId: relay.sessionId, requestId: native.source.rpcId, mode: 'queue',
    content: native.content }, { kind: 'user', rpcId: native.source.rpcId })).accepted, true, 'known native identity is reconciled, never freshly resent');
  assert.equal(h.submitted.length, 0);
});

sdkTest('no durable hook, failed durability and unsupported inputs fail before native success or transport', async t => {
  const h = await harness(t);
  const { relay } = await h.open({ outbox: undefined });
  assert.throws(() => relay.agent.followup(message('request-no-store-01')), { code: 'outbox-required' });
  assert.equal(h.submitted.length, 0);
  await relay.dispose();
  const { relay: failed } = await h.open({ outbox: { load() {}, save() { throw Error('disk full'); } } });
  assert.throws(() => failed.agent.followup(message('request-disk-full-01')), /disk full/u);
  assert.equal(failed.agent.inbox.nextTurn.length, 0);
  assert.equal(h.submitted.length, 0);
  assert.throws(() => failed.agent.followup({ ...message('request-image-00001'), content: [{ type: 'image', data: 'not-a-worker-receipt' }] }), { code: 'unsupported-input' });
  assert.throws(() => failed.agent.inject(message('request-context-001')), { code: 'unsupported-context' });
  assert.equal(failed.agent.model.current(), undefined);
  assert.throws(() => failed.agent.model.select({ provider: 'local', model: 'local' }), { code: 'unsupported-model-selection' });
});

sdkTest('actual Controller follows registered relay and Stop uses exact assignment/control CAS without termination', async t => {
  const h = await harness(t, { transport: { control: async request => {
    h.controls.push(request);
    assert.equal(request.action, 'interrupt');
    h.executions = [{ ticketId: 'ticket-1', assignmentId: 'assignment-1', controlSeq: 4, state: 'paused', interruption: 'settled', actions: { interrupt: false, resume: true } }];
    return { accepted: true, state: 'paused' };
  } } });
  h.executions = [{ ticketId: 'ticket-1', assignmentId: 'assignment-1', controlSeq: 3, state: 'running', actions: { interrupt: true, resume: false } }];
  const { relay, owner } = await h.open();
  assert.equal((await h.controller.resolveAgent(relay.sessionId)).agent, relay.agent);
  const command = new h.sdk.SessionCommandController(h.ctx, h.controller);
  assert.equal(relay.agent.status, 'running');
  assert.throws(() => relay.agent.steer(message('request-steer-00001')), { code: 'unsupported-steer' });
  await command.cancel({ sessionId: relay.sessionId });
  await relay.agent.controlPending;
  assert.deepEqual(h.controls[0], { conversationId: 'main', ticketId: 'ticket-1', expectedAssignmentId: 'assignment-1', expectedControlSeq: 3, action: 'interrupt' });
  assert.equal(relay.agent.status, 'idle');
  relay.agent.cancel({ kind: 'user' }); // idle cancel is a no-op.
  assert.equal(h.controls.length, 1);
  await owner.dispose();
  assert.equal(h.controls.length, 1, 'unload must not send backend Stop');
  assert.throws(() => relay.agent.followup(message('request-after-close')), { code: 'relay-disposed' });
  assert.equal(h.ctx.agents.get(relay.sessionId), undefined);
});

sdkTest('ambiguous or stale controls reject before transport and retain every ticket', async t => {
  const h = await harness(t);
  h.executions = [1, 2].map(i => ({ ticketId: `ticket-${i}`, assignmentId: `assignment-${i}`, controlSeq: 2, state: 'running', actions: { interrupt: true } }));
  const { relay } = await h.open();
  assert.throws(() => relay.agent.cancel({ kind: 'user' }, { keepInbox: true }), { code: 'needs-selection' });
  assert.throws(() => relay.interrupt({ ticketId: 'ticket-1', expectedAssignmentId: 'assignment-1', expectedControlSeq: 1 }), { code: 'needs-selection' });
  assert.equal(h.controls.length, 0);
  await relay.interrupt({ ticketId: 'ticket-1', expectedAssignmentId: 'assignment-1', expectedControlSeq: 2 });
  assert.equal(h.controls.length, 1);
});

sdkTest('complete Inbox supports ordered splice/replace/remove with atomic durability', async t => {
  const h = await harness(t);
  const { relay } = await h.open();
  const inbox = relay.agent.inbox;
  inbox.splice('next-turn', Infinity, 0, [message('request-inbox-00001'), message('request-inbox-00002')]);
  inbox.prepend('next-turn', message('request-inbox-00000'));
  assert.deepEqual(inbox.nextTurn.map(item => item.source.rpcId), ['request-inbox-00000', 'request-inbox-00001', 'request-inbox-00002']);
  assert.equal(inbox.replace('message-request-inbox-00001', message('request-inbox-00001', 'edited before handoff')), true);
  assert.equal(inbox.nextTurn[1].content[0].text, 'edited before handoff');
  const before = h.saved;
  assert.throws(() => inbox.splice('next-step', 0, 0, [message('request-inbox-00000')]), { code: 'duplicate-pending-input' });
  assert.deepEqual(h.saved, before, 'invalid batch must not partially persist');
  const removed = inbox.splice('next-turn', -2, 99, []);
  assert.equal(removed.length, 2);
  assert.equal(inbox.remove('missing'), false);
  inbox.clear();
  assert.equal(inbox.nextTurn.length, 0);
  assert.equal(h.submitted.length, 0, 'Inbox mutation alone does not wake the driver');
  assert(h.saved.requests.every(item => item.state === 'canceled'));
});

sdkTest('disposal during unknown network result aborts only local observation and ignores late writes', async t => {
  const gate = deferred();
  const entered = deferred();
  let signal;
  const h = await harness(t, { transport: { submit: (request, options) => {
    h.submitted.push(request); signal = options.signal; entered.resolve(); return gate.promise;
  } } });
  const { relay, owner } = await h.open();
  relay.agent.followup(message('request-late-0000001'));
  await entered.promise;
  const seq = relay.agent.session.seq;
  await owner.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(h.controls.length, 0);
  gate.resolve({ accepted: true, conversationId: 'main', requestId: relayRequestId('request-late-0000001') });
  await relay.agent.pumping;
  assert.equal(relay.agent.session.seq, seq);
  assert.equal(h.saved.requests[0].state, 'unknown');
  assert.equal(h.ctx.sessions.get(relay.sessionId), undefined);
  assert.equal(h.ordinaryCalls, 0);
});

sdkTest('Source history rejects foreign identity/gaps; restore is from authority, never local Session persistence', async t => {
  const h = await harness(t);
  const { relay } = await h.open();
  h.events.push({ seq: 2, id: 'gap', role: 'assistant', kind: 'answer', text: 'not seq 1', conversationId: 'main' });
  await assert.rejects(relay.refresh(), { code: 'source-history-gap' });
  h.events.length = 0;
  h.events.push({ seq: 1, id: 'foreign', role: 'assistant', kind: 'answer', text: 'foreign', conversationId: 'other' });
  await assert.rejects(relay.refresh(), { code: 'invalid-source-event' });
  assert.equal(relay.agent.session.snapshotEvents().filter(event => event.type === RELAY_EVENT).length, 0);
  assert.equal(h.submitted.length, 0);
});

sdkTest('public Host loader imports the same SDK; absent/mismatched SDK fails closed', async t => {
  const h = await harness(t);
  const { loadRelaySdk } = await import('../src/relay-sdk.js');
  await assert.rejects(loadRelaySdk(h.ctx), { code: 'host-sdk-unavailable' });
  await assert.rejects(loadRelaySdk(h.ctx, { ...h.sdk, SessionStore: class OtherSessionStore {} }), { code: 'host-sdk-identity-mismatch' });
  const { Loader } = await import(pathToFileURL(join(sdkRoot, 'cordis-plugin-loader/lib/index.js')).href);
  await h.ctx.plugin(Loader, { baseUrl: pathToFileURL(join(sdkRoot, '../..', 'package.json')).href });
  let relay;
  const entryId = await h.ctx.loader.create({
    name: new URL('../experiments/native-relay/loader-fixture.js', import.meta.url).href,
    config: { conversationId: 'main', cwd: process.platform === 'win32' ? 'C:\\relay-proof' : '/relay-proof',
      transport: h.transport, outbox: h.outbox, pollMs: 0, publish: value => { relay = value; } },
  });
  await h.ctx.loader.await();
  assert(relay, 'actual public loader created relay without plugin-local SDK dependencies');
  assert.equal(h.ctx.sessions.get(relay.sessionId), relay.agent.session);
  const entryFiber = h.ctx.loader.resolve(entryId).fiber;
  h.ctx.loader.remove(entryId);
  await entryFiber.dispose();
  while (entryFiber.inertia) await entryFiber.inertia;
  assert.equal(h.ctx.sessions.get(relay.sessionId), undefined);
  assert.equal(h.controls.length, 0);
});

sdkTest('narrow Source loader parent still composes a real Agent world for the actual Team extension', async t => {
  const h = await harness(t);
  const load = name => import(pathToFileURL(join(sdkRoot, name, 'lib/index.js')).href);
  const [{ SystemPrompt }, { ToolsService }, { Loader }] = await Promise.all([load('dsh-system-prompt'), load('dsh-tools'), load('cordis-plugin-loader')]);
  const promptProvider = await h.ctx.plugin(SystemPrompt, {});
  const toolProvider = await h.ctx.plugin(ToolsService, {});
  let llmCalls = 0;
  h.ctx.provide('llm', new Proxy({}, { get: () => () => { llmCalls++; throw Error('No local model'); } }));
  // Only Team membership is a fixture; the failing extension and both scoped registries are real.
  h.ctx.provide('agentTeams', { tryMembership: () => ({ role: 'lead', name: 'lead' }), membership: () => ({ role: 'lead', name: 'lead' }) });
  await h.ctx.plugin(Loader, { baseUrl: pathToFileURL(join(sdkRoot, '../..', 'package.json')).href });
  await h.ctx.loader.create({ name: '@deepseek-ai/dsh-experimental-tool-agent-team' });
  await h.ctx.loader.await();
  let relay;
  const entryId = await h.ctx.loader.create({ name: new URL('../experiments/native-relay/loader-fixture.js', import.meta.url).href,
    config: { conversationId: 'main', cwd: process.platform === 'win32' ? 'C:\\relay-proof' : '/relay-proof',
      transport: h.transport, outbox: h.outbox, pollMs: 0, publish: value => { relay = value; } } });
  await h.ctx.loader.await();
  await h.ctx.loader.resolve(entryId).fiber.await();
  assert(relay, 'real global Team agent/created composition must not reject a Source relay');
  assert(relay.agent.ctx.systemPrompt instanceof SystemPrompt);
  assert(relay.agent.ctx.tools instanceof ToolsService);
  const original = relay.agent;
  assert(h.ctx.tools.get('spawn_teammate', original), 'actual Team tools were registered in this exact Source Agent scope');
  assert.equal(h.ctx.tools.get('spawn_teammate'), undefined, 'Source contributions must not leak into global/ordinary Agent scopes');
  original.followup(message('scoped-world-source-01'));
  await original.pumping;
  assert.equal(h.submitted.length, 1);
  assert.equal(h.ordinaryCalls, 0);
  h.events.push({ seq: 1, id: 'source-world-input', conversationId: 'main', requestId: h.submitted[0].requestId,
    role: 'user', kind: 'request', text: h.submitted[0].text, at: 1 });
  await toolProvider.restart();
  await h.ctx.loader.await();
  await relay.whenReady();
  assert.notEqual(relay.agent, original, 'provider replacement reconstructs the whole Source world, not a stale scoped context');
  assert.equal(original.closed, true);
  assert.equal(h.ctx.tools.get('spawn_teammate', original), undefined);
  assert(h.ctx.tools.get('spawn_teammate', relay.agent));
  assert.equal(h.ctx.sessions.list().length, 1);
  assert.equal(h.ctx.agents.list().length, 1);
  assert.equal(h.submitted.length, 1, 'world reconstruction must not replay accepted or uncertain input');
  assert.equal(llmCalls, 0);
  const secondWorld = relay.agent;
  await promptProvider.restart();
  await h.ctx.loader.await();
  await relay.whenReady();
  assert.equal(secondWorld.closed, true);
  assert.notEqual(relay.agent, secondWorld);
  assert(h.ctx.tools.get('spawn_teammate', relay.agent));
  assert.equal(h.submitted.length, 1);
  assert.equal(h.ordinaryCalls, 0);
  assert.equal(llmCalls, 0);
  const replacement = relay.agent;
  await relay.dispose();
  assert.equal(h.ctx.tools.get('spawn_teammate', replacement), undefined);
  assert.equal(h.ctx.sessions.get(relay.sessionId), undefined);
});

sdkTest('official serial publication guards refuse ordinary Source identities and actual native Fork', async t => {
  const h = await harness(t);
  h.removeFactory();
  let llmCalls = 0;
  h.ctx.provide('llm', new Proxy({}, { get: () => () => { llmCalls++; throw Error('local model forbidden'); } }));
  h.ctx.provide('tools', {});
  h.ctx.provide('systemPrompt', { variable() {} });
  h.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'forbidden', model: 'forbidden' }) });
  h.ctx.provide('workspaceRegistry', { list: () => [] });
  const { default: AgentLoop } = await import(pathToFileURL(join(sdkRoot, 'dsh-agent-loop/lib/index.js')).href);
  await h.ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  installSourceRelayGuards(h.ctx);
  const { relay } = await h.open();
  const cwd = process.platform === 'win32' ? 'C:\\relay-proof' : '/relay-proof';
  const blockedId = relaySessionId('not-open');
  await assert.rejects(h.ctx.agents.create({ sessionId: blockedId, meta: { cwd } }), { code: 'ordinary-source-fallback-forbidden' });
  assert.equal(h.ctx.agents.get(blockedId), undefined);
  assert.equal(h.ctx.sessions.get(blockedId), undefined);
  const commands = new h.sdk.SessionCommandController(h.ctx, h.controller);
  await assert.rejects(commands.fork({ sessionId: relay.sessionId, atSeq: 0 }), /Source sessions and their forks cannot run an ordinary Agent driver/u);
  assert.equal(h.ctx.agents.list().length, 1);
  assert.equal(h.ctx.sessions.list().length, 1);
  assert.equal(llmCalls, 0);
  assert.equal(h.submitted.length, 0);
});

sdkTest('maintenance stays idle, preserves queued work on Stop, and whenIdle follows its released work', async t => {
  const h = await harness(t);
  const { relay } = await h.open();
  const gate = deferred();
  let signal;
  const maintenance = relay.agent.runMaintenance(async current => { signal = current; await gate.promise; return 'maintenance-result'; });
  assert.equal(relay.agent.status, 'idle');
  assert.throws(() => relay.agent.runMaintenance(async () => {}), { code: 'agent-busy' });
  relay.agent.followup(message('maintenance-queue-01'));
  const idle = relay.agent.whenIdle();
  relay.agent.cancel({ kind: 'user' }, { keepInbox: true });
  assert.equal(signal.aborted, true);
  assert.equal(h.controls.length, 0);
  assert.equal(h.submitted.length, 0);
  gate.resolve();
  assert.equal(await maintenance, 'maintenance-result');
  await idle;
  assert.equal(h.submitted.length, 1);
  assert.equal(relay.agent.status, 'idle');
});

sdkTest('real synchronous private outbox survives reconstruction and retains unknown draft', async t => {
  const { createOutboxStore } = await import('../src/outbox-store.js');
  const directory = mkdtempSync(join(tmpdir(), 'dsh-relay-outbox-proof-'));
  t.after(() => { assert(directory.startsWith(join(tmpdir(), 'dsh-relay-outbox-proof-'))); rmSync(directory, { recursive: true, force: true }); });
  const store = () => createOutboxStore({ root: directory, conversationId: 'main' });
  const h = await harness(t, { outbox: store(), transport: { submit: async request => { h.submitted.push(request); throw Error('network uncertainty'); } } });
  const { relay } = await h.open();
  relay.agent.followup(message('request-durable-0001', 'durable exact draft'));
  await relay.agent.pumping;
  await relay.dispose();
  const { relay: restored } = await h.open({ outbox: store() });
  assert.equal(restored.outboxState[0].state, 'unknown');
  assert.equal(restored.outboxState[0].text, 'durable exact draft');
  assert.equal(h.submitted.length, 1);
});
