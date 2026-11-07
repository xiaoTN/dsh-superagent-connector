import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const IDENTITY = '/@superagent-board/api/identity'
const CHAT = '/@superagent-board/api/chat'
const reply = { id: 'persisted-reply', role: 'assistant', text: 'real persisted reply', at: '2026-01-01T00:00:00Z' }
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

// Exercise the registered public components with independent hook state, committed effects,
// external subscriptions, HTTP and clocks. No actual host, storage or network is touched.
function fixture({ name = '星舟 🤖', revision = 4 } = {}) {
  let module, current, cursor, timerId = 0, dirty = false
  const entries = [], groups = [], roots = [], effects = [], calls = [], intervals = new Map(), timeouts = new Map(), listeners = new Map(), cleanups = []
  const routes = new Map()
  const backend = { identity: { agent: { name }, revision }, messages: [reply] }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const owner = current, index = cursor++
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [owner.hooks[index], value => {
        const next = typeof value === 'function' ? value(owner.hooks[index]) : value
        if (!Object.is(next, owner.hooks[index])) { owner.hooks[index] = next; dirty = true }
      }]
    },
    useRef(value) { const index = cursor++; return current.hooks[index] ??= { current: value } },
    useCallback(fn, deps) {
      const index = cursor++, previous = current.hooks[index]
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) current.hooks[index] = { fn, deps }
      return current.hooks[index].fn
    },
    useEffect(fn, deps) {
      const owner = current, index = cursor++, previous = owner.hooks[index]
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        const effect = { deps, cleanup: previous?.cleanup }
        owner.hooks[index] = effect
        effects.push(() => { effect.cleanup?.(); effect.cleanup = fn() })
      }
    },
    useSyncExternalStore(subscribe, snapshot) {
      const [, setVersion] = React.useState(0)
      React.useEffect(() => subscribe(() => setVersion(value => value + 1)), [subscribe])
      return snapshot()
    },
  }
  function render(root) {
    function visit(node, path) {
      if (Array.isArray(node)) return node.map((child, index) => visit(child, path + ':' + index))
      if (!node || typeof node !== 'object') return node
      if (typeof node.type === 'function') {
        let instance = root.instances.get(path)
        if (!instance || instance.type !== node.type) {
          instance = { type: node.type, hooks: [] }
          root.instances.set(path, instance)
        }
        current = instance; cursor = 0
        return visit(node.type({ ...node.props, children: node.children }), path + ':render')
      }
      const result = { ...node, children: node.children.map((child, index) => visit(child, path + ':' + index)) }
      if (node.props.ref) {
        if (!node.props.ref.current) node.props.ref.current = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }
        result.dom = node.props.ref.current
      }
      return result
    }
    root.tree = visit(React.createElement(root.Component, root.props), 'root')
  }
  const document = {
    hidden: false,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: input => { module = input.factory(() => React) } } },
    URL, Date, console, AbortController, document,
    crypto: { randomUUID: () => '9e0851e3-1ddb-4efe-9f58-c310086908ab' },
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id }, clearInterval: id => intervals.delete(id),
    setTimeout(fn, ms) { const id = ++timerId; timeouts.set(id, { fn, ms }); return id }, clearTimeout: id => timeouts.delete(id),
    fetch(url, options = {}) {
      const request = { url, ...options }; calls.push(request)
      const handler = routes.get((options.method ?? 'GET') + ' ' + url)
      const outcome = handler ? Promise.resolve().then(() => handler(request))
        : url === IDENTITY && options.method === 'GET' ? Promise.resolve(response(backend.identity))
        : url === CHAT && options.method === 'GET' ? Promise.resolve(response({ messages: backend.messages, limit: 200, hasMore: false }))
        : Promise.reject(new Error('Unexpected request'))
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('AbortError'))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
        outcome.then(value => { options.signal?.removeEventListener('abort', abort); resolve(value) }, err => { options.signal?.removeEventListener('abort', abort); reject(err) })
      })
    },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), sandbox)
  const context = {
    slots: {
      inject(_seat, register) { return register() },
      register(options, Component) { const entry = { ...options, Component }; entries.push(entry); return () => { const index = entries.indexOf(entry); if (index >= 0) entries.splice(index, 1) } },
    },
    layout: { selectPanel() {} },
    taskBoard: { registerGrouping(fn) { groups.push(fn); return () => { const index = groups.indexOf(fn); if (index >= 0) groups.splice(index, 1) } } },
    effect(fn) { effects.push(() => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }) },
  }
  module.apply(context)
  const api = {
    entries, groups, calls, intervals, timeouts, backend, routes, document,
    activate() { module.apply(context) },
    disposePlugin(index = 0) { cleanups[index]() },
    unmount(root) { for (const instance of root.instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); roots.splice(roots.indexOf(root), 1) },
    mount(seat = 'main', props) {
      const entry = entries.find(row => row.name === seat)
      assert.ok(entry, 'registered ' + seat)
      const root = { Component: entry.Component, props: props ?? entry.inject?.() ?? {}, instances: new Map(), tree: null }
      roots.push(root); render(root); return root
    },
    async flush() {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve()
        if (dirty) { dirty = false; roots.forEach(render) }
        while (effects.length) effects.shift()()
      }
    },
    async tick(ms) { for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.fn(); await api.flush() },
    async expire(ms) { for (const [id, timer] of [...timeouts]) if (timer.ms === ms) { timeouts.delete(id); timer.fn() } await api.flush() },
    async visible(value) { document.hidden = !value; for (const fn of listeners.get('visibilitychange') ?? []) fn(); await api.flush() },
    dispose() { for (const root of roots) for (const instance of root.instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); cleanups.forEach(fn => fn()) },
  }
  return api
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))]
}
function contents(tree) {
  if (Array.isArray(tree)) return tree.map(contents).join('')
  if (!tree || typeof tree !== 'object') return tree == null || tree === false ? '' : String(tree)
  return tree.children.map(contents).join('')
}
const one = (root, predicate) => { const found = nodes(root.tree, predicate); assert.equal(found.length, 1); return found[0] }
const button = (root, label) => one(root, node => node.type === 'button' && contents(node) === label)
const nameInput = root => one(root, node => node.type === 'input' && node.props['aria-label'] === 'Agent 名称')
const nameForm = root => one(root, node => node.type === 'form' && node.props['aria-label'] === '名称设置')
const submitName = root => nameForm(root).props.onSubmit({ preventDefault() {} })
const setName = (root, name) => nameInput(root).props.onChange({ target: { value: name } })
const task = { integrations: { superagent: { managed: true, agentName: '旧快照名字', ticketId: 'actual-ticket', statusText: '已完成', upstreamUpdatedAt: '2026-01-01T00:00:00Z', summary: 'real report', links: [] } } }

