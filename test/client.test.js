import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function fixture() {
  let module, states = 0
  const entries = []
  const React = {
    createElement(type, props, ...children) { return typeof type === 'function' ? type(props ?? {}) : { type, props, children } },
    useState(initial) {
      const value = states++ === 0 ? [{ id: 'persisted-reply', role: 'assistant', text: 'real persisted reply', at: '2026-01-01T00:00:00Z' }] : initial
      return [value, () => {}]
    },
    useRef: value => ({ current: value }), useCallback: fn => fn, useEffect() {},
  }
  const sandbox = { window: { __ModuleLoader__: { load: input => { module = input.factory(() => React) } } }, URL, Date, console }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), sandbox)
  const context = {
    slots: { inject(_seat, register) { return register() }, register(options, Component) { entries.push({ ...options, Component }); return () => {} } },
    layout: { selectPanel() {} }, taskBoard: { registerGrouping: () => () => {} }, effect() {},
  }
  module.apply(context)
  return { entries }
}

test('dedicated chat renders persisted messages without depending on deleted kanban helpers', () => {
  const { entries } = fixture()
  const entry = entries.find(row => row.name === 'main')
  const tree = entry.Component(entry.inject())
  assert.match(JSON.stringify(tree), /real persisted reply/)
  assert.match(JSON.stringify(tree), /打开任务看板/)
  assert.equal(JSON.stringify(tree).includes('sab-grid'), false)
})

test('native task-board detail renders real ticket provenance and dates', () => {
  const { entries } = fixture()
  const entry = entries.find(row => row.name === 'task-board.detail.section')
  const tree = entry.Component({ task: { integrations: { superagent: { managed: true, ticketId: 'actual-ticket', statusText: '已完成', upstreamUpdatedAt: '2026-01-01T00:00:00Z', summary: 'real report', links: [] } } } })
  assert.match(JSON.stringify(tree), /actual-ticket/)
  assert.match(JSON.stringify(tree), /real report/)
})
