import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// The same deterministic outbox ids the Superagent core derives for replies.
const outboxKey = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)

const IDENTITY = '/@superagent-board/api/identity'
const CHAT = '/@superagent-board/api/chat'
const NATIVE = '/@superagent-board/api/native/session'
const EVENTS = '/@superagent-board/api/native/conversations/main/events'
const reply = { id: 'persisted-reply', role: 'assistant', text: 'real persisted reply', at: '2026-01-01T00:00:00Z' }
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const relayEvent = (seq, data) => ({ type: 'superagent/relay', seq, time: 1735689600000, data: { customSource: 'superagent', conversationId: 'main', ...data } })

// Exercise the registered public components with independent hook state, committed effects,
// external subscriptions, HTTP and clocks. No actual host, storage or network is touched.
function fixture({ name = '星舟 🤖', revision = 4 } = {}) {
  let module, current, cursor, timerId = 0, dirty = false
  const entries = [], groups = [], roots = [], effects = [], calls = [], intervals = new Map(), timeouts = new Map(), listeners = new Map(), cleanups = []
  const routes = new Map()
  const backend = { identity: { agent: { name }, revision }, messages: [reply], relayEvents: [], sessionId: 'superagent-source-real-host-id', executions: [], capabilities: { interrupt: false, resume: false, executionRecords: false, attachments: false }, workspaces: [], sessionRows: {} }
  const references = [], definitions = [], factoryCalls = [], nativeCalls = [], owned = new WeakSet(), catalogued = new Set()
  const surfaceListeners = new Map(), inputCalls = [], notices = [], observers = [], scope = {}
  const primaryAttributes = { 'aria-label': 'Native global Steer preference', 'aria-busy': 'false' }
  let primaryWrites = 0
  const primary = { disabled: false, getAttribute: key => primaryAttributes[key], setAttribute(key, value) { primaryAttributes[key] = value; primaryWrites++ } }
  const plusAttributes = { 'aria-label': 'Native commands', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }
  const plus = { disabled: false, getAttribute: key => plusAttributes[key] ?? null, setAttribute: (key, value) => { plusAttributes[key] = value }, removeAttribute: key => { delete plusAttributes[key] } }
  const fileInput = { disabled: false, clicks: 0, click() { this.clicks++ } }
  const historyActions = []
  function historyAction(label, title) {
    const action = { hidden: false, focusCalls: 0, focus() { this.focusCalls++ }, getAttribute: name => name === 'aria-label' ? label : name === 'title' ? title : null,
      closest(selector) { return selector.includes('[aria-label="' + label + '"]') && selector.includes('[title="' + title + '"]') ? action : null } }
    historyActions.push(action); return action
  }
  const inputSnapshot = { draft: '', phase: 'plain', attachmentIds: [], occurrences: [], queue: [] }
  const facade = {
    state: { getSnapshot: () => inputSnapshot },
    submit: (...args) => inputCalls.push(args),
    notify: (level, message) => notices.push({ level, message }),
    setDraft(value) { inputSnapshot.draft = value; inputSnapshot.claim = undefined; inputSnapshot.occurrences = []; dirty = true },
    pruneAttachments(value) { inputSnapshot.attachmentIds = value; dirty = true },
  }
  const surface = {
    addEventListener(type, fn) { if (!surfaceListeners.has(type)) surfaceListeners.set(type, new Set()); surfaceListeners.get(type).add(fn) },
    removeEventListener(type, fn) { surfaceListeners.get(type)?.delete(fn) },
    closest() { return null },
    querySelector(selector) { return selector === '[data-composer-card] button[aria-busy]' ? primary : selector === '[data-composer-card] button[aria-haspopup]' ? plus : selector === '[data-composer-card] input[type="file"]' ? fileInput : null },
    setAttribute() {}, removeAttribute() {},
    querySelectorAll(selector) { return historyActions.filter(action => action.closest(selector) === action) },
  }
  let activeReference
  function SessionProvider() { throw new Error('handled by renderer') }
  function PublicSlot({ seat, owner }) {
    const entry = entries.find(row => row.name === seat)
    assert.ok(entry, 'declared native child slot is occupied')
    assert.ok(owned.has(activeReference), 'strict Session child is below the Provider')
    return React.createElement(entry.Component, { renderFactorySlot, sessionId: activeReference.sessionId, ...entry.inject?.(activeReference.sessionId), ...owner })
  }
  function Factory({ factory, input }) {
    factoryCalls.push({ factory, input, reference: activeReference })
    if (factory === 'conversation.chat.reasoning.content') return React.createElement('native-markdown', { running: input.running }, input.text)
    assert.equal(factory, 'conversation.content')
    assert.ok(owned.has(activeReference), 'Factory inherits a genuine retained Controller generation')
    assert.equal(activeReference.released, false)
    const dock = entries.find(entry => entry.name === 'conversation.input.dock')
    const chain = entries.find(entry => entry.name === 'conversation.composer' && entry.select({ sessionId: activeReference.sessionId }) !== null)
    const events = backend.messages.map((message, index) => ({ type: 'superagent/source', seq: index + 1, time: Date.parse(message.at), data: { customSource: 'superagent', conversationId: 'main', event: { ...message, seq: index + 1, kind: message.kind ?? 'answer' } } })).concat(backend.relayEvents).sort((a, b) => a.seq - b.seq)
    const contexts = new Map()
    for (const event of events) for (const definition of definitions) {
      const matched = typeof definition.match === 'function' ? definition.match(event) : definition.match[event.type]?.(event)
      if (!matched) continue
      const key = definition.kind + ':' + matched.id
      let context = contexts.get(key)
      if (!context) { context = { key, id: matched.id, kind: definition.kind, matches: [], definition }; contexts.set(key, context) }
      const match = { event, role: matched.role, location: { kind: 'session' } }; context.matches.push(match)
      if (context.state === undefined) {
        if (matched.role === 'start') { context.start = match; context.state = definition.start(context, match, { previous: () => undefined }) }
      } else context.state = definition.update(context, match)
    }
    const nativeNodes = [...contexts.values()].map(context => context.definition.buildViewNode(context)).filter(Boolean)
    return React.createElement('native-conversation', { sessionId: activeReference.sessionId },
      dock && React.createElement(dock.Component, { ...dock.inject?.(activeReference.sessionId), sessionId: activeReference.sessionId, t: key => key === 'queue.steer' ? 'Steer queued input' : key }),
      chain && React.createElement(chain.Component, { ...chain.inject?.(activeReference.sessionId), sessionId: activeReference.sessionId, matched: chain.select({ sessionId: activeReference.sessionId }) }),
      backend.messages.filter(message => message.role === 'user').map(message => React.createElement('native-user-message', { key: message.id, source: 'Controller.user/message' }, message.text)),
      nativeNodes.map(node => {
        assert.equal(node.groupTree, 'turn', 'Source deliveries/status remain outside model-process disclosures')
        const renderer = entries.find(entry => entry.name === 'conversation.chat.node' && entry.key === node.kind)
        assert.ok(renderer, 'custom Source node has a keyed native Chat renderer')
        return React.createElement(renderer.Component, { key: node.key, node, renderFactorySlot })
      }),
      React.createElement('native-editor', { 'aria-label': 'Official composer' }),
      React.createElement('button', { onClick: () => nativeCalls.push({ method: 'Controller.prompt', sessionId: backend.sessionId }) }, 'Native send'))
  }
  const renderFactorySlot = (factory, input) => React.createElement(Factory, { factory, input })
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
    const used = new Set()
    function visit(node, path) {
      if (Array.isArray(node)) return node.map((child, index) => visit(child, path + ':' + index))
      if (!node || typeof node !== 'object') return node
      if (node.type === SessionProvider) {
        assert.ok(owned.has(node.props.session), 'SessionProvider rejects forged references')
        const previous = activeReference; activeReference = node.props.session
        const result = visit(node.children, path + ':provider')
        activeReference = previous
        return result
      }
      if (typeof node.type === 'function') {
        const identity = path + (node.props.key == null ? '' : ':key:' + node.props.key)
        used.add(identity)
        let instance = root.instances.get(identity)
        if (!instance || instance.type !== node.type) {
          if (instance) for (const hook of instance.hooks) hook?.cleanup?.()
          instance = { type: node.type, hooks: [] }
          root.instances.set(identity, instance)
        }
        current = instance; cursor = 0
        return visit(node.type({ ...node.props, children: node.children }), identity + ':render')
      }
      const result = { ...node, children: node.children.map((child, index) => visit(child, path + ':' + index)) }
      if (node.props.ref) {
        if (!node.props.ref.current) node.props.ref.current = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300, closest: () => surface }
        result.dom = node.props.ref.current
      }
      return result
    }
    root.tree = visit(React.createElement(root.Component, root.props), 'root')
    for (const [identity, instance] of root.instances) if (!used.has(identity)) {
      for (const hook of instance.hooks) hook?.cleanup?.()
      root.instances.delete(identity)
    }
  }
  const document = {
    hidden: false,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: input => { module = input.factory(() => React) } } },
    URL, Date, console, AbortController, document,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(target, options) { this.target = target; this.options = options }
      disconnect() { this.disconnected = true }
    },
    crypto: { randomUUID: () => '9e0851e3-1ddb-4efe-9f58-c310086908ab' },
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id }, clearInterval: id => intervals.delete(id),
    setTimeout(fn, ms) { const id = ++timerId; timeouts.set(id, { fn, ms }); return id }, clearTimeout: id => timeouts.delete(id),
    fetch(url, options = {}) {
      const request = { url, ...options }; calls.push(request)
      const handler = routes.get((options.method ?? 'GET') + ' ' + url)
      const outcome = handler ? Promise.resolve().then(() => handler(request))
        : url === IDENTITY && options.method === 'GET' ? Promise.resolve(response(backend.identity))
        : url === NATIVE && options.method === 'POST' ? Promise.resolve(response({ sessionId: backend.sessionId, conversationId: 'main', capabilities: { ...backend.capabilities, steer: false, modelSelection: false, permissionSelection: false, approval: false, tokenStream: false } }))
        : url === EVENTS && options.method === 'GET' ? Promise.resolve(response({ version: 1, conversationId: 'main', events: [], executions: backend.executions, capabilities: backend.capabilities }))
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
    sessions: {
      async refresh() { catalogued.add(backend.sessionId) },
      retain(sessionId, options) {
        assert.ok(catalogued.has(sessionId), 'Controller refuses an identity absent from its catalog')
        assert.equal(sessionId, backend.sessionId, 'only Host-created Source session is retained')
        assert.equal(options.source, 'controllerOperation')
        const reference = { sessionId, released: false, releases: 0, binding: { sessionId }, release() { this.released = true; this.releases++ } }
        reference.ready = backend.opening ? backend.opening.then(() => reference.binding) : Promise.resolve(reference.binding); owned.add(reference); references.push(reference)
        return reference
      },
      scope(id) { return id === backend.sessionId && references.some(reference => !reference.released) ? scope : undefined },
      sessionOf() { return { getSnapshot: () => ({ running: false }) } },
    },
    uiConversation: { events: { register(definition) { definitions.push(definition); return () => definitions.splice(definitions.indexOf(definition), 1) } } },
    conversation: { input: { for(value) { assert.equal(value, scope); return facade } } },
    layout: { selectPanel() {} },
    taskBoard: { registerGrouping(fn) { groups.push(fn); return () => { const index = groups.indexOf(fn); if (index >= 0) groups.splice(index, 1) } } },
    effect(fn) { effects.push(() => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) }) },
  }
  module.apply(context)
  const api = {
    entries, groups, calls, intervals, timeouts, backend, routes, document, references, definitions, factoryCalls, nativeCalls, inputSnapshot, inputCalls, notices, surfaceListeners, observers, primaryAttributes, primary, plus, plusAttributes, fileInput, historyAction,
    get primaryWrites() { return primaryWrites },
    dispatch(type, extra = {}) {
      const event = { type, target: { closest: selector => selector.includes('contenteditable') ? {} : null }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...extra }
      for (const listener of surfaceListeners.get(type) ?? []) listener(event)
      return event
    },
    receiveRelay(events) { backend.relayEvents = events; dirty = true },
    activate() { module.apply(context) },
    disposePlugin(index = 0) { cleanups[index]() },
    unmount(root) { for (const instance of root.instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); roots.splice(roots.indexOf(root), 1) },
    mount(seat = 'main', props) {
      const entry = entries.find(row => row.name === seat)
      assert.ok(entry, 'registered ' + seat)
      const kit = { useWorkspaces: selector => selector({ phase: 'ready', items: backend.workspaces }), useSessions: selector => selector({ phase: 'ready', byId: backend.sessionRows }), renderFactorySlot, renderSlot(seat, owner) { assert.ok(entry.children?.[seat], 'entry owns its child slot'); return React.createElement(PublicSlot, { seat, owner }) }, ...(Object.values(entry.children ?? {}).some(child => child.scope !== 'root') ? { SessionProvider } : {}) }
      const root = { Component: entry.Component, props: { ...kit, ...(props ?? entry.inject?.() ?? {}) }, instances: new Map(), tree: null }
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

test('Source panel retains the Host-created session and renders the native Factory inside its SessionProvider', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  assert.equal(app.references.length, 1)
  assert.ok(app.factoryCalls.some(call => call.factory === 'conversation.content' && call.reference === app.references[0]))
  const call = app.factoryCalls.find(call => call.factory === 'conversation.content')
  assert.deepEqual(JSON.parse(JSON.stringify(call.input)), { variant: 'embedded', phase: 'active', hero: false })
  assert.equal(nodes(root.tree, node => node.type === 'textarea' || node.props.role === 'log').length, 0)
  assert.match(contents(root.tree), /打开任务看板/)
  button(root, 'Native send').props.onClick()
  assert.deepEqual(app.nativeCalls, [{ method: 'Controller.prompt', sessionId: app.backend.sessionId }])
  assert.equal(app.calls.some(call => call.url === CHAT), false)
  app.unmount(root)
  assert.equal(app.references[0].released, true)
  app.dispose()
})

test('native Source creation uses the actual main-view workspace rather than guessing the first registry entry', async () => {
  const app = fixture()
  app.backend.workspaces = [{ workspaceId: 'registry-first', sessionIds: [] }, { workspaceId: 'actual-workspace', sessionIds: ['current-main-session'] }]
  app.backend.sessionRows = { 'current-main-session': { retainedBy: { mainView: 1 } } }
  app.mount(); await app.flush()
  assert.deepEqual(JSON.parse(app.calls.find(call => call.url === NATIVE).body), { conversationId: 'main', workspaceId: 'actual-workspace' })
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
  assert.equal(one(root, node => node.type === 'native-conversation').props.sessionId, app.backend.sessionId)
  assert.ok(one(root, node => node.type === 'native-editor'))
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

test('identity polling rerenders Source attribution without replacing its retained native generation', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  const reference = app.references[0]
  for (const [name, revision] of [['新中文名', 5], ['Next Agent 🧑🏽‍💻', 6]]) {
    app.backend.identity = { agent: { name }, revision }
    await app.tick(15000)
    assert.equal(contents(one(root, node => node.type === 'h1')), name)
    assert.equal(contents(one(root, node => node.type === 'strong')), name)
    assert.match(contents(root.tree), /real persisted reply/)
    assert.equal(app.references.length, 1)
    assert.equal(app.references[0], reference)
  }
  assert.equal(app.calls.filter(call => call.url === NATIVE).length, 1)
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

test('native connection fails closed without creating an ordinary Agent and retries only explicitly', async () => {
  const app = fixture(), root = app.mount()
  app.routes.set('POST ' + NATIVE, () => response({ raw: 'do not display private diagnostic' }, 503))
  await app.flush()
  assert.equal(app.references.length, 0)
  assert.equal(app.factoryCalls.length, 0)
  assert.match(contents(root.tree), /不会回退到普通 Agent/)
  assert.doesNotMatch(contents(root.tree), /private diagnostic/)
  await app.tick(5000); await app.tick(15000)
  assert.equal(app.calls.filter(call => call.url === NATIVE).length, 1)
  app.routes.delete('POST ' + NATIVE)
  button(root, '重试连接').props.onClick(); await app.flush()
  assert.equal(app.references.length, 1)
  assert.equal(app.calls.some(call => call.url === CHAT), false)
  app.dispose()
})

test('Controller readiness owns the native generation and late settlement after unmount never mounts a Factory', async () => {
  const app = fixture(), pending = deferred()
  app.backend.opening = pending.promise
  const root = app.mount(); await app.flush()
  assert.equal(app.references.length, 1)
  assert.equal(app.factoryCalls.length, 0)
  app.unmount(root)
  assert.equal(app.references[0].releases, 1)
  pending.resolve(); await app.flush()
  assert.equal(app.factoryCalls.length, 0)
  app.dispose()
})

test('failed Controller open releases its real reference and never substitutes an ordinary Session', async () => {
  const app = fixture(), pending = deferred()
  app.backend.opening = pending.promise
  const root = app.mount(); await app.flush()
  pending.reject(new Error('host session unavailable')); await app.flush()
  assert.equal(app.references[0].releases, 1)
  assert.equal(app.factoryCalls.length, 0)
  assert.match(contents(root.tree), /不会回退到普通 Agent/)
  app.unmount(root)
  assert.equal(app.references[0].releases, 1)
  app.dispose()
})

test('multiple running Source tasks require explicit selection and interrupt uses the selected assignment CAS, never ticket.stop', async () => {
  const app = fixture(), root = app.mount()
  app.backend.capabilities = { interrupt: true, resume: true, executionRecords: true }
  app.backend.executions = [
    { ticketId: 'task-one', assignmentId: 'assignment-one', controlSeq: 2, state: 'running', activity: 'running', actions: { interrupt: true, resume: false } },
    { ticketId: 'task-two', assignmentId: 'assignment-two', controlSeq: 7, state: 'running', activity: 'running', actions: { interrupt: true, resume: false } },
  ]
  await app.flush()
  assert.equal(button(root, '中断所选执行').props.disabled, true)
  button(root, '中断所选执行').props.onClick(); await app.flush()
  assert.equal(app.calls.filter(call => /interrupt$/.test(call.url)).length, 0)
  const select = one(root, node => node.type === 'select' && node.props['aria-label'] === '选择 Source 工单执行')
  assert.equal(select.props.value, '')
  select.props.onChange({ target: { value: 'task-one' } }); await app.flush()
  assert.equal(button(root, '中断所选执行').props.disabled, false)
  app.routes.set('POST /@superagent-board/api/native/conversations/main/executions/task-one/interrupt', () => response({ ticketId: 'task-one', assignmentId: 'assignment-one', controlSeq: 3, state: 'paused', interruption: 'requested' }))
  button(root, '中断所选执行').props.onClick(); button(root, '中断所选执行').props.onClick(); await app.flush()
  const controls = app.calls.filter(call => /interrupt$/.test(call.url))
  assert.equal(controls.length, 1)
  assert.deepEqual(JSON.parse(controls[0].body), { expectedAssignmentId: 'assignment-one', expectedControlSeq: 2 })
  assert.equal(controls[0].credentials, 'same-origin')
  assert.match(contents(root.tree), /正在确认中断/)
  assert.doesNotMatch(contents(root.tree), /已中断/)
  assert.equal(app.calls.some(call => /ticket.stop|\/stop$|api\/chat/.test(call.url)), false)
  app.dispose()
})

test('requested interruption is not stopped, resume waits for settled proof and controls fail closed on read failure', async () => {
  const app = fixture(), root = app.mount()
  app.backend.capabilities = { interrupt: true, resume: true, executionRecords: true }
  app.backend.executions = [{ ticketId: 'actual-task', assignmentId: 'actual-assignment', controlSeq: 3, state: 'paused', interruption: 'requested', actions: { interrupt: false, resume: true } }]
  await app.flush()
  const select = () => one(root, node => node.type === 'select')
  select().props.onChange({ target: { value: 'actual-task' } }); await app.flush()
  assert.equal(button(root, '继续所选工单').props.disabled, true)
  button(root, '继续所选工单').props.onClick(); await app.flush()
  assert.equal(app.calls.some(call => /resume$/.test(call.url)), false)
  assert.match(contents(root.tree), /正在确认中断/)
  assert.doesNotMatch(contents(root.tree), /已中断/)
  app.backend.executions = [{ ...app.backend.executions[0], controlSeq: 4, interruption: 'settled' }]
  await app.tick(5000)
  assert.equal(select().props.value, '')
  select().props.onChange({ target: { value: 'actual-task' } }); await app.flush()
  assert.equal(button(root, '继续所选工单').props.disabled, false)
  app.routes.set('GET ' + EVENTS, () => response({}, 503)); await app.tick(5000)
  assert.equal(button(root, '继续所选工单').props.disabled, true)
  button(root, '继续所选工单').props.onClick(); await app.flush()
  assert.equal(app.calls.some(call => /resume$/.test(call.url)), false)
  app.routes.delete('GET ' + EVENTS); button(root, '刷新执行状态').props.onClick(); await app.flush()
  app.routes.set('POST /@superagent-board/api/native/conversations/main/executions/actual-task/resume', () => response({ ticketId: 'actual-task', controlSeq: 5, state: 'running' }))
  button(root, '继续所选工单').props.onClick(); await app.flush()
  const call = app.calls.find(call => /resume$/.test(call.url))
  assert.deepEqual(JSON.parse(call.body), { expectedAssignmentId: 'actual-assignment', expectedControlSeq: 4 })
  app.dispose()
})

test('fresh execution eligibility overrides an older selection even when its CAS identity is unchanged', async () => {
  const app = fixture(), root = app.mount()
  app.backend.capabilities = { interrupt: true, resume: true }
  app.backend.executions = [{ ticketId: 'actual-task', assignmentId: 'actual-assignment', controlSeq: 3, state: 'running', activity: 'running', actions: { interrupt: true, resume: false } }]
  await app.flush()
  one(root, node => node.type === 'select').props.onChange({ target: { value: 'actual-task' } }); await app.flush()
  assert.equal(button(root, '中断所选执行').props.disabled, false)
  app.backend.executions = [{ ...app.backend.executions[0], state: 'paused', interruption: 'requested', actions: { interrupt: false, resume: false } }]
  await app.tick(5000)
  assert.equal(button(root, '中断所选执行').props.disabled, true)
  app.dispose()
})

test('execution trace is an explicit bounded cold read with its own cursor and never fabricated Chat tool rows', async () => {
  const app = fixture(), root = app.mount()
  app.backend.capabilities = { interrupt: true, resume: true, executionRecords: true }
  app.backend.executions = [{ ticketId: 'actual-task', assignmentId: 'actual-assignment', controlSeq: 3, state: 'running', activity: 'running', actions: { interrupt: true, resume: false } }]
  const tracePath = '/@superagent-board/api/native/conversations/main/executions/actual-task'
  app.routes.set('GET ' + tracePath + '?limit=50', () => response({ ticketId: 'actual-task', assignmentId: 'actual-assignment', history: 'available', records: [{ seq: 41, time: 1735689600000, event: { type: 'tool/call', data: { name: 'actual-tool', output: 'real trace payload' } } }], hasMore: true, truncated: false, nextCursor: { throughSeq: 41, beforeSeq: 41 } }))
  app.routes.set('GET ' + tracePath + '?limit=50&throughSeq=41&beforeSeq=41', () => response({ ticketId: 'actual-task', history: 'available', records: [{ seq: 19, time: 1735689600000, event: { type: 'user/message', data: { text: 'older actual record' } } }], hasMore: false, truncated: false }))
  await app.flush()
  assert.equal(app.calls.some(call => call.url.startsWith(tracePath)), false)
  one(root, node => node.type === 'select').props.onChange({ target: { value: 'actual-task' } }); await app.flush()
  button(root, '读取所选真实记录').props.onClick(); await app.flush()
  assert.match(contents(root.tree), /tool\/call.*actual-tool.*real trace payload/s)
  assert.equal(nodes(root.tree, node => node.props['data-superagent-source'] === 'actual-tool').length, 0)
  button(root, '读取更早记录').props.onClick(); await app.flush()
  assert.match(contents(root.tree), /older actual record/)
  assert.equal(app.calls.filter(call => call.url.startsWith(tracePath)).length, 2)
  app.dispose()
})

test('Source-only public composer guard synchronously refuses local commands and files, while native queue submission stays native', async () => {
  const app = fixture(), root = app.mount()
  await app.flush()
  // Deliberately no render between draft change and Enter: fast typing must not run a local command.
  app.inputSnapshot.draft = '/permission danger-full-access'
  const denied = app.dispatch('keydown', { key: 'Enter' })
  assert.equal(denied.defaultPrevented, true)
  assert.equal(denied.stopped, true)
  assert.equal(app.inputCalls.length, 0)
  assert.equal(app.inputSnapshot.draft, '/permission danger-full-access')
  assert.match(app.notices.at(-1).message, /不支持/)
  app.inputSnapshot.draft = '@local-workspace-file'
  assert.equal(app.dispatch('keydown', { key: 'Enter' }).defaultPrevented, true)
  assert.equal(app.inputCalls.length, 0)
  const file = app.dispatch('paste', { clipboardData: { files: [{}] } })
  assert.equal(file.defaultPrevented, true)
  app.inputSnapshot.draft = 'real Source input'
  const submitted = app.dispatch('keydown', { key: 'Enter' })
  assert.equal(submitted.defaultPrevented, true)
  assert.deepEqual(app.inputCalls, [['queue', 'enter']])
  assert.equal(app.calls.some(call => call.url === CHAT), false)
  const chain = app.entries.find(entry => entry.name === 'conversation.composer')
  assert.ok(chain)
  assert.equal(chain.select({ sessionId: 'ordinary-agent-session' }), null)
  app.dispose()
  assert.equal([...app.surfaceListeners.values()].every(set => set.size === 0), true)
})

test('Source compatibility capture preserves native IME and rejects global command shortcuts without blocking copy', async () => {
  const app = fixture(); app.mount(); await app.flush()
  app.inputSnapshot.draft = '中文输入'
  app.dispatch('compositionstart')
  app.dispatch('keydown', { key: 'Enter' })
  assert.equal(app.inputCalls.length, 0)
  app.dispatch('compositionend')
  app.dispatch('keydown', { key: 'Enter', keyCode: 229 })
  assert.equal(app.inputCalls.length, 0)
  const command = app.dispatch('keydown', { key: 'p', ctrlKey: true, shiftKey: true })
  assert.equal(command.defaultPrevented, true)
  assert.equal(app.dispatch('keydown', { key: 'c', ctrlKey: true }).defaultPrevented, false)
  app.dispose()
})

test('Source primary label shim is idempotent, preserves native Stop and Sending, and disconnects with its native scope', async () => {
  const app = fixture(); app.inputSnapshot.draft = 'queued text'; app.mount(); await app.flush()
  assert.equal(app.primaryAttributes['aria-label'], '发送（排队）')
  assert.equal(app.observers.length, 1)
  const observer = app.observers[0], writes = app.primaryWrites
  observer.callback([]); observer.callback([])
  assert.equal(app.primaryWrites, writes)
  app.inputSnapshot.draft = ''; app.primaryAttributes['aria-label'] = 'Native Stop'; observer.callback([])
  assert.equal(app.primaryAttributes['aria-label'], 'Native Stop')
  app.inputSnapshot.draft = 'sending'; app.primaryAttributes['aria-busy'] = 'true'; app.primaryAttributes['aria-label'] = 'Native Sending'; observer.callback([])
  assert.equal(app.primaryAttributes['aria-label'], 'Native Sending')
  assert.equal(app.entries.find(entry => entry.name === 'conversation.input.dock').locale, 'conversation')
  app.dispose()
  assert.equal(observer.disconnected, true)
})

test('effective attachment capability delegates native picker, paste, drop and attachment-only queue without replacing upload intake', async () => {
  const app = fixture(); app.backend.capabilities.attachments = true
  app.mount(); await app.flush()
  assert.equal(app.dispatch('paste', { clipboardData: { files: [{}] } }).defaultPrevented, false)
  assert.equal(app.dispatch('drop', { dataTransfer: { files: [{}] } }).defaultPrevented, false)
  const picked = app.dispatch('click', { target: { closest: selector => selector === '[data-composer-card] button[aria-haspopup]' ? app.plus : null } })
  assert.equal(picked.defaultPrevented, true)
  assert.equal(app.fileInput.clicks, 1)
  assert.equal(app.plusAttributes['aria-label'], '添加文件或图片')
  assert.equal(app.plusAttributes['aria-haspopup'], 'dialog')
  app.inputSnapshot.attachmentIds = ['native-image-draft', 'native-file-draft']
  assert.equal(app.entries.find(entry => entry.name === 'conversation.composer').select({ sessionId: app.backend.sessionId }), null)
  app.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual(app.inputCalls, [['queue', 'enter']])
  assert.equal(app.calls.some(call => call.url === CHAT || /attachments|upload/.test(call.url)), false, 'only the mounted native input owns uploads and receipts')
  app.dispose()
})

test('effective attachment revocation preserves drafts, closes picker and file intake, and treats protected drag metadata as files', async () => {
  const app = fixture(); app.backend.capabilities.attachments = true
  app.mount(); await app.flush()
  app.inputSnapshot.draft = 'keep attachment draft'
  app.inputSnapshot.attachmentIds = ['pending-native-draft']
  app.backend.capabilities.attachments = false; await app.tick(5000)
  assert.equal(app.plusAttributes['aria-label'], 'Native commands', 'Source-owned picker labels are restored on capability teardown')
  assert.equal(app.plusAttributes['aria-haspopup'], 'listbox')
  const picked = app.dispatch('click', { target: { closest: selector => selector === '[data-composer-card] button[aria-haspopup]' ? app.plus : null } })
  assert.equal(picked.defaultPrevented, true)
  assert.equal(app.fileInput.clicks, 0)
  assert.equal(app.dispatch('paste', { clipboardData: { files: [{}] } }).defaultPrevented, true)
  assert.equal(app.dispatch('dragover', { dataTransfer: { types: ['Files'], files: [], items: [] } }).defaultPrevented, true)
  app.dispatch('keydown', { key: 'Enter' })
  assert.equal(app.inputCalls.length, 0)
  assert.deepEqual(app.inputSnapshot.attachmentIds, ['pending-native-draft'])
  assert.equal(app.inputSnapshot.draft, 'keep attachment draft')
  app.dispose()
})

test('enabled attachments still honor the mounted native upload gate and do not alter ordinary Agent intake', async () => {
  const app = fixture(); app.backend.capabilities.attachments = true
  app.mount(); await app.flush()
  app.inputSnapshot.draft = 'pending upload'; app.inputSnapshot.attachmentIds = ['uploading-native-draft']
  app.primary.disabled = true
  assert.equal(app.dispatch('keydown', { key: 'Enter' }).defaultPrevented, false, 'native keymap handles its pending-upload feedback')
  assert.equal(app.inputCalls.length, 0)
  app.fileInput.disabled = true
  app.dispatch('click', { target: { closest: selector => selector === '[data-composer-card] button[aria-haspopup]' ? app.plus : null } })
  assert.equal(app.fileInput.clicks, 0)
  app.dispose()
  const ordinary = fixture(); ordinary.mount('conversation.input.dock', { sessionId: 'ordinary-agent' }); await ordinary.flush()
  assert.equal(ordinary.surfaceListeners.size, 0)
  assert.equal(ordinary.observers.length, 0)
  assert.equal(ordinary.primaryAttributes['aria-label'], 'Native global Steer preference')
  assert.equal(ordinary.entries.find(entry => entry.name === 'conversation.composer').select({ sessionId: 'ordinary-agent' }), null)
  assert.equal(ordinary.calls.some(call => call.url === NATIVE || call.url === EVENTS), false)
  ordinary.dispose()
})

test('Source transport aggregates final per-request state, keeps unknown local admission visible and never leaks raw relay metadata or retries', async () => {
  const app = fixture(), requestA = 'a'.repeat(64), requestB = 'b'.repeat(64)
  app.backend.relayEvents = [
    relayEvent(10, { operation: 'submit', requestId: requestA, outcome: 'queued' }),
    relayEvent(11, { operation: 'submit', requestId: requestA, outcome: 'unknown', receipt: { secret: 'private-receipt' } }),
    relayEvent(12, { operation: 'submit', outcome: 'unavailable', code: 'transport-error', message: 'private-error Bearer do-not-display', metadata: { endpoint: 'https://private.invalid' } }),
    relayEvent(13, { operation: 'submit', outcome: 'unavailable', code: 'transport-error', message: 'private-repeat' }),
    relayEvent(14, { operation: 'submit', requestId: requestB, outcome: 'unknown' }),
    relayEvent(15, { operation: 'open', outcome: 'source-backed' }),
  ]
  const root = app.mount(); await app.flush()
  const statuses = () => nodes(root.tree, node => node.props['data-superagent-transport'] === true)
  assert.equal(statuses().length, 3, 'one state per exact request plus one unassigned operation error')
  const statusA = () => one(root, node => node.props['data-superagent-request'] === requestA)
  assert.match(contents(statusA()), /本机已保存.*尚未确认/s)
  assert.match(contents(statusA()), /不会自动重发/)
  assert.match(contents(root.tree), /transport-error/)
  assert.doesNotMatch(contents(root.tree), /private-receipt|private-error|private-repeat|do-not-display|private.invalid/)
  for (const status of statuses()) assert.equal(nodes(status, node => node.type === 'button' || node.type === 'native-markdown').length, 0)
  app.receiveRelay([...app.backend.relayEvents,
    { type: 'superagent/source', seq: 20, time: 1735689600000, data: { customSource: 'superagent', conversationId: 'main', event: { seq: 21, id: 'actual-source-receipt', role: 'user', text: 'actual Source receipt', at: 1735689600000, kind: 'request', requestId: requestA } } },
    relayEvent(21, { operation: 'submit', requestId: requestA, outcome: 'unknown', recovered: true }),
  ]); await app.flush()
  assert.equal(statuses().length, 3)
  assert.match(contents(statusA()), /Source 已确认接收.*不代表任务完成/s)
  assert.doesNotMatch(contents(statusA()), /尚未确认/)
  assert.match(contents(one(root, node => node.props['data-superagent-request'] === requestB)), /尚未确认/)
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1, 'only native session creation; UI never resends Source requests')
  app.dispose()
})

test('Source control transport unknown never claims acknowledgment or stopped execution and only safe error codes render', async () => {
  const app = fixture()
  app.backend.relayEvents = [relayEvent(10, { operation: 'interrupt', outcome: 'unknown', ticketId: 'real-ticket', code: 'private-secret-code', result: { output: 'private-control-output' } })]
  const root = app.mount(); await app.flush()
  const status = () => one(root, node => node.props['data-superagent-transport'] === true)
  assert.match(contents(status()), /尚未确认/)
  assert.doesNotMatch(contents(status()), /已确认收到|已中断|private-secret-code|private-control-output/)
  app.receiveRelay([...app.backend.relayEvents, relayEvent(11, { operation: 'interrupt', outcome: 'acknowledged', ticketId: 'real-ticket' })]); await app.flush()
  assert.match(contents(status()), /等待真实停止确认/)
  assert.doesNotMatch(contents(status()), /已中断/)
  app.dispose()
})

test('Source history actions reject local rollback and fork-edit synchronously, hide late buttons without stealing focus, and preserve copy', async () => {
  const app = fixture(); app.mount(); await app.flush()
  const undo = app.historyAction('撤回', '整段回退：文件与对话一并回到该消息之前')
  const edit = app.historyAction('编辑', '编辑并重发：就地改完再发出去（新建会话，不动项目文件）')
  const copy = app.historyAction('复制', '复制消息')
  // Newly inserted history plugin actions are refused before its MutationObserver callback runs.
  assert.equal(app.dispatch('click', { target: undo }).defaultPrevented, true)
  assert.equal(app.dispatch('pointerdown', { target: edit }).defaultPrevented, true)
  assert.equal(app.dispatch('keydown', { target: edit, key: 'Enter' }).defaultPrevented, true)
  assert.equal(app.dispatch('click', { target: copy }).defaultPrevented, false)
  app.observers[0].callback([])
  assert.equal(undo.hidden, true); assert.equal(edit.hidden, true); assert.equal(copy.hidden, false)
  assert.equal(undo.focusCalls + edit.focusCalls + copy.focusCalls, 0)
  assert.equal(app.inputCalls.length, 0)
  assert.equal(app.calls.some(call => /fork|rollback|chat/.test(call.url)), false)
  app.dispose()
})

test('Source delivery body uses ordinary assistant typography without changing Source metadata or the native Markdown renderer', async () => {
  const app = fixture(), root = app.mount(); await app.flush()
  const body = one(root, node => node.props['data-superagent-delivery-content'] === true)
  assert.equal(body.props.style.fontSize, 'var(--dsh-content-font-size,14px)')
  assert.equal(body.props.style.lineHeight, 'calc(24px + var(--dsh-content-font-delta,0px))')
  assert.equal(body.props.style.color, 'var(--dsw-alias-label-primary,#172033)')
  assert.equal(nodes(body, node => node.type === 'native-markdown').length, 1)
  assert.equal(nodes(body, node => node.type === 'strong').length, 0, 'Source provenance stays in its separate metadata row')
  assert.equal(nodes(root.tree, node => node.props['data-superagent-source']).length, 1)
  app.dispose()
})

test('Source acknowledgement and reply quote the exact human message they answer, like a Feishu topic reply', async () => {
  const app = fixture(), root = app.mount()
  const first = { ...reply, id: 'trigger-first', role: 'user', kind: 'request', text: '为什么这两个输入框还是不一样？', at: '2026-11-08T02:30:39.841Z' }
  const second = { ...reply, id: 'trigger-second', role: 'user', kind: 'request', text: '如果我先后给你说两个相似的任务，你会合并到一个 session 里完成吗？', at: '2026-11-08T02:31:27.949Z' }
  const ack = { id: outboxKey('ack', first.id), role: 'assistant', kind: 'acknowledgement', text: '收到：看下这两处输入框为何还是不一样，给你一个说明。', at: '2026-11-08T02:31:38.848Z' }
  const answerText = '不一定。相似不等于合并：只有同一任务范围内的追问或续改会留在这个工单里继续。'
  const answer = { id: outboxKey('reply', second.id, answerText), role: 'assistant', kind: 'reply', text: answerText, at: '2026-11-08T02:31:40.813Z' }
  // Deliberately interleaved: the acknowledgement for the first message arrives after the second
  // message, so quoting the nearest preceding row would be wrong; only the deterministic id matches.
  app.backend.messages = [first, second, ack, answer]
  await app.flush()
  const quotes = nodes(root.tree, node => node.props['data-superagent-reply-to'] !== undefined)
  assert.equal(quotes.length, 2)
  assert.equal(quotes[0].props['data-superagent-reply-to'], first.id)
  assert.match(contents(quotes[0]), /回复你的消息/)
  assert.match(contents(quotes[0]), /为什么这两个输入框还是不一样/)
  assert.equal(quotes[1].props['data-superagent-reply-to'], second.id)
  assert.match(contents(quotes[1]), /如果我先后给你说两个相似的任务/)
  // The quote is metadata above the reply body, never a replacement of the real Markdown content.
  assert.equal(nodes(root.tree, node => node.props['data-superagent-delivery-content'] === true).length, 2)
  app.dispose()
})

test('a ticket-level result quotes the message its ticket started from, even before its acknowledgement row', async () => {
  const app = fixture(), root = app.mount()
  const request = { ...reply, id: 'trigger-request', role: 'user', kind: 'request', text: '你这个答复界面要优化一下，优化成像飞书话题一样的。', at: '2026-11-08T02:33:17.035Z' }
  const ticketId = 'ticket-3f020097'
  const ack = { id: outboxKey('ack', request.id), role: 'assistant', kind: 'acknowledgement', ticketId, text: '收到：把答复界面改成飞书话题式。', at: '2026-11-08T02:33:55.378Z' }
  const resultText = '答复界面已改成飞书话题式：每条“已接收/答复”上方会显示它所回复的原消息。'
  const result = { id: outboxKey('reply', ticketId, resultText), role: 'assistant', kind: 'reply', ticketId, text: resultText, at: '2026-11-08T02:54:57.000Z' }
  const orphanText = 'no sibling answer binds this ticket to a message'
  const orphan = { id: outboxKey('reply', 'ticket-nobody', orphanText), role: 'assistant', kind: 'reply', ticketId: 'ticket-nobody', text: orphanText, at: '2026-11-08T02:55:00.000Z' }
  // Deliberately put the result before the acknowledgement: the ticket link must not depend on row order.
  app.backend.messages = [request, result, ack, orphan]
  await app.flush()
  const resultNode = nodes(root.tree, node => node.props['data-superagent-source'] === result.id)[0]
  assert.ok(resultNode, 'the result row is rendered')
  const quote = nodes(resultNode, node => node.props['data-superagent-reply-to'] !== undefined)[0]
  assert.ok(quote, 'the ticket result carries the same quote block as a direct reply')
  assert.equal(quote.props['data-superagent-reply-to'], request.id)
  assert.match(contents(quote), /你这个答复界面要优化一下/)
  const orphanNode = nodes(root.tree, node => node.props['data-superagent-source'] === orphan.id)[0]
  assert.equal(nodes(orphanNode, node => node.props['data-superagent-reply-to'] !== undefined).length, 0, 'an unbound ticket result stays unquoted')
  app.dispose()
})

test('clicking a reply quote opens a right-side context pane and sends only to that context', async () => {
  const app = fixture(), root = app.mount()
  const request = { ...reply, id: 'trigger-context', role: 'user', kind: 'request', text: '原始请求：把答复界面改成话题式。', at: '2026-11-08T02:33:17.035Z' }
  const ack = { id: outboxKey('ack', request.id), role: 'assistant', kind: 'acknowledgement', text: '收到：先确认消息上下文。', at: '2026-11-08T02:33:55.378Z' }
  app.backend.messages = [request, ack]
  await app.flush()
  const quote = one(root, node => node.props['data-superagent-reply-to'] !== undefined)
  assert.equal(quote.type, 'button')
  assert.equal(quote.props.title, '在右侧查看这条消息的上下文')
  assert.equal(nodes(root.tree, node => node.type === 'aside').length, 0)
  quote.props.onClick()
  await app.flush()
  const pane = one(root, node => node.type === 'aside' && node.props['aria-label'] === '消息上下文')
  const rows = nodes(pane, node => node.props['data-superagent-context-row'] === true)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].props['data-current'], 'true')
  assert.match(contents(rows[0]), /原始请求：把答复界面改成话题式/)
  assert.equal(rows[1].props['data-reply'], 'true')
  assert.match(contents(rows[1]), /先确认消息上下文/)
  const textarea = nodes(pane, node => node.type === 'textarea')[0]
  assert.equal(textarea.props['aria-label'], '只回复这段上下文')
  textarea.props.onChange({ target: { value: '只补充这条消息' } })
  await app.flush()
  const paneAfter = one(root, node => node.type === 'aside' && node.props['aria-label'] === '消息上下文')
  const send = nodes(paneAfter, node => node.type === 'button' && contents(node) === '发送')[0]
  assert.equal(send.props.disabled, false)
  send.props.onClick()
  await app.flush()
  assert.match(app.inputSnapshot.draft, /^> 原始请求：把答复界面改成话题式。\n\n只补充这条消息$/)
  assert.deepEqual(app.inputCalls.at(-1), ['queue', 'click'])
  const paneSent = one(root, node => node.type === 'aside' && node.props['aria-label'] === '消息上下文')
  assert.equal(nodes(paneSent, node => node.props.role === 'status' && /已发送/.test(contents(node))).length, 1)
  const close = one(root, node => node.type === 'button' && node.props['aria-label'] === '关闭消息上下文')
  close.props.onClick()
  await app.flush()
  assert.equal(nodes(root.tree, node => node.type === 'aside').length, 0)
  app.dispose()
})

test('a Source reply with no resolvable human message stays unquoted instead of guessing by position', async () => {
  const app = fixture(), root = app.mount()
  app.backend.messages = [
    { ...reply, id: 'some-trigger', role: 'user', kind: 'request', text: 'earlier human message' },
    { ...reply, id: 'unrelated-result', role: 'assistant', kind: 'result', text: 'a ticket result with no direct question' },
  ]
  await app.flush()
  assert.equal(nodes(root.tree, node => node.props['data-superagent-reply-to'] !== undefined).length, 0)
  assert.equal(contents(root.tree).match(/earlier human message/g)?.length, 1)
  app.dispose()
})

test('custom Source delivery uses the native Markdown Factory with provenance, never user duplication or model events', async () => {
  const app = fixture(), root = app.mount()
  app.backend.messages = [
    { ...reply, id: 'actual-user', role: 'user', kind: 'request', text: 'native human already displayed' },
    { ...reply, id: 'source-result', kind: 'result', ticketId: 'ticket-42', text: '# Result\n**real Markdown**\nBearer do-not-display-secret\nhttps://private.invalid/path?token=secret' },
  ]
  await app.flush()
  assert.equal(nodes(root.tree, node => node.type === 'native-user-message').length, 1)
  assert.equal(contents(root.tree).match(/native human already displayed/g)?.length, 1)
  assert.match(contents(root.tree), /执行结果.*ticket-42/s)
  const markdown = one(root, node => node.type === 'native-markdown')
  assert.match(contents(markdown), /# Result\n\*\*real Markdown\*\*/)
  assert.doesNotMatch(contents(markdown), /do-not-display-secret|private.invalid/)
  assert.equal(markdown.props.running, false)
  assert.equal(app.factoryCalls.some(call => call.factory === 'conversation.chat.reasoning.content'), true)
  app.dispose()
})
