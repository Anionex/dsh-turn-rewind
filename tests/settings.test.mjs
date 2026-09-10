import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TURN_REWIND_SETTINGS_NAMESPACE,
  TurnRewindSettingsSchema,
  installTurnRewindSettings,
} from '../lib/index.js'

/**
 * Stand-in for `ctx.settings` on either side of the DSH 0.1.5 seam: 0.1.5 moved
 * the consumer wiring onto the provider as `installSection(owner, ns, schema,
 * entry, hooks)` and deleted the free `installSettingsSection`, while older hosts
 * expose only `register`.
 * @param options - `installSection: true` mimics the 0.1.5 provider shape.
 * @returns the provider double, its recorded calls, and a resolver writer.
 */
function providerDouble({ installSection = false } = {}) {
  const calls = { registered: [], watched: [], installed: [], effects: [] }
  let resolved = TurnRewindSettingsSchema({})
  const scope = {
    get: () => resolved,
    watch(callback) {
      calls.watched.push(callback)
      return () => {}
    },
  }
  const provider = {
    register(ns, schema, options) {
      calls.registered.push({ ns, schema, options })
      return scope
    },
  }
  if (installSection) {
    // Mirrors @deepseek-ai/dsh-settings 0.1.5 `SettingsProvider.installSection`.
    provider.installSection = (owner, ns, schema, entry, hooks) => {
      calls.installed.push({ owner, ns, schema, entry, hooks })
      const installed = provider.register(ns, schema, { base: entry })
      hooks.setSource(() => installed.get())
      hooks.onChange()
      installed.watch(() => hooks.onChange())
    }
  }
  return {
    provider,
    calls,
    resolve(value) { resolved = { ...resolved, ...value } },
  }
}

/** Context double that runs the `ctx.inject(['settings'], …)` guard like the host. */
function contextDouble(settingsProvider) {
  const state = { injected: [], disposers: [], warnings: [], updates: [] }
  const scope = {
    settings: settingsProvider,
    effect(setup) {
      const disposer = setup()
      state.disposers.push(disposer)
      return () => disposer()
    },
  }
  return {
    state,
    inject(names, callback) {
      state.injected.push(names)
      if (settingsProvider !== undefined) callback(scope)
    },
    logger: { warn(message) { state.warnings.push(message) } },
  }
}

function engineDouble(state) {
  return {
    updateConfig(config) {
      state.updates.push(config)
    },
  }
}

test('the settings namespace is the plain literal the browser card binds', () => {
  assert.equal(TURN_REWIND_SETTINGS_NAMESPACE, 'turn-rewind')
  assert.match(TURN_REWIND_SETTINGS_NAMESPACE, /^[a-z][a-z0-9-]*$/u)
  assert.equal(typeof TurnRewindSettingsSchema, 'function')
  assert.equal(TurnRewindSettingsSchema({}).maxRestorePoints, 50)
})

test('the provider installSection drives the engine when the host offers one (DSH 0.1.5)', () => {
  const double = providerDouble({ installSection: true })
  const ctx = contextDouble(double.provider)
  const engine = engineDouble(ctx.state)

  installTurnRewindSettings(ctx, {}, engine)

  assert.deepEqual(ctx.state.injected, [['settings']])
  assert.equal(double.calls.installed.length, 1)
  const installed = double.calls.installed[0]
  assert.equal(installed.ns, 'turn-rewind')
  assert.equal(installed.schema, TurnRewindSettingsSchema)
  // The composition entry is both the base layer and the pre-registration value.
  assert.deepEqual(installed.entry, TurnRewindSettingsSchema({}))
  assert.equal(typeof installed.hooks.setSource, 'function')
  assert.equal(typeof installed.hooks.onChange, 'function')
  // Attaching the provider applies the resolved value, not the raw config.
  assert.deepEqual(ctx.state.updates, [installed.entry])

  double.resolve({ maxRestorePoints: 3, turnCheckpointMode: 'off' })
  for (const watcher of double.calls.watched) watcher()
  assert.equal(ctx.state.updates.length, 2)
  assert.equal(ctx.state.updates[1].maxRestorePoints, 3)
  assert.equal(ctx.state.updates[1].turnCheckpointMode, 'off')
  assert.deepEqual(ctx.state.warnings, [])
})

test('the register + get + watch fallback reproduces the removed helper on older hosts', () => {
  const double = providerDouble()
  const ctx = contextDouble(double.provider)
  const engine = engineDouble(ctx.state)

  installTurnRewindSettings(ctx, { maxFiles: 7 }, engine)

  assert.equal(double.calls.installed.length, 0)
  assert.equal(double.calls.registered.length, 1)
  assert.equal(double.calls.registered[0].ns, 'turn-rewind')
  // The entry layer is the schema defaults with the composition config layered over it.
  assert.deepEqual(double.calls.registered[0].options.base, { ...TurnRewindSettingsSchema({}), maxFiles: 7 })
  assert.equal(ctx.state.updates.length, 1)

  double.resolve({ planTtlMs: 1000 })
  for (const watcher of double.calls.watched) watcher()
  assert.equal(ctx.state.updates.length, 2)
  assert.equal(ctx.state.updates[1].planTtlMs, 1000)

  // Losing the provider falls back to the composition entry, exactly as before.
  for (const dispose of ctx.state.disposers) dispose()
  assert.equal(ctx.state.updates.length, 3)
  assert.equal(ctx.state.updates[2].maxFiles, 7)
})

test('a failed engine update is warned about, never thrown at the settings provider', () => {
  const double = providerDouble()
  const ctx = contextDouble(double.provider)
  let applied = 0
  const engine = {
    updateConfig() {
      applied += 1
      if (applied > 1) throw new Error('storage root moved')
    },
  }

  installTurnRewindSettings(ctx, {}, engine)
  double.resolve({ maxFiles: 9 })
  for (const watcher of double.calls.watched) watcher()

  assert.equal(applied, 2)
  assert.equal(ctx.state.warnings.length, 1)
  assert.match(ctx.state.warnings[0], /could not apply settings update: storage root moved/u)
})

test('absent settings service keeps the plugin on the composition entry', () => {
  const ctx = contextDouble(undefined)
  const engine = engineDouble(ctx.state)

  installTurnRewindSettings(ctx, {}, engine)

  assert.deepEqual(ctx.state.injected, [['settings']])
  assert.deepEqual(ctx.state.updates, [])
  assert.deepEqual(ctx.state.warnings, [])
})
