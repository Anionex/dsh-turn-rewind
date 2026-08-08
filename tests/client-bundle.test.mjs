import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('browser bundle registers the turn-tail selector and anchors only finalized assistant turns', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
  let plugin
  const context = {
    window: {
      __ModuleLoader__: {
        load(record) {
          plugin = record.factory((id) => {
            if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: Symbol('fragment') }
            if (id === 'react') return { useCallback: value => value, useState() { throw new Error('component was mounted during registration') } }
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
  plugin.apply({
    effect(setup) { setup() },
    slots: {
      inject(name, install) { assert.equal(name, 'conversation.chat.turnTail'); install() },
      register(entry, component) { registration = { entry, component }; return () => {} },
    },
  })
  assert.equal(registration.entry.name, 'conversation.chat.turnTail')
  assert.equal(typeof registration.component, 'function')
})
