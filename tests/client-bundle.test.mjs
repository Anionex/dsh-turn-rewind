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
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['slots', 'sessions', 'conversation', 'settingsScope'])
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

  let conversationRegistration
  let settingsRegistration
  const style = { dataset: {}, remove() {} }
  context.document = {
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild() {} },
  }
  let openedSession
  let restoredDraft
  const scope = {}
  const injectedNames = []
  plugin.apply({
    effect(setup) { setup() },
    sessions: {
      open(sessionId) { openedSession = sessionId },
      scope(sessionId) { return sessionId === openedSession ? scope : undefined },
    },
    conversation: { input: { for(value) { assert.equal(value, scope); return { setDraft(text) { restoredDraft = text } } } } },
    slots: {
      inject(name, install) { injectedNames.push(name); install() },
      register(entry, component) {
        if (entry.name === 'conversation.session.header.actions') conversationRegistration = { entry, component }
        else if (entry.name === 'settings.plugin.item') settingsRegistration = { entry, component }
        else throw new Error(`unexpected slot registration ${entry.name}`)
        return () => {}
      },
    },
  })
  assert.deepEqual(injectedNames, ['conversation.session.header.actions', 'settings.plugin.item'])
  assert.equal(conversationRegistration.entry.name, 'conversation.session.header.actions')
  assert.equal(conversationRegistration.entry.id, 'turn-rewind-portals')
  assert.match(style.textContent, /\.dcl-rewind-dialog\{[^}]*width:min\(560px,100%\)/)
  assert.match(style.textContent, /\.dcl-rewind-body\{[^}]*width:100%;min-width:0;max-width:100%;box-sizing:border-box/)
  assert.match(style.textContent, /\.dcl-rewind-trigger\{[^}]*justify-content:center;width:24px;height:24px;padding:0/)
  assert.doesNotMatch(style.textContent, /:has\(>\.dcl-rewind-tail\)/)
  assert.doesNotMatch(style.textContent, /order:-1/)
  const injected = conversationRegistration.entry.inject()
  await injected.openRestoredSession('session-child', '原来的问题')
  assert.equal(openedSession, 'session-child')
  assert.equal(restoredDraft, '原来的问题')
  assert.equal(typeof conversationRegistration.component, 'function')
  assert.equal(settingsRegistration.entry.key, 'turn-rewind')
  assert.equal(typeof settingsRegistration.component, 'function')
  assert.deepEqual(JSON.parse(JSON.stringify(settingsRegistration.entry.inject())), {})
})

/**
 * Boot the browser bundle and return `apply()`'s entry, with a document double
 * small enough for the style effect.
 * @returns the registered client plugin.
 */
