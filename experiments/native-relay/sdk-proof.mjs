// Run with WSL Node, not an installed DSH service. No network/provider is configured.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSourceRelay, RELAY_EVENT } from '../../src/relay-agent.js';
import { relayWorldDependencies } from '../../src/relay-world.js';
const root = process.env.DSH_NATIVE_SDK ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(root, name, file)).href);
const [{ Context }, { SessionStore }, { AgentRegistry, agentEvents }, { SessionProjectionRegistry }, { SessionQueryEngine }, sdkScope,
  { ApiSessionAgentController }, { SessionCommandController }, jsonl, { default: AgentLoop }, { ApiSessionList }] = await Promise.all([
  load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-session-projection'), load('dsh-session-query'), load('dsh-scope'),
  load('dsh-api-session-controller', 'lib/types/agent.js'), load('dsh-api-session-controller', 'lib/types/commands.js'),
  load('dsh-session-persistence-jsonl'), load('dsh-agent-loop'), load('dsh-api-session-controller', 'lib/types/list.js'),
]);
const ctx = new Context();
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(AgentRegistry);
await ctx.plugin(SessionQueryEngine);
let llmCalls = 0;
ctx.provide('llm', new Proxy({}, { get: () => () => { llmCalls++; throw Error('local LLM call forbidden'); } }));
ctx.provide('tools', {});
ctx.provide('systemPrompt', { variable() {} });
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'forbidden', model: 'forbidden' }) });
const disk = mkdtempSync(join(tmpdir(), 'dsh-relay-proof-'));
// Real JSONL backend includes its real global session/event and session/flush listeners.
const persistenceOwner = await ctx.plugin(jsonl, { root: join(disk, 'ordinary-sessions'), compression: 'none' });
assert.equal(persistenceOwner.state, 2);
const loopOwner = await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
assert.equal(loopOwner.state, 2);
assert.deepEqual(relayWorldDependencies(ctx), AgentLoop.inject, 'Source foundation matches the actual SDK factory public world declaration');
const sourceEvents = [];
let calls = 0;
let controls = 0;
let state;
const executions = [{ ticketId: 'ticket-real', assignmentId: 'assignment-real', controlSeq: 0, state: 'running', actions: { interrupt: true, resume: false } }];
const transport = {
  capabilities: async () => ({ version: 1, submit: true, interrupt: true, resume: true, modelSelection: false }),
  snapshot: async (conversationId, cursor) => ({ version: 1, conversationId,
    events: sourceEvents.filter(event => event.seq > cursor.afterSeq), executions, hasMore: false }),
  submit: async request => {
    calls++;
    sourceEvents.push({ seq: sourceEvents.length + 1, id: `e-${sourceEvents.length + 1}`, role: 'user', kind: 'request', at: '2026-11-08T00:00:00Z', ...request });
    throw Error('lost acknowledgement after real Source acceptance');
  },
  control: async request => { controls++; assert.equal(request.action, 'interrupt'); assert.equal(request.expectedAssignmentId, 'assignment-real'); assert.equal(request.expectedControlSeq, 0); executions[0] = { ...executions[0], controlSeq: 1, state: 'paused', interruption: 'settled', actions: { interrupt: false, resume: true } }; return { accepted: true }; },
};
const outbox = { load: () => structuredClone(state), save: value => { state = structuredClone(value); } };
const sdk = { ...sdkScope, agentEvents, SessionStore, AgentRegistry };
const agentController = new ApiSessionAgentController(ctx);
let relay;
let owner;
async function open() {
  owner = await ctx.plugin({ inject: ['sessions', 'agents', 'sessionPersistence'], async apply(ownerCtx) {
    relay = await createSourceRelay(ownerCtx, { conversationId: 'proof-conversation', cwd: disk, transport, outbox, sdk, pollMs: 0 });
  } });
  assert.equal(owner.state, 2, 'relay owner plugin must load successfully');
}
try {
  await open();
  assert.equal(ctx.agents.get(relay.sessionId), relay.agent);
  assert.equal(ctx.sessions.get(relay.sessionId), relay.agent.session);
  assert.equal((await agentController.resolveAgent(relay.sessionId)).agent, relay.agent);
  const catalog = new ApiSessionList(ctx, 10);
  await catalog.initialize();
  const listed = (await catalog.list()).find(item => item.sessionId === relay.sessionId);
  assert(listed, 'actual Controller catalog must discover the memory-only Source relay');
  assert.equal(listed.agentAvailable, true);
  assert.equal(listed.cwd, disk);
  // Use the actual Controller command path (same call invoked by native InputHub).
  const commands = new SessionCommandController(ctx, agentController);
  // Text admission collaborators, deliberately with no LLM capability.
  ctx.provide('attachments', { admitPromptContent: async content => content });
  ctx.provide('fileUploads', { bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) });
  await commands.prompt({ sessionId: relay.sessionId, requestId: 'request-proof', mode: 'queue', content: [{ type: 'text', text: 'real source only' }] }, { kind: 'user', rpcId: 'request-proof' });
  // Foreground microtasks are finite; whenIdle includes backend running, so pause by real Stop first.
  await relay.agent.pumping;
  assert.equal(calls, 1);
  assert.equal(relay.outboxState[0].state, 'accepted'); // snapshot reconciles lost ack, without retransmission.
  await commands.cancel({ sessionId: relay.sessionId });
  await relay.agent.controlPending;
  assert.equal(controls, 1);
  assert.equal(executions[0].state, 'paused');
  assert.equal(relay.agent.model.current(), undefined);
  assert.throws(() => relay.agent.model.select({ provider: 'ordinary', model: 'ordinary' }), /owned by the real SuperAgent/);
  const events = relay.agent.session.snapshotEvents();
  assert(events.some(event => event.type === RELAY_EVENT));
  assert(!events.some(event => /^(assistant\/|request\/|step\/|turn\/|tool\/|model\/)/u.test(event.type)));
  assert.deepEqual(relay.agent.session.deriveMessages().map(message => message.role), ['user']);
  await ctx.sessions.flush(relay.agent.session);
  await ctx.sessionPersistence.flush();
  assert.equal(await ctx.sessionPersistence.stat(relay.sessionId), undefined);
  const id = relay.sessionId;
  const observed = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' });
  await relay.dispose();
  assert.equal(controls, 1, 'unload must not terminate or interrupt backend tickets');
  assert.equal(ctx.agents.get(id), undefined);
  assert.equal(ctx.sessions.get(id), undefined);
  const cold = await agentController.resolveAgent(id);
  assert.equal(cold.error.code, 'session/not-found');
  assert.equal(llmCalls, 0, 'cold lookup must not call a local model');
  // A retained observation races unload: the actual default factory must refuse opening the absent log.
  const retainedCold = await agentController.resolveObservedAgent(observed);
  assert(retainedCold.error, 'retained observation cannot promote an unloaded relay');
  assert.equal(ctx.agents.get(id), undefined);
  assert.equal(llmCalls, 0);
  observed[Symbol.dispose]();
  await owner.dispose();
  await open();
  assert.equal(relay.sessionId, id);
  assert.equal(relay.agent.session.snapshotEvents().filter(event => event.type === RELAY_EVENT).length, sourceEvents.length);
  assert.equal(calls, 1, 'Source history restore must not replay input');
  assert.deepEqual(readdirSync(disk), [], 'facade wrote no ordinary SessionPersistence files');
  console.log(JSON.stringify({ sdk: '0.2.2-rc.1', actualController: true, actualControllerCatalog: true, actualSessionStore: true, actualAgentRegistry: true,
    actualDefaultLoopFactory: true, actualJsonlPersistence: true,
    sourceSubmissions: calls, explicitNonterminalInterrupts: controls, llmCalls,
    sourceHistoryRestored: true, retainedColdRequestRefused: true, noPersistenceFiles: true }, null, 2));
} finally {
  await relay?.dispose();
  await ctx.fiber.dispose();
  // Explicitly checked, solely owned temporary proof directory.
  assert(disk.startsWith(join(tmpdir(), 'dsh-relay-proof-')));
  rmSync(disk, { recursive: true, force: true });
}