test('dedicated chat renders persisted messages without depending on deleted kanban helpers', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  assert.match(contents(root.tree), /real persisted reply/)
  assert.match(contents(root.tree), /打开任务看板/)
  assert.equal(JSON.stringify(root.tree).includes('sab-grid'), false)
  app.dispose()
})

test('native task-board detail renders real ticket provenance and dates', async () => {
  const app = fixture(), root = app.mount('task-board.detail.section', { task })
  await app.flush()
  assert.match(contents(root.tree), /actual-ticket/)
  assert.match(contents(root.tree), /real report/)
  app.dispose()
})

test('identity loads without opening chat and drives sidebar, title, reply attribution and existing board extensions', async () => {
  const app = fixture()
  await app.flush()
  assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, '星舟 🤖')
  assert.equal(app.calls.some(call => call.url === CHAT), false)
  const root = app.mount(), detail = app.mount('task-board.detail.section', { task }), decoration = app.mount('task-board.card.decoration', { task })
  await app.flush()
  assert.equal(contents(one(root, node => node.type === 'h1')), '星舟 🤖')
  assert.equal(contents(one(root, node => node.type === 'strong')), '星舟 🤖')
  assert.equal(one(root, node => node.props.role === 'log').props['aria-label'], '星舟 🤖 消息')
  const composer = one(root, node => node.type === 'textarea')
  assert.match(composer.props['aria-label'], /星舟 🤖/)
  assert.match(composer.props.placeholder, /星舟 🤖/)
  assert.match(contents(detail.tree), /星舟 🤖 外部工单/)
  assert.match(contents(decoration.tree), /星舟 🤖 · 已完成/)
  assert.equal(app.groups[0](task).label, '星舟 🤖')
  assert.equal(app.groups[0](task).id, 'superagent:current')
  assert.equal(app.calls.filter(call => call.url === IDENTITY).length, 1)
  app.dispose()
})

