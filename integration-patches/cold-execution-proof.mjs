// Isolated RC SDK proof. No running DSH instance, network, production ticket or model is used.
// DSH_NATIVE_SDK points to a directory containing the installed @deepseek-ai packages.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sdkRoot = process.env.DSH_NATIVE_SDK;
assert(sdkRoot, 'Set DSH_NATIVE_SDK to the SDK package directory');
const upstream = resolve(process.argv[2] ?? '.');
const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(sdkRoot, name, file)).href);
const [{ Context }, { SessionStore, Session }, { AgentRegistry }, { SessionProjectionRegistry }, { SessionQueryEngine }, jsonl,
  { HistoryController }, { default: AgentLoop }, { sourceExecutionOf }] = await Promise.all([
  load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-session-projection'), load('dsh-session-query'),
  load('dsh-session-persistence-jsonl'), load('dsh-api-session-controller', 'lib/types/history/controller.js'), load('dsh-agent-loop'),
  import(pathToFileURL(join(upstream, 'src/app/source-execution.ts')).href),
]);
const ctx = new Context();
const disk = mkdtempSync(join(tmpdir(), 'dsh-execution-cold-proof-'));
let llmCalls = 0;
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  ctx.provide('llm', new Proxy({}, { get: () => () => { llmCalls++; throw Error('LLM forbidden in cold proof'); } }));
  ctx.provide('tools', {});
  ctx.provide('systemPrompt', { variable() {} });
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'forbidden', model: 'forbidden' }) });
  const persistence = await ctx.plugin(jsonl, { root: join(disk, 'sessions'), compression: 'none' });
  assert.equal(persistence.state, 2);
  const query = await ctx.plugin(SessionQueryEngine);
  assert.equal(query.state, 2);
  const loop = await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  assert.equal(loop.state, 2);
  // Create only a detached, synthetic journal and durable storage. No Agent or live Session is entered.
  const worker = Session.create('worker-proof-ticket', [], { version: 4, id: 'worker-proof-ticket', createdAt: Date.now(), cwd: disk, isSeeded: false });
  for (let n = 1; n <= 2; n++) worker.append('user/message', {
    id: `proof-message-${n}`, role: 'user', content: [{ type: 'text', text: `synthetic cold message ${n}` }], source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  const handle = await ctx.sessionPersistence.create(worker.header);
  await handle.append(worker.snapshotEvents());
  await handle.flush();
  await handle.close();
  assert(await ctx.sessionPersistence.stat(worker.id), 'synthetic worker must be persisted');
  assert.equal(ctx.sessions.get(worker.id), undefined);
  assert.equal(ctx.agents.get(worker.id), undefined);
  const ticket = { id: 'proof-ticket', origin: { triggerId: 'proof-origin' }, assignments: [{ id: 'proof-assignment', state: 'running' }] };
  const origin = { source: 'proof', threads: [{ source: 'proof', id: 'thread' }] };
  const thread = { key: 'proof:thread', ref: origin.threads[0], subscriptions: [ticket.id] };
  const history = new HistoryController(ctx);
  const synthetic = worker.snapshotEvents().filter(event => event.type === 'user/message');
  let coldPages = 0;
  const execution = sourceExecutionOf({
    store: { atomic: fn => fn(), threads: { get: key => key === thread.key ? thread : undefined },
      tickets: { get: id => id === ticket.id ? ticket : undefined }, triggers: { get: id => id === 'proof-origin' ? origin : undefined } },
    engine: { interruptTicket() { throw Error('control forbidden in cold proof'); }, resumeTicket() { throw Error('control forbidden in cold proof'); } },
    controller: { events: (request, signal) => { coldPages++; return history.events(request, signal); } },
  }, 'proof');
  const scope = { threadKey: thread.key, ticketId: ticket.id };
  const status = await execution.read({ ...scope, limit: 0 });
  assert.equal(status.history, 'not-read');
  assert.equal(coldPages, 0);
  const newest = await execution.read({ ...scope, limit: 1 });
  assert.equal(newest.history, 'available');
  assert.equal(newest.records.length, 1);
  assert.equal(newest.records[0].seq, synthetic[1].seq);
  assert.equal(newest.records[0].time, synthetic[1].time);
  assert(newest.nextCursor);
  const older = await execution.read({ ...scope, limit: 1, cursor: newest.nextCursor });
  assert.equal(older.records[0].seq, synthetic[0].seq);
  assert.equal(ctx.agents.get(worker.id), undefined);
  assert.equal(ctx.sessions.get(worker.id), undefined);
  assert.equal(llmCalls, 0);
  assert.equal(coldPages, 2);
  console.log(JSON.stringify({ actualRcHistoryController: true, actualJsonlPersistence: true, stateReadPages: 0,
    coldPages, sequences: [older.records[0].seq, newest.records[0].seq], realTimestamps: true, activatedAgents: 0, llmCalls }, null, 2));
} finally {
  await ctx.fiber.dispose();
  // Verify the owned temporary directory before deletion; never touch an operator state directory.
  assert(disk.startsWith(join(tmpdir(), 'dsh-execution-cold-proof-')));
  rmSync(disk, { recursive: true, force: true });
}
