import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('browser bundle registers the turn-tail selector and anchors only finalized assistant turns', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
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
              return { Button() {}, Modal() {}, Tooltip() {} }
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
  assert.deepEqual(
    ['added', 'deleted', 'modified', 'mode-changed', 'type-changed'].map(kind => plugin.fileRecoveryLabel(kind)),
    ['移除后来新增的文件', '找回文件', '恢复之前的版本', '恢复文件权限', '恢复之前的文件类型'],
  )

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
  assert.equal(registration.entry.id, 'turn-rewind-portals')
  assert.match(style.textContent, /\.dcl-rewind-dialog\{[^}]*width:min\(560px,100%\)/)
  assert.match(style.textContent, /\.dcl-rewind-body\{[^}]*width:100%;min-width:0;max-width:100%;box-sizing:border-box/)
  assert.match(style.textContent, /\.dcl-rewind-trigger\{[^}]*justify-content:center;width:24px;height:24px;padding:0/)
  assert.match(style.textContent, /\[data-time-hover-root="true"\]>:last-child:has\(>\.dcl-rewind-tail\)>:not\(button\):not\(\.dcl-rewind-tail\)\{order:1\}/)
  assert.doesNotMatch(style.textContent, /min-width:min\(560px/)
  assert.doesNotMatch(style.textContent, /order:-1/)
  const injected = registration.entry.inject()
  injected.openSession('session-child')
  assert.equal(openedSession, 'session-child')
  assert.equal(typeof registration.component, 'function')
})

test('rewind dialog restores files in two modes without a duplicate confirmation', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const Button = function Button() {}
  const primitives = {
    Button,
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
    totalChanges: 1, changes: [{ path: 'code.txt', kind: 'modified' }], offset: 0, truncated: false,
    headChanged: false, operationChanged: false, activeSessionIds: [], restoreBlocked: false,
    planId: 'plan_1', confirmation: 'RESTORE-1',
  }

  async function run(mode, preview, result) {
    stateIndex = 0
    values = [true, false, preview, mode, false, false, false, null, null, null]
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

  const both = await run('both', ready, { mode: 'both', sessionId: 'session-child', rescuePointId: 'rp_rescue' })
  assert.equal(both.primary.props.children, '恢复并继续')
  assert.equal(both.opened, 'session-child')
  assert.deepEqual(JSON.parse(both.request.options.body), {
    mode: 'both', sessionId: 'session-source', turn: 3, checkpointId: 'rp_turn',
    planId: 'plan_1', confirmation: 'RESTORE-1',
  })

  const code = await run('code', ready, { mode: 'code', rescuePointId: 'rp_code_rescue' })
  assert.equal(code.primary.props.children, '恢复文件')
  assert.equal(code.opened, undefined)
  assert.deepEqual(JSON.parse(code.request.options.body), {
    mode: 'code', sessionId: 'session-source', turn: 3, checkpointId: 'rp_turn',
    planId: 'plan_1', confirmation: 'RESTORE-1',
  })

  stateIndex = 0
  values = [true, false, { ...ready, headChanged: true }, 'both', false, false, false, null, null, null]
  const blockedTree = plugin.RewindTurnTail({
    matched: { turn: 3, seq: 8 }, sessionId: 'session-source', openSession() {},
  })
  const modal = findNode(blockedTree, node => node.type === primitives.Modal)
  assert.equal(modal.props.className, 'dcl-rewind-dialog')
  assert.equal(modal.props.contentClassName, 'dcl-rewind-content')
  const trigger = findNode(blockedTree, node => node.type === 'button' && node.props.className === 'dcl-rewind-trigger')
  assert.equal(trigger.props['aria-label'], '恢复到第 3 轮结束时的文件状态')
  assert.equal(findNode(trigger, node => node.type === 'span' && node.props.children === '回退'), undefined)
  assert.ok(findNode(trigger, node => typeof node.type === 'function' && node.type.name === 'RewindIcon'))
  const blocked = findNode(blockedTree, node => node.type === Button && node.props.variant === 'primary')
  assert.equal(blocked.props.disabled, true)
  assert.equal(findNode(blockedTree, node => node.type === 'input' && node.props.type === 'checkbox'), undefined)
  assert.equal(findNode(blockedTree, node => node.type === 'strong' && node.props.children === '仅回退对话'), undefined)

  stateIndex = 0
  values = [true, false, { ...ready, totalChanges: 0, changes: [], planId: undefined, confirmation: undefined }, 'both', false, false, false, null, null, null]
  const noFilesTree = plugin.RewindTurnTail({
    matched: { turn: 3, seq: 8 }, sessionId: 'session-source', openSession() {},
  })
  const noFiles = findNode(noFilesTree, node => node.type === Button && node.props.variant === 'primary')
  assert.equal(noFiles.props.disabled, true)
  assert.ok(findNode(noFilesTree, node => node.type === 'p' && String(node.props.children).includes('分支新对话')))

  stateIndex = 0
  values = [true, false, { status: 'failed', error: 'transient' }, 'both', false, false, false, null, null, null]
  let retryUrl
  context.fetch = async (url) => {
    retryUrl = url
    return { ok: true, json: async () => ({ status: 'pending' }) }
  }
  const failedTree = plugin.RewindTurnTail({
    matched: { turn: 3, seq: 8 }, sessionId: 'session-source', openSession() {},
  })
  const retry = findNode(failedTree, node => node.type === Button && node.props.size === 'sm')
  assert.equal(retry.props.className, 'dcl-rewind-retry')
  retry.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(retryUrl, '/turn-rewind?sessionId=session-source&turn=3&retry=1')
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