test('identity polling updates multiple times, skips hidden pages, and never needs chat mounted', async () => {
  const app = fixture()
  await app.flush()
  assert.deepEqual([...app.intervals.values()].map(timer => timer.ms), [15000])
  for (const [name, revision] of [['二代 Agent', 5], ['第三次 🧑🏽‍💻', 6], ['最后名字', 7]]) {
    app.backend.identity = { agent: { name }, revision }
    await app.tick(15000)
    assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, name)
    assert.equal(app.groups[0](task).label, name)
    assert.equal(app.entries.filter(row => row.name === 'sidebar.panellist').length, 1)
  }
  await app.visible(false)
  const count = app.calls.length
  app.backend.identity = { agent: { name: '恢复可见', }, revision: 8 }
  await app.tick(15000)
  assert.equal(app.calls.length, count)
  await app.visible(true)
  assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, '恢复可见')
  assert.equal(app.calls.some(call => call.url === CHAT || call.method !== 'GET'), false)
  app.dispose()
  assert.equal(app.intervals.size, 0)
})

test('shared identity polling has one reader and stops after the last plugin owner is disposed', async () => {
  const app = fixture()
  await app.flush(); app.activate(); await app.flush()
  assert.equal(app.calls.filter(call => call.url === IDENTITY).length, 1)
  assert.equal([...app.intervals.values()].filter(timer => timer.ms === 15000).length, 1)
  app.disposePlugin(0)
  await app.tick(15000)
  assert.equal(app.calls.filter(call => call.url === IDENTITY).length, 2)
  app.disposePlugin(1)
  assert.equal(app.intervals.size, 0)
})

test('polling rerenders an already-open conversation repeatedly without scrolling or replacing messages', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  const log = one(root, node => node.props.role === 'log')
  log.dom.scrollTop = 40; log.props.onScroll()
  for (const [name, revision] of [['新中文名', 5], ['Next Agent 🧑🏽‍💻', 6]]) {
    app.backend.identity = { agent: { name }, revision }
    await app.tick(15000)
    assert.equal(contents(one(root, node => node.type === 'h1')), name)
    assert.equal(contents(one(root, node => node.type === 'strong')), name)
    assert.match(one(root, node => node.type === 'textarea').props.placeholder, new RegExp(name))
    assert.match(contents(root.tree), /real persisted reply/)
    assert.equal(log.dom.scrollTop, 40)
  }
  assert.equal(app.calls.filter(call => call.url === CHAT).length, 1)
  app.dispose()
})

test('fallback is only used before a valid read and failures never replace an authoritative name', async () => {
  const app = fixture(), root = app.mount(), detail = app.mount('task-board.detail.section', { task })
  app.routes.set('GET ' + IDENTITY, () => response({ message: '<secret backend diagnostic>' }, 503))
  assert.equal(contents(one(root, node => node.type === 'h1')), 'SuperAgent')
  assert.match(contents(detail.tree), /旧快照名字 外部工单/)
  await app.flush()
  assert.equal(contents(one(root, node => node.type === 'h1')), 'SuperAgent')
  assert.match(contents(root.tree), /离线/)
  assert.doesNotMatch(contents(root.tree), /secret backend diagnostic/)
  app.routes.delete('GET ' + IDENTITY); await app.tick(15000)
  assert.equal(contents(one(root, node => node.type === 'h1')), '星舟 🤖')
  for (const invalid of [{ agent: { name: '' }, revision: 8 }, { agent: { name: 'bad\nname' }, revision: 8 }, { agent: { name: '伪造名字' }, revision: -1 }, { agent: { name: '过时名字' }, revision: 3 }]) {
    app.backend.identity = invalid; await app.tick(15000)
    assert.equal(contents(one(root, node => node.type === 'h1')), '星舟 🤖')
  }
  app.dispose()
})

