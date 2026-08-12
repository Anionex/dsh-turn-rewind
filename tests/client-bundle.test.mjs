import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('browser bundle anchors rewind to direct user messages and restores their draft text', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let plugin
  const context = {
    AbortController,
    setTimeout,
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
            if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button() {}, Modal() {}, Tooltip() {} }
            throw new Error(`unexpected browser dependency ${id}`)
          })
        },
      },
    },
  }
  vm.runInNewContext(source, context)
  assert.ok(plugin)
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['slots', 'sessions', 'conversation'])
  assert.deepEqual(
    JSON.parse(JSON.stringify(plugin.selectRewindMessage({
      kind: 'user', seq: 7,
      content: [{ type: 'text', text: '先改 A' }, { type: 'image', url: 'ignored' }, { type: 'text', text: '再改 B' }],
    }))),
    { messageSeq: 7, promptText: '先改 A\n再改 B' },
  )
  assert.equal(plugin.selectRewindMessage({ kind: 'assistant', seq: 8, turn: 3 }), null)
  assert.deepEqual(
    JSON.parse(JSON.stringify(plugin.selectRewindMessageTarget({
      key: '13:input-messageabc',
      kind: 'user',
      data: { kind: 'user', seq: 7, content: [{ type: 'text', text: '先改 A' }] },
    }))),
    {
      matched: { messageSeq: 7, promptText: '先改 A' },
      rowKey: '13:input-messageabc',
    },
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(plugin.selectRewindMessageTarget({
      kind: 'user', seq: 8, content: [{ type: 'text', text: '旧版消息' }],
    }))),
    {
      matched: { messageSeq: 8, promptText: '旧版消息' },
      rowKey: 'node:8',
    },
  )
  assert.deepEqual(
    ['added', 'deleted', 'modified', 'mode-changed', 'type-changed'].map(kind => plugin.fileRecoveryLabel(kind)),
    ['移除后来新增的文件', '找回文件', '恢复之前的版本', '恢复文件权限', '恢复之前的文件类型'],
  )

  let registration
  const style = { dataset: {}, remove() {} }
  context.document = {
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild() {} },
  }
  let openedSession
  let restoredDraft
  const scope = {}
  plugin.apply({
    effect(setup) { setup() },
    sessions: {
      open(sessionId) { openedSession = sessionId },
      scope(sessionId) { return sessionId === openedSession ? scope : undefined },
    },
    conversation: { input: { for(value) { assert.equal(value, scope); return { setDraft(text) { restoredDraft = text } } } } },
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
  assert.doesNotMatch(style.textContent, /:has\(>\.dcl-rewind-tail\)/)
  assert.doesNotMatch(style.textContent, /order:-1/)
  const injected = registration.entry.inject()
  await injected.openRestoredSession('session-child', '原来的问题')
  assert.equal(openedSession, 'session-child')
  assert.equal(restoredDraft, '原来的问题')
  assert.equal(typeof registration.component, 'function')
})

