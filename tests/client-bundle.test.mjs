import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('browser bundle registers the turn-tail selector and anchors only finalized assistant turns', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
  let plugin
  const context = {
    AbortController,
    window: {
      __ModuleLoader__: {
        load(record) {
          plugin = record.factory((id) => {
            if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: Symbol('fragment') }
            if (id === 'react') {
              return {
                useCallback: value => value,
                useEffect() { throw new Error('component was mounted during registration') },
                useLayoutEffect() { throw new Error('component was mounted during registration') },
                useRef() { throw new Error('component was mounted during registration') },
                useState() { throw new Error('component was mounted during registration') },
              }
            }
            if (id === 'react-dom') return { createPortal: value => value }
            if (id === '@deepseek-ai/dsh-client-ui-primitives') {
              return { Button() {}, IconRefreshOutline16() {}, Modal() {}, Tooltip() {} }
            }
            throw new Error(`unexpected browser dependency ${id}`)
          })
        },
      },
    },
  }
  vm.runInNewContext(source, context)
  assert.ok(plugin)
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['slots', 'sessions'])
  assert.deepEqual(
    JSON.parse(JSON.stringify(plugin.selectRewindTurn({
      seq: 7,
      nodes: [{ kind: 'user', seq: 1 }, { kind: 'assistant', seq: 7, turn: 3 }],
    }))),
    { turn: 3, seq: 7 },
  )
  assert.equal(plugin.selectRewindTurn({ seq: 1, nodes: [{ kind: 'user', seq: 1 }] }), null)

  let registration
  const style = { dataset: {}, remove() {} }
  const document = {
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild() {} },
  }
  context.document = document
  let openedSession
  plugin.apply({
    effect(setup) { setup() },
    sessions: { open(sessionId) { openedSession = sessionId } },
    slots: {
      inject(name, install) { assert.equal(name, 'conversation.session.header.actions'); install() },
      register(entry, component) { registration = { entry, component }; return () => {} },
    },
  })
  assert.equal(registration.entry.name, 'conversation.session.header.actions')
  assert.equal(registration.entry.id, 'change-ledger-rewind-portals')
  const injected = registration.entry.inject()
  injected.openSession('session-child')
  assert.equal(openedSession, 'session-child')
  assert.equal(typeof registration.component, 'function')
})