async function bootPluginEntry() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let plugin
  const context = {
    AbortController,
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, remove() {} }),
      head: { appendChild() {} },
    },
    window: {
      __ModuleLoader__: {
        load(record) {
          plugin = record.factory(id => {
            if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: Symbol('fragment') }
            if (id === 'react') {
              return {
                useCallback: value => value,
                useEffect() {},
                useLayoutEffect() {},
                useMemo: compute => compute(),
                useRef: value => ({ current: value }),
                useState: initial => [initial, () => {}],
                useSyncExternalStore: () => undefined,
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
  return plugin
}

/**
 * Context double with Cordis's own access rule: reading an undeclared service off
 * the proxy throws before optional chaining can apply, while a declared service the
 * profile does not mount reads as `undefined`.
 * @param plugin - entry whose `inject` list is the declaration set.
 * @param services - services the web profile provides.
 * @returns a proxied context.
 */
function cordisLikeContext(plugin, services) {
  const core = new Set(['effect', 'inject', 'on', 'emit', 'get', 'set', 'provide', 'logger', 'fiber'])
  const declared = new Set(plugin.inject)
  const target = { effect(setup) { return setup() }, ...services }
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string' && !core.has(property) && !declared.has(property)) {
        throw new Error(`cannot get property "${property}" without inject`)
      }
      return Reflect.get(object, property)
    },
  })
}

test('the client declares every service it reads, and survives an absent settingsScope', async () => {
  const plugin = await bootPluginEntry()
  const bound = []
  const registered = []
  const slots = {
    inject(name, install) { install() },
    register(entry) { registered.push(entry); return () => {} },
  }
  const profile = {
    slots,
    sessions: { open() {}, scope: () => undefined },
    conversation: { input: { for: () => ({ setDraft() {} }) } },
    settingsScope: { bind(spec) { bound.push(spec); return { namespace: spec.namespace } } },
  }

  // `settingsScope` was the undeclared read that crashed the 0.1.5 settings card.
  plugin.apply(cordisLikeContext(plugin, profile))
  const card = registered.find(entry => entry.name === 'settings.plugin.item')
  assert.deepEqual(JSON.parse(JSON.stringify(card.inject())), { scope: { namespace: 'turn-rewind' } })
  // The card binds the same namespace literal the host section registers.
  assert.deepEqual(JSON.parse(JSON.stringify(bound)), [{ namespace: 'turn-rewind' }])

  // The service is optional: declared, so reading it must not throw; absent, so the
  // card registers without a scope instead of taking the profile down.
  registered.length = 0
  bound.length = 0
  plugin.apply(cordisLikeContext(plugin, {
    slots,
    sessions: profile.sessions,
    conversation: profile.conversation,
  }))
  assert.deepEqual(bound, [])
  assert.deepEqual(JSON.parse(JSON.stringify(
    registered.find(entry => entry.name === 'settings.plugin.item').inject(),
  )), {})
})

const CHAT_NODE = {
  key: '13:input-messageabc',
  kind: 'user',
  data: { kind: 'user', seq: 7, content: [{ type: 'text', text: '修复问题' }] },
}

/** Boot the browser bundle against a minimal DOM double for portal-target tests. */
async function bootPortalBridge(shape = 'current') {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let plugin
  let capturedTargets
  let cleanup
  class Element {}
  const actions = new Element()
  // DSH 0.1.5 renders the icon-actions row (class `<hash>_actions`) as a direct child
  // of the user-message row and removed `data-time-hover-root`; older clients nested
  // that row under the removed wrapper, which stays a supported fallback.
  const messageRoot = Object.assign(new Element(), {
    lastElementChild: actions,
    querySelector: selector => selector === '[class*="actions"]' ? actions : null,
  })
  const row = Object.assign(new Element(), {
    dataset: { chatAnchorKey: '13:input-messageabc' },
    querySelector(selector) {
      if (selector === '[class*="actions"]') return shape === 'current' ? actions : null
      if (selector === '[data-time-hover-root="true"]') return shape === 'legacy' ? messageRoot : null
      throw new Error(`unexpected row query ${selector}`)
    },
  })
  const context = {
    AbortController,
    HTMLElement: Element,
    MutationObserver: class MutationObserver {
      constructor(callback) { this.callback = callback }
      observe() {}
      disconnect() {}
    },
    queueMicrotask,
    setTimeout,
    document: {
      body: {},
      querySelectorAll(selector) {
        assert.equal(selector, '[data-chat-flow-kind="user"][data-chat-anchor-key]')
        return [row]
      },
    },
    window: {
      __ModuleLoader__: {
        load(record) {
          plugin = record.factory((id) => {
            if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: Symbol('fragment') }
            if (id === 'react') {
              return {
                useCallback: value => value,
                useEffect() {},
                useLayoutEffect(setup) { cleanup = setup() },
                useMemo: compute => compute(),
                useRef: value => ({ current: value }),
                useState(initial) {
                  return [initial, update => {
                    capturedTargets = typeof update === 'function' ? update(initial) : update
                  }]
                },
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
  return {
    plugin,
    actions,
    shape,
    targets: () => capturedTargets,
    dispose: () => { if (typeof cleanup === 'function') cleanup() },
  }
}

test('browser bundle finds the 0.1.5 actions row through the 0.1.1 session chat projection', async () => {
  const harness = await bootPortalBridge()
  const rendered = harness.plugin.RewindMessagePortals({
    sessionId: 'session-source',
    async openRestoredSession() {},
    useSession(selector) {
      return selector({
        nodes: [],
        chat: {
          nodes: {
            values() {
              return [CHAT_NODE]
            },
          },
        },
      })
    },
  })

  assert.equal(rendered.length, 0)
  const targets = harness.targets()
  assert.equal(targets.length, 1)
  assert.equal(targets[0].container, harness.actions)
  assert.deepEqual(JSON.parse(JSON.stringify(targets[0].matched)), {
    messageSeq: 7,
    promptText: '修复问题',
  })
  harness.dispose()
})

test('browser bundle keeps following the pre-0.1.5 time-hover wrapper', async () => {
  const harness = await bootPortalBridge('legacy')
  const rendered = harness.plugin.RewindMessagePortals({
    sessionId: 'session-source',
    async openRestoredSession() {},
    useChat(selector) {
      return selector({ order: ['13:input-messageabc'], nodes: { get: () => CHAT_NODE } })
    },
  })

  assert.equal(rendered.length, 0)
  const targets = harness.targets()
  assert.equal(targets.length, 1)
  assert.equal(targets[0].container, harness.actions)
  harness.dispose()
})

test('browser bundle follows the 0.1.2 chat hook order and node store', async () => {
  const harness = await bootPortalBridge()
  const store = {
    get(key) {
      assert.equal(key, '13:input-messageabc')
      return CHAT_NODE
    },
  }
  const rendered = harness.plugin.RewindMessagePortals({
    sessionId: 'session-source',
    async openRestoredSession() {},
    useSession() {
      throw new Error('useSession must not be read while useChat is provided')
    },
    useChat(selector) {
      return selector({ order: ['13:input-messageabc'], nodes: store })
    },
  })

  assert.equal(rendered.length, 0)
  const targets = harness.targets()
  assert.equal(targets.length, 1)
  assert.equal(targets[0].container, harness.actions)
  assert.deepEqual(JSON.parse(JSON.stringify(targets[0].matched)), {
    messageSeq: 7,
    promptText: '修复问题',
  })
  harness.dispose()
})

test('browser bundle stays inert when neither snapshot exposes chat nodes', async () => {
  const harness = await bootPortalBridge()
  const rendered = harness.plugin.RewindMessagePortals({
    sessionId: 'session-source',
    async openRestoredSession() {},
    useSession(selector) {
      return selector({
        sessionId: 'session-source',
        running: false,
        openState: 'ready',
      })
    },
  })

  assert.equal(rendered.length, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(harness.targets())), [])
  harness.dispose()
})

test('chat node collection accepts keyed stores, legacy arrays, and absent projections', async () => {
  const harness = await bootPortalBridge()
  const { collectChatNodes } = harness.plugin

  assert.deepEqual(JSON.parse(JSON.stringify(collectChatNodes(null, null))), [])
  assert.equal(collectChatNodes(['missing'], { get: () => undefined }).length, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(collectChatNodes(['13:input-messageabc'], {
    get: key => key === '13:input-messageabc' ? CHAT_NODE : undefined,
  }))), [JSON.parse(JSON.stringify(CHAT_NODE))])
  assert.deepEqual(JSON.parse(JSON.stringify(collectChatNodes(null, [CHAT_NODE]))), [JSON.parse(JSON.stringify(CHAT_NODE))])
  assert.deepEqual(JSON.parse(JSON.stringify(collectChatNodes(null, {
    get: () => undefined,
    values: () => [CHAT_NODE],
  }))), [JSON.parse(JSON.stringify(CHAT_NODE))])
  assert.deepEqual(JSON.parse(JSON.stringify(collectChatNodes(null, { get: () => undefined }))), [])
  harness.dispose()
})

test('rewind responses never leak raw JSON parse errors', async () => {
  const harness = await bootPortalBridge()
  const { responseJson } = harness.plugin
  const respond = (ok, status, body) => ({ ok, status, text: async () => body })

  await assert.rejects(
    () => responseJson(respond(false, 404, '')),
    error => error.code === 'REWIND_ENDPOINT_UNAVAILABLE' && error.message.includes('404'),
  )
  await assert.rejects(
    () => responseJson(respond(false, 502, '<html>bad gateway</html>')),
    error => error.code === 'REWIND_ENDPOINT_UNAVAILABLE',
  )
  await assert.rejects(
    () => responseJson(respond(true, 200, '')),
    error => error.code === 'REWIND_INVALID_RESPONSE',
  )
  await assert.rejects(
    () => responseJson(respond(true, 200, 'not json')),
    error => error.code === 'REWIND_INVALID_RESPONSE',
  )
  await assert.rejects(
    () => responseJson(respond(false, 500, JSON.stringify({ code: 'REWIND_FAILED', error: 'boom' }))),
    error => error.code === 'REWIND_FAILED' && error.message === 'boom',
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(await responseJson(respond(true, 200, JSON.stringify({ status: 'missing' }))))),
    { status: 'missing' },
  )
  harness.dispose()
})

test('checkpoint failures are explained in user terms', async () => {
  const harness = await bootPortalBridge()
  const { explainCheckpointFailure } = harness.plugin

  assert.equal(
    explainCheckpointFailure('[GIT_COMMAND_FAILED] git rev-parse --show-toplevel failed in "/tmp/x": fatal: not a git repository (or any of the parent directories): .git'),
    '这个项目目录不是 Git 仓库，回退功能无法保存文件检查点。仍可只回溯消息。',
  )
  assert.match(
    explainCheckpointFailure('[FILE_TOO_LARGE] "big.bin" is 104857600 bytes; configured maximum is 16777216'),
    /大小或数量上限/,
  )
  assert.match(explainCheckpointFailure('[WORKSPACE_LOCKED] busy'), /没能保存这条消息发送前的文件/)
  harness.dispose()
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
      return { ok: true, status: 200, text: async () => JSON.stringify(result) }
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

  const messages = await run('messages', ready, { mode: 'messages', sessionId: 'session-child' })
  assert.equal(messages.primary.props.children, '只回溯消息')
  assert.equal(messages.primary.props.disabled, false)
  assert.equal(messages.opened, 'session-child')
  assert.equal(messages.restoredPrompt, '修复这个问题')
  assert.deepEqual(JSON.parse(messages.request.options.body), {
    mode: 'messages', sessionId: 'session-source', messageSeq: 2,
  })
  assert.equal(findNode(messages.tree, node => node.type === 'p' && String(node.props.children).includes('项目文件保持不变')), undefined)
  const radios = collectNodes(messages.tree, node => node.type === 'input' && node.props.type === 'radio')
  assert.equal(radios.length, 3)
  assert.ok(radios.every(radio => radio.props.disabled === false))

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
  assert.ok(findNode(noFilesTree, node => node.type === 'p' && String(node.props.children).includes('只回溯消息')))
  const noFilesRadios = collectNodes(noFilesTree, node => node.type === 'input' && node.props.type === 'radio')
  assert.deepEqual(noFilesRadios.map(radio => radio.props.disabled), [true, true, false])

  stateIndex = 0
  values = [true, false, { status: 'skipped', reason: '[TURN_CHECKPOINT_TIMEOUT] automatic checkpoint exceeded 5000 ms' }, 'messages', false, false, false, null, null]
  const skippedMessagesTree = plugin.RewindMessageAction({
    matched: { messageSeq: 2, promptText: '修复这个问题' }, sessionId: 'session-source', async openRestoredSession() {},
  })
  const skippedMessages = findNode(skippedMessagesTree, node => node.type === Button && node.props.variant === 'primary')
  assert.equal(skippedMessages.props.disabled, false)
  assert.equal(skippedMessages.props.children, '只回溯消息')

  stateIndex = 0
  values = [true, false, { status: 'skipped', reason: '[TURN_CHECKPOINT_TIMEOUT] automatic checkpoint exceeded 5000 ms' }, 'both', false, false, false, null, null]
  const skippedTree = plugin.RewindMessageAction({
    matched: { messageSeq: 2, promptText: '修复这个问题' }, sessionId: 'session-source', async openRestoredSession() {},
  })
  assert.ok(findNode(skippedTree, node => node.type === 'p'
    && String(node.props.children).includes('这个项目目录太大')))

  stateIndex = 0
  values = [true, false, { status: 'failed', error: 'transient' }, 'both', false, false, false, null, null]
  let retryUrl
  context.fetch = async (url) => {
    retryUrl = url
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'pending' }) }
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
  return collectNodes(value, predicate)[0]
}

function collectNodes(value, predicate) {
  const found = []
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (predicate(node)) found.push(node)
    for (const child of Object.values(node.props ?? {})) visit(child)
  }
  visit(value)
  return found
}

test('settings card renders the namespace form and manages checkpoints', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let plugin
  const stateValues = new Map()
  const effectsRun = new Set()
  const Button = function Button() {}
  const primitives = { Button, Modal: function Modal() {}, Tooltip: function Tooltip() {} }
  const snapshot = {
    status: 'ready',
    value: {
      maxRestorePoints: 50, maxTurnCheckpointsPerSession: 30, maxFiles: 20000, maxFileBytes: 16777216,
      maxSnapshotBytes: 536870912, planTtlMs: 900000, staleLockMs: 30000, turnCheckpointMode: 'legacy',
      turnCheckpointTimeoutMs: 5000, turnCheckpointMaxNewBytes: 33554432, turnCheckpointTrust: 'fast',
    },
    base: {}, user: { turnCheckpointMode: 'off' }, revision: 7, writable: true, mode: 'host',
  }
  const writes = []
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    async set(field, value) { writes.push({ op: 'set', field, value }) },
    async unset(field) { writes.push({ op: 'unset', field }) },
  }
  const requests = []
  const manageOverview = {
    storageDir: '/tmp/state',
    totalBytes: 2048,
    workspaces: [{
      workspace: '/tmp/project-a',
      totalBytes: 2048,
      recoveryCount: 1,
      restorePoints: [{
        id: 'rp_abc123_def012345678', kind: 'turn', format: 2, createdAt: 1756000000000, totalBytes: 2048, fileCount: 3,
        sessionId: 'session-a',
      }],
    }],
  }
  const context = {
    AbortController,
    setTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200, text: async () => JSON.stringify(options?.method === 'POST'
        ? {
            status: 'partial', action: 'clear-all',
            reports: [{ deletedRestorePoints: 1, retainedRestorePoints: 1 }],
            failures: [{ workspace: '/tmp/project-b', error: 'locked' }],
          }
        : manageOverview) }
    },
    window: {
      __ModuleLoader__: {
        load(record) {
          plugin = record.factory((id) => {
            if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('fragment') }
            if (id === 'react') {
              return {
                useCallback(value) {
                  const index = hookIndex
                  hookIndex += 1
                  if (!stateValues.has(index)) stateValues.set(index, { memo: value })
                  return stateValues.get(index).memo
                },
                useEffect(setup) {
                  hookIndex += 1
                  if (effectsRun.has('card')) return undefined
                  effectsRun.add('card')
                  const cleanup = setup()
                  return cleanup
                },
                useLayoutEffect() {},
                useRef: value => ({ current: value }),
                useState(initial) {
                  const index = hookIndex
                  hookIndex += 1
                  if (!stateValues.has(index)) stateValues.set(index, initial)
                  const current = stateValues.get(index)
                  return [current, (next) => { stateValues.set(index, typeof next === 'function' ? next(current) : next) }]
                },
                useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
              }
            }
            if (id === 'react-dom') return { createPortal: value => value }
            if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
            throw new Error(`unexpected browser dependency ${id}`)
          })
        },
      },
    },
  }
  let hookIndex = 0
  vm.runInNewContext(source, context)
  const render = () => {
    hookIndex = 0
    return plugin.TurnRewindSettingsCard({ scope })
  }
  // The card is a collapsed disclosure, matching the official plugin cards.
  const head = findNode(render(), node => node.type === 'button' && node.props.className === 'dcl-trs-card-head')
  assert.equal(head.props['aria-expanded'], false)
  head.props.onClick()
  const first = render()
  const selects = collectNodes(first, node => node.type === 'select')
  assert.equal(selects.length, 2)
  assert.equal(selects[0].props.value, 'legacy')
  assert.deepEqual(JSON.parse(JSON.stringify(selects[0].props.children.map(option => option.props.value))), ['off', 'git-native', 'legacy'])
  assert.ok(collectNodes(first, node => node.type === 'span' && node.props.className === 'dcl-trs-override').length >= 1)
  selects[0].props.onChange({ target: { value: 'off' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(writes, [{ op: 'set', field: 'turnCheckpointMode', value: 'off' }])

  const second = render()
  const numberInput = findNode(second, node => node.type === 'input' && node.props.type === 'number')
  assert.equal(numberInput.props.value, '50')
  numberInput.props.onChange({ target: { value: '3' } })
  const third = render()
  const edited = findNode(third, node => node.type === 'input' && node.props.type === 'number' && node.props.value === '3')
  edited.props.onBlur()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(writes.slice(1), [{ op: 'set', field: 'maxRestorePoints', value: 3 }])

  assert.ok(findNode(third, node => node.type === 'p' && String(node.props.children).includes('/tmp/state')))
  assert.ok(findNode(third, node => node.type === 'span' && String(node.props.title) === '/tmp/project-a'))
  assert.equal(collectNodes(third, node => node.props?.className === 'dcl-trs-badge' && String(node.props.children).includes('个恢复待处理')).length, 1)
  assert.equal(requests.filter(request => request.options?.method === 'GET').length, 1)

  const clearAll = findNode(third, node => node.type === Button && String(node.props.children) === '一键清空全部')
  clearAll.props.onClick()
  const fourth = render()
  const confirm = findNode(fourth, node => node.type === Button && String(node.props.children) === '确认清空全部')
  confirm.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  const posts = requests.filter(request => request.options?.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].options.body), { action: 'clear-all' })
  assert.equal(requests.filter(request => request.options?.method === 'GET').length, 2)
  const fifth = render()
  const notice = findNode(fifth, node => node.props?.className === 'dcl-trs-notice')
  assert.equal(notice.props['data-warning'], true)
  assert.match(String(notice.props.children), /1 个受保护检查点未删除/)
  assert.match(String(notice.props.children), /1 个工作区清理失败/)
})

test('partial checkpoints explain which files stay untouched', async () => {
  const harness = await bootPortalBridge()
  const { describeCaptureNotice } = harness.plugin
  const base = { skippedCount: 0, skipped: [] }

  assert.equal(describeCaptureNotice(null), null)
  assert.equal(describeCaptureNotice({ ...base, captureTruncated: undefined }), null)
  assert.match(
    describeCaptureNotice({ ...base, skippedCount: 2, skipped: [{ path: 'artifacts/big.bin', reason: 'file-too-large' }] }),
    /2 个文件.*artifacts\/big\.bin/s,
  )
  assert.match(describeCaptureNotice({ ...base, captureTruncated: 'snapshot-limit' }), /总量超过上限/)
  assert.match(describeCaptureNotice({ ...base, captureTruncated: 'file-limit' }), /文件数量超过上限/)
  harness.dispose()
})