test('names are React text, not HTML, including across identity updates and board extensions', async () => {
  const unsafe = '<img src=x onerror=alert(1)>🤖'
  const app = fixture({ name: unsafe }), root = app.mount(), detail = app.mount('task-board.detail.section', { task })
  await app.flush()
  assert.equal(contents(one(root, node => node.type === 'h1')), unsafe)
  assert.equal(contents(one(root, node => node.type === 'strong')), unsafe)
  assert.match(contents(detail.tree), /<img src=x onerror=alert\(1\)>🤖 外部工单/)
  assert.equal(nodes(root.tree, node => node.type === 'img' || node.type === 'script' || node.props.dangerouslySetInnerHTML).length, 0)
  assert.equal(nodes(detail.tree, node => node.type === 'img' || node.props.dangerouslySetInnerHTML).length, 0)
  assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, unsafe)
  app.dispose()
})

test('name settings only PUT on explicit save, avoid double submit, and wait for confirmed authority', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  assert.equal(nameInput(root).props.value, '星舟 🤖')
  setName(root, '新名字 🚀'); await app.flush()
  await app.tick(15000)
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 0)
  const pending = deferred()
  app.routes.set('PUT ' + IDENTITY, () => pending.promise)
  submitName(root); submitName(root); await app.flush()
  const puts = app.calls.filter(call => call.method === 'PUT')
  assert.equal(puts.length, 1)
  assert.deepEqual(JSON.parse(puts[0].body), { name: '新名字 🚀', revision: 4 })
  assert.equal(puts[0].credentials, 'same-origin')
  assert.equal(puts[0].headers['x-superagent-board'], '1')
  assert.equal(contents(one(root, node => node.type === 'h1')), '星舟 🤖')
  assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, '星舟 🤖')
  assert.equal(button(root, '保存中…').props.disabled, true)
  app.backend.identity = { agent: { name: '新名字 🚀' }, revision: 5 }
  pending.resolve(response(app.backend.identity)); await app.flush()
  assert.equal(contents(one(root, node => node.type === 'h1')), '新名字 🚀')
  assert.equal(contents(one(root, node => node.type === 'strong')), '新名字 🚀')
  assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, '新名字 🚀')
  app.dispose()
})

test('conflict keeps draft and original revision until explicit reread then explicit retry', async () => {
  const app = fixture(), root = app.mount()
  await app.flush(); setName(root, '我的草稿'); await app.flush()
  app.backend.identity = { agent: { name: '其他人改名' }, revision: 9 }
  await app.tick(15000)
  assert.equal(nameInput(root).props.value, '我的草稿')
  app.routes.set('PUT ' + IDENTITY, () => response({ diagnostic: 'never render this' }, 409))
  submitName(root); await app.flush()
  assert.deepEqual(JSON.parse(app.calls.find(call => call.method === 'PUT').body), { name: '我的草稿', revision: 4 })
  assert.match(contents(root.tree), /其他用户修改/)
  assert.doesNotMatch(contents(root.tree), /never render this/)
  await app.tick(15000)
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1)
  assert.equal(nameInput(root).props.value, '我的草稿')
  button(root, '重新读取名称').props.onClick(); await app.flush()
  assert.equal(nameInput(root).props.value, '我的草稿')
  app.routes.set('PUT ' + IDENTITY, () => response({ agent: { name: '我的草稿' }, revision: 10 }))
  submitName(root); await app.flush()
  const puts = app.calls.filter(call => call.method === 'PUT')
  assert.equal(puts.length, 2)
  assert.deepEqual(JSON.parse(puts[1].body), { name: '我的草稿', revision: 9 })
  assert.equal(contents(one(root, node => node.type === 'h1')), '我的草稿')
  app.dispose()
})