test('rewind dialog scopes restore plans by mode and opens conversation results', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
  const Button = function Button() {}
  const primitives = {
    Button,
    IconRefreshOutline16: function IconRefreshOutline16() {},
    Modal: function Modal() {},
    Tooltip: function Tooltip() {},
  }
  let values = []
  let stateIndex = 0
  const react = {
    useCallback: value => value,
    useEffect() {},
    useLayoutEffect() {},
    useRef: value => ({ current: value }),
    useState(initial) {
      const index = stateIndex
      stateIndex += 1
      return [index < values.length ? values[index] : initial, () => {}]
    },
  }
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol('fragment'),
  }
  let plugin
  const context = {
    AbortController,
    window: {
      __ModuleLoader__: {
        load(record) {
          plugin = record.factory((id) => {
            if (id === 'react/jsx-runtime') return jsxRuntime
            if (id === 'react') return react
            if (id === 'react-dom') return { createPortal: value => value }
            if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
            throw new Error(`unexpected browser dependency ${id}`)
          })
        },
      },
    },
  }
  vm.runInNewContext(source, context)

  const ready = {
    status: 'ready', sessionId: 'session-source', turn: 3, checkpointId: 'rp_turn', turnEndSeq: 9,
    totalChanges: 1, changes: [{ path: 'code.txt', kind: 'modified' }], truncated: false,
    headChanged: false, operationChanged: false, planId: 'plan_1', confirmation: 'RESTORE-1',
  }

  async function run(mode, preview, acknowledged, result) {
    stateIndex = 0
    values = [true, false, preview, mode, acknowledged, false, null, null]
    let request
    let opened
    context.fetch = async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => result }
    }
    const tree = plugin.RewindTurnTail({
      matched: { turn: 3, seq: 8 },
      sessionId: 'session-source',
      openSession: id => { opened = id },
    })
    const primary = findNode(tree, node => node.type === Button && node.props.variant === 'primary')
    assert.ok(primary)
    primary.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    return { primary, request, opened }
  }

  const both = await run('both', ready, true, { mode: 'both', sessionId: 'session-child', rescuePointId: 'rp_rescue' })
  assert.equal(both.opened, 'session-child')
  assert.deepEqual(JSON.parse(both.request.options.body), {
    mode: 'both', sessionId: 'session-source', turn: 3, checkpointId: 'rp_turn',
    planId: 'plan_1', confirmation: 'RESTORE-1',
  })

  const code = await run('code', ready, true, { mode: 'code', rescuePointId: 'rp_code_rescue' })
  assert.equal(code.opened, undefined)
  assert.deepEqual(JSON.parse(code.request.options.body), {
    mode: 'code', sessionId: 'session-source', turn: 3, checkpointId: 'rp_turn',
    planId: 'plan_1', confirmation: 'RESTORE-1',
  })

  const conversation = await run(
    'conversation',
    { ...ready, headChanged: true },
    false,
    { mode: 'conversation', sessionId: 'session-conversation' },
  )
  assert.equal(conversation.primary.props.disabled, false)
  assert.equal(conversation.opened, 'session-conversation')
  assert.deepEqual(JSON.parse(conversation.request.options.body), {
    mode: 'conversation', sessionId: 'session-source', turn: 3, checkpointId: 'rp_turn',
  })

  const noCode = await run(
    'both',
    { ...ready, totalChanges: 0, changes: [], headChanged: true, planId: undefined, confirmation: undefined },
    false,
    { mode: 'both', sessionId: 'session-no-code' },
  )
  assert.equal(noCode.primary.props.disabled, false)
  assert.equal(noCode.opened, 'session-no-code')
  assert.deepEqual(JSON.parse(noCode.request.options.body), {
    mode: 'both', sessionId: 'session-source', turn: 3, checkpointId: 'rp_turn',
  })

  stateIndex = 0
  values = [true, false, { ...ready, headChanged: true }, 'both', true, false, null, null]
  const blockedTree = plugin.RewindTurnTail({
    matched: { turn: 3, seq: 8 }, sessionId: 'session-source', openSession() {},
  })
  const blocked = findNode(blockedTree, node => node.type === Button && node.props.variant === 'primary')
  assert.equal(blocked.props.disabled, true)

  stateIndex = 0
  values = [true, false, { ...ready, totalChanges: 0, changes: [] }, 'code', false, false, null, null]
  const noCodeTree = plugin.RewindTurnTail({
    matched: { turn: 3, seq: 8 }, sessionId: 'session-source', openSession() {},
  })
  const codeUnavailable = findNode(noCodeTree, node => node.type === Button && node.props.variant === 'primary')
  assert.equal(codeUnavailable.props.disabled, true)

  stateIndex = 0
  values = [true, false, { status: 'failed', error: 'transient' }, 'both', false, false, null, null]
  let retryUrl
  context.fetch = async (url) => {
    retryUrl = url
    return { ok: true, json: async () => ({ status: 'pending' }) }
  }
  const failedTree = plugin.RewindTurnTail({
    matched: { turn: 3, seq: 8 }, sessionId: 'session-source', openSession() {},
  })
  const retry = findNode(failedTree, node => node.type === Button && node.props.size === 'sm')
  retry.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(retryUrl, '/change-ledger/rewind?sessionId=session-source&turn=3&retry=1')
})

function findNode(value, predicate) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNode(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  if (predicate(value)) return value
  for (const child of Object.values(value.props ?? {})) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}
