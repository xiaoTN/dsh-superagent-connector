import test from 'node:test'
import assert from 'node:assert/strict'
import { allowExternalScheduledRun, assertExternalRunAllowed, GUARD_CAPABILITY, patchNativeBoard } from '../src/native-guard.js'
import { EXTERNAL_PRESET, makeTaskboardExtension, mirrorTickets, nativeStatus } from '../src/taskboard.js'

const external = (id, parentId) => ({ id, parentId, mode: 'standard', integrations: { superagent: { managed: true, executionOwner: 'superagent' } } })
test('persistent central run guard blocks native execution even if mode is edited or provider disabled', () => {
  assert.throws(() => assertExternalRunAllowed([external('owned')], 'owned'), /禁止在此重复运行/)
  // No provider or unknown-preset check is involved: persisted ownership is what guards this path.
  assert.throws(() => assertExternalRunAllowed([{ id: 'parent' }, external('owned', 'parent')], 'parent'), /禁止在此重复运行/)
  assert.doesNotThrow(() => assertExternalRunAllowed([{ id: 'native', mode: EXTERNAL_PRESET }], 'native'))
  assert.doesNotThrow(() => assertExternalRunAllowed([external('other'), { id: 'native' }], 'native'))
})

test('scheduled external refusal disables only its rule and does not abort the global scheduler loop', () => {
  let commits = 0, ordinaryAdmitted = 0
  const owned = { ...external('owned'), schedule: { enabled: true, nextRunAt: 1, runCount: 0 } }
  const native = { id: 'ordinary', schedule: { enabled: true, nextRunAt: 1, runCount: 0 } }
  const ledger = { document: { tasks: [owned, native], scheduler: {} }, commit() { commits++ } }
  assert.doesNotThrow(() => {
    for (const id of ['owned', 'ordinary']) if (allowExternalScheduledRun(ledger, id)) ordinaryAdmitted++
  })
  assert.equal(commits, 1); assert.equal(ordinaryAdmitted, 1)
  assert.equal(ledger.document.tasks[0].schedule.enabled, false)
  assert.equal(ledger.document.tasks[0].schedule.nextRunAt, undefined)
  assert.equal(ledger.document.tasks[0].schedule.runCount, 0)
  assert.equal(ledger.document.tasks[1].schedule.enabled, true)
  assert.match(ledger.document.scheduler.error, /禁止在此重复运行/)
})

test('compatibility patch refuses unknown binaries and connector refuses absent capability', () => {
  assert.throws(() => patchNativeBoard('not the published task board'), /refusing/)
  assert.throws(() => patchNativeBoard('// SUPERAGENT_EXTERNAL_EXECUTION_GUARD_V1\n// not actually patched'), /refusing/)
  assert.throws(() => makeTaskboardExtension(new URL('http://127.0.0.1:3082'), {}), /guard/)
  assert.doesNotThrow(() => makeTaskboardExtension(new URL('http://127.0.0.1:3082'), { externalExecutionGuard: GUARD_CAPABILITY }))
})

function boardFace() {
  const rows = []
  const operations = []
  const host = {
    tasks: {
      linked: () => rows,
      create(draft, options) {
        const task = { ...draft, id: 'native-' + rows.length, executions: [] }
        rows.push({ task, payload: structuredClone(options.payload) })
        operations.push('create')
        return task
      },
      patchContent(id, patch) { Object.assign(rows.find(row => row.task.id === id).task, patch); operations.push('content') },
      setStatus(id, status) { rows.find(row => row.task.id === id).task.status = status; operations.push('status') },
    },
    integration: { write(id, payload) { rows.find(row => row.task.id === id).payload = structuredClone(payload); operations.push('metadata') } },
  }
  return { host, rows, operations }
}
const ticket = { id: 'original-superagent-ticket', title: 'Existing work', stage: 'working', state: 'open', action: '', outcome: '', summary: 'actual report', threads: [], updatedAt: '2026-01-01T00:00:00Z' }

test('same upstream identity updates the original native card; no second ledger or execution is opened', () => {
  const { host, rows, operations } = boardFace()
  mirrorTickets(host, [ticket]); mirrorTickets(host, [ticket])
  assert.deepEqual(operations, ['create']); assert.equal(rows.length, 1)
  assert.equal(rows[0].task.status, 'running'); assert.equal(rows[0].task.executions.length, 0)
  assert.equal(rows[0].payload.ticketId, ticket.id)
  assert.equal(rows[0].payload.executionOwner, 'superagent')
  mirrorTickets(host, [{ ...ticket, stage: 'ended', outcome: 'merged', updatedAt: 'later' }])
  assert.equal(rows.length, 1); assert.equal(rows[0].task.status, 'done')
  assert.equal(rows[0].task.executions.length, 0)
})

test('same ticket identifier on another instance is not conflated; archived mirrors stay archived', () => {
  const { host, rows } = boardFace()
  mirrorTickets(host, [ticket], 'one'); mirrorTickets(host, [ticket], 'two')
  assert.equal(rows.length, 2)
  rows[0].task.archivedAt = 1
  mirrorTickets(host, [{ ...ticket, stage: 'ended', outcome: 'merged' }], 'one')
  assert.equal(rows[0].task.archivedAt, 1); assert.equal(rows[0].task.status, 'running')
})

test('waiting, stopped and unknown outcomes are not incorrectly declared successful', () => {
  assert.equal(nativeStatus({ stage: 'person', action: 'review' }), 'backlog')
  assert.equal(nativeStatus({ stage: 'ended', outcome: 'stopped' }), 'backlog')
  assert.equal(nativeStatus({ stage: 'ended', outcome: 'unknown' }), 'backlog')
  assert.equal(nativeStatus({ stage: 'person', action: 'failed' }), 'failed')
  assert.equal(nativeStatus({ stage: 'working', action: 'queued' }), 'todo')
})