test('offline, validation, authentication and authorization errors keep draft without automatic PUT retry', async () => {
  const app = fixture(), root = app.mount()
  await app.flush(); setName(root, '保留草稿'); await app.flush()
  for (const [status, expected] of [[400, /不合法/], [401, /未登录/], [403, /授权/], [503, /离线/]]) {
    app.routes.set('PUT ' + IDENTITY, () => response({ raw: 'sensitive body' }, status))
    submitName(root); await app.flush()
    assert.equal(nameInput(root).props.value, '保留草稿')
    assert.match(contents(root.tree), expected)
    assert.doesNotMatch(contents(root.tree), /sensitive body/)
    assert.equal(contents(one(root, node => node.type === 'h1')), '星舟 🤖')
  }
  const before = app.calls.filter(call => call.method === 'PUT').length
  await app.tick(15000); await app.tick(5000)
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, before)
  button(root, '重新读取名称').props.onClick(); await app.flush()
  assert.equal(nameInput(root).props.value, '保留草稿')
  app.routes.set('PUT ' + IDENTITY, () => response({ agent: { name: '保留草稿' }, revision: 5 }))
  submitName(root); await app.flush()
  assert.equal(contents(one(root, node => node.type === 'h1')), '保留草稿')
  app.dispose()
})

test('settings reject empty, overlong and control names but accept eighty Unicode emoji as plain text', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  for (const invalid of ['', '   ', 'a'.repeat(81), '名\n字', '名\u0000字', '名\u007f字', '名\u202e字', '名\u200b字', '名\u2060字']) {
    setName(root, invalid); await app.flush()
    assert.equal(button(root, '保存名称').props.disabled, true)
    submitName(root); await app.flush()
  }
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 0)
  const name = '🤖'.repeat(80)
  setName(root, name); await app.flush()
  assert.equal(button(root, '保存名称').props.disabled, false)
  app.routes.set('PUT ' + IDENTITY, () => response({ agent: { name }, revision: 5 }))
  submitName(root); await app.flush()
  assert.equal(JSON.parse(app.calls.find(call => call.method === 'PUT').body).name, name)
  assert.equal(contents(one(root, node => node.type === 'h1')), name)
  app.dispose()
})

test('identity reads are single-flight and late pre-save reads cannot roll back a confirmed new name', async () => {
  const app = fixture(), root = app.mount()
  await app.flush(); setName(root, '确认后的新名称'); await app.flush()
  const pending = deferred()
  app.routes.set('GET ' + IDENTITY, () => pending.promise)
  await app.tick(15000); await app.tick(15000)
  assert.equal(app.calls.filter(call => call.url === IDENTITY && call.method === 'GET').length, 2)
  app.routes.set('PUT ' + IDENTITY, () => response({ agent: { name: '确认后的新名称' }, revision: 5 }))
  submitName(root); await app.flush()
  pending.resolve(response({ agent: { name: '星舟 🤖' }, revision: 4 })); await app.flush()
  assert.equal(contents(one(root, node => node.type === 'h1')), '确认后的新名称')
  assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, '确认后的新名称')
  app.dispose()
})

test('disposing aborts pending identity reads and does not register stale sidebar labels', async () => {
  const app = fixture(), pending = deferred()
  app.routes.set('GET ' + IDENTITY, () => pending.promise)
  await app.flush()
  const request = app.calls.find(call => call.url === IDENTITY)
  app.dispose()
  assert.equal(request.signal.aborted, true)
  pending.resolve(response({ agent: { name: '不应出现' }, revision: 5 })); await app.flush()
  assert.equal(app.entries.length, 0)
  assert.equal(app.intervals.size, 0)
  assert.equal(app.timeouts.size, 0)
})