test('rewind dialog restores files in two modes and allows reviewed Git history drift', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const Button = function Button() {}
  const primitives = { Button, Modal: function Modal() {}, Tooltip: function Tooltip() {} }
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
    setTimeout,
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
    status: 'ready', sessionId: 'session-source', messageSeq: 2, turn: 3,
    checkpointId: 'rp_turn', turnStartSeq: 1,
    totalChanges: 1, changes: [{ path: 'code.txt', kind: 'modified' }], offset: 0, truncated: false,
    headChanged: false, operationChanged: false, activeSessionIds: [], restoreBlocked: false,
    planId: 'plan_1', confirmation: 'RESTORE-1',
  }

  async function run(mode, preview, result) {
    stateIndex = 0
    values = [true, false, preview, mode, false, false, false, null, null]
    let request
    let opened
    let restoredPrompt
    context.fetch = async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => result }
    }
    const tree = plugin.RewindMessageAction({
      matched: { messageSeq: 2, promptText: '修复这个问题' },
      sessionId: 'session-source',
      async openRestoredSession(id, prompt) { opened = id; restoredPrompt = prompt },
    })
    const primary = findNode(tree, node => node.type === Button && node.props.variant === 'primary')
    assert.ok(primary)
    primary.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    return { primary, request, opened, restoredPrompt, tree }
  }

  const both = await run('both', ready, { mode: 'both', sessionId: 'session-child', rescuePointId: 'rp_rescue' })
  assert.equal(both.primary.props.children, '恢复并从这里继续')
  assert.equal(both.opened, 'session-child')
  assert.equal(both.restoredPrompt, '修复这个问题')
  assert.deepEqual(JSON.parse(both.request.options.body), {
    mode: 'both', sessionId: 'session-source', messageSeq: 2, checkpointId: 'rp_turn',
    planId: 'plan_1', confirmation: 'RESTORE-1',
  })

  const code = await run('code', ready, { mode: 'code', rescuePointId: 'rp_code_rescue' })
  assert.equal(code.primary.props.children, '恢复文件')
  assert.equal(code.opened, undefined)

  const advancedHead = await run('both', {
    ...ready, headChanged: true, checkpointHead: 'old', currentHead: 'new',
  }, { mode: 'both', sessionId: 'session-child', rescuePointId: 'rp_rescue' })
  assert.equal(advancedHead.primary.props.disabled, false)
  assert.ok(findNode(advancedHead.tree, node => node.type === 'p' && String(node.props.children).includes('不会撤销提交')))

  stateIndex = 0
  values = [true, false, { ...ready, operationChanged: true, restoreBlocked: true, planId: undefined, confirmation: undefined }, 'both', false, false, false, null, null]
  const blockedTree = plugin.RewindMessageAction({
    matched: { messageSeq: 2, promptText: '修复这个问题' }, sessionId: 'session-source', async openRestoredSession() {},
  })
  const modal = findNode(blockedTree, node => node.type === primitives.Modal)
  assert.equal(modal.props.title, '恢复到发送这条消息之前')
  const trigger = findNode(blockedTree, node => node.type === 'button' && node.props.className === 'dcl-rewind-trigger')
  assert.equal(trigger.props['aria-label'], '恢复到发送这条消息之前')
  assert.ok(findNode(trigger, node => typeof node.type === 'function' && node.type.name === 'RewindIcon'))
  const blocked = findNode(blockedTree, node => node.type === Button && node.props.variant === 'primary')
  assert.equal(blocked.props.disabled, true)
  assert.equal(findNode(blockedTree, node => node.type === 'input' && node.props.type === 'checkbox'), undefined)

  stateIndex = 0
  values = [true, false, { ...ready, totalChanges: 0, changes: [], planId: undefined, confirmation: undefined }, 'both', false, false, false, null, null]
  const noFilesTree = plugin.RewindMessageAction({
    matched: { messageSeq: 2, promptText: '修复这个问题' }, sessionId: 'session-source', async openRestoredSession() {},
  })
  const noFiles = findNode(noFilesTree, node => node.type === Button && node.props.variant === 'primary')
  assert.equal(noFiles.props.disabled, true)
  assert.ok(findNode(noFilesTree, node => node.type === 'p' && String(node.props.children).includes('分支新对话')))

  stateIndex = 0
  values = [true, false, { status: 'failed', error: 'transient' }, 'both', false, false, false, null, null]
  let retryUrl
  context.fetch = async (url) => {
    retryUrl = url
    return { ok: true, json: async () => ({ status: 'pending' }) }
  }
  const failedTree = plugin.RewindMessageAction({
    matched: { messageSeq: 2, promptText: '修复这个问题' }, sessionId: 'session-source', async openRestoredSession() {},
  })
  const retry = findNode(failedTree, node => node.type === Button && node.props.size === 'sm')
  assert.equal(retry.props.className, 'dcl-rewind-retry')
  retry.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(retryUrl, '/turn-rewind?sessionId=session-source&messageSeq=2')
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