test('name save timeout keeps input and current identity with no automatic PUT retry', async () => {
  const app = fixture(), root = app.mount()
  await app.flush(); setName(root, '超时草稿'); await app.flush()
  const pending = deferred()
  app.routes.set('PUT ' + IDENTITY, () => pending.promise)
  submitName(root); await app.flush()
  await app.expire(15000)
  assert.match(contents(root.tree), /请求超时/)
  assert.equal(nameInput(root).props.value, '超时草稿')
  assert.equal(contents(one(root, node => node.type === 'h1')), '星舟 🤖')
  const write = app.calls.find(call => call.method === 'PUT')
  assert.equal(write.signal.aborted, true)
  await app.tick(15000)
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1)
  pending.resolve(response({ agent: { name: '超时草稿' }, revision: 5 })); await app.flush()
  assert.equal(contents(one(root, node => node.type === 'h1')), '星舟 🤖')
  app.dispose()
})

test('an unmounted name form aborts its PUT instead of updating authority from an abandoned response', async () => {
  const app = fixture(), root = app.mount()
  await app.flush(); setName(root, '放弃草稿'); await app.flush()
  const pending = deferred()
  app.routes.set('PUT ' + IDENTITY, () => pending.promise)
  submitName(root); await app.flush(); app.unmount(root)
  assert.equal(app.calls.find(call => call.method === 'PUT').signal.aborted, true)
  pending.resolve(response({ agent: { name: '放弃草稿' }, revision: 5 })); await app.flush()
  assert.equal(app.entries.find(row => row.name === 'sidebar.panellist').label, '星舟 🤖')
  app.dispose()
})

test('chat remains read-only until explicit send and retries the same id after failure, even after remount', async () => {
  const app = fixture(); let root = app.mount()
  await app.flush()
  const composer = () => one(root, node => node.type === 'textarea')
  composer().props.onChange({ target: { value: '只读模拟消息' } }); await app.flush()
  composer().props.onKeyDown({ key: 'Enter', ctrlKey: false })
  await app.tick(5000)
  assert.equal(app.calls.filter(call => call.url === CHAT && call.method === 'POST').length, 0)
  assert.equal(app.calls.filter(call => call.url === CHAT && call.method === 'GET').length, 2)
  app.routes.set('POST ' + CHAT, () => Promise.reject(new Error('network')))
  button(root, '发送').props.onClick(); button(root, '发送').props.onClick(); await app.flush()
  const initial = app.calls.find(call => call.url === CHAT && call.method === 'POST')
  assert.ok(initial)
  assert.equal(composer().props.value, '只读模拟消息')
  assert.equal(composer().props.readOnly, true)
  await app.tick(5000); await app.tick(15000)
  assert.equal(app.calls.filter(call => call.url === CHAT && call.method === 'POST').length, 1)
  app.unmount(root); root = app.mount(); await app.flush()
  assert.equal(composer().props.value, '只读模拟消息')
  app.routes.set('POST ' + CHAT, () => response({ accepted: true, id: 'accepted-id' }, 202))
  button(root, '重试发送').props.onClick(); await app.flush()
  const posts = app.calls.filter(call => call.url === CHAT && call.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[1].body, initial.body)
  assert.equal(composer().props.value, '')
  assert.match(contents(root.tree), /等待现有 星舟 🤖 处理/)
  app.backend.identity = { agent: { name: '改名后的 Agent' }, revision: 5 }; await app.tick(15000)
  assert.match(contents(root.tree), /等待现有 改名后的 Agent 处理/)
  app.dispose()
})

test('chat five-second reads honor visibility and keep user scroll position when new messages arrive', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  const log = one(root, node => node.props.role === 'log')
  log.dom.scrollTop = 40; log.props.onScroll()
  app.backend.messages = [reply, { ...reply, id: 'next-reply', text: 'new reply' }]
  await app.tick(5000)
  assert.equal(log.dom.scrollTop, 40)
  assert.match(contents(root.tree), /new reply/)
  assert.ok(button(root, '有新消息 · 跳到底部'))
  const count = app.calls.length
  await app.visible(false); await app.tick(5000)
  assert.equal(app.calls.length, count)
  await app.visible(true)
  button(root, '有新消息 · 跳到底部').props.onClick(); await app.flush()
  assert.equal(log.dom.scrollTop, log.dom.scrollHeight)
  app.dispose()
})
