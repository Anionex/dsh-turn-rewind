import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TURN_REWIND_SETTINGS_NAMESPACE,
  TurnRewindSettingsSchema,
  installTurnRewindSettings,
  ChangeLedgerService,
} from '../lib/index.js'

/**
 * DSH 0.1.7 removed the settings-namespace `register`/`installSection` API and
 * instead projects a plugin's `Config` schema into an editable form
 * automatically. These tests pin that new contract: the schema is the plugin's
 * `Config`, its tunable fields are `.volatile()`, and the legacy
 * `installTurnRewindSettings` wiring is a no-op on 0.1.7 hosts.
 */

test('the settings namespace is the plain literal the browser card resolves', () => {
  assert.equal(TURN_REWIND_SETTINGS_NAMESPACE, 'turn-rewind')
  assert.match(TURN_REWIND_SETTINGS_NAMESPACE, /^[a-z][a-z0-9-]*$/u)
  assert.equal(typeof TurnRewindSettingsSchema, 'function')
})

test('the schema doubles as the plugin Config and validates a plain config', () => {
  // The schema is the source of truth for the settings form, exposed as the
  // service class's static Config so cordis resolves it off the default export.
  assert.equal(ChangeLedgerService.Config, TurnRewindSettingsSchema)

  // Volatile fields resolve to Volatile holders after validation (cordis then
  // reads them via .get()); the defaults are the plain values underneath.
  const resolved = TurnRewindSettingsSchema({})
  assert.equal(resolved.maxRestorePoints.get(), 50)
  assert.equal(resolved.turnCheckpointMode.get(), 'auto')
  assert.equal(resolved.turnCheckpointTrust.get(), 'fast')
})

test('every tunable field is volatile for live settings projection', () => {
  // 0.1.7 projects `.volatile()` fields into an editable form and restarts the
  // plugin on edit. Every tunable field must be marked volatile; storageDir is
  // deliberately absent (composition-only, never editable online).
  const schema = TurnRewindSettingsSchema
  for (const key of [
    'maxRestorePoints',
    'maxTurnCheckpointsPerSession',
    'maxFiles',
    'maxFileBytes',
    'maxSnapshotBytes',
    'planTtlMs',
    'staleLockMs',
    'turnCheckpointMode',
    'turnCheckpointTimeoutMs',
    'turnCheckpointMaxNewBytes',
    'turnCheckpointTrust',
  ]) {
    assert.equal(schema.dict[key]?.meta?.volatile, true, `${key} must be volatile`)
  }
  assert.equal(schema.dict.storageDir, undefined, 'storageDir must stay composition-only')
})

test('installTurnRewindSettings is a no-op on 0.1.7 hosts', () => {
  // 0.1.7 derives the settings section from the Config schema and edits restart
  // the plugin via cordis update(), so the legacy register/installSection wiring
  // must inject nothing and touch neither the engine nor any settings provider.
  const injected = []
  const warnings = []
  let updates = 0
  const ctx = {
    inject(names) {
      injected.push(names)
    },
    logger: { warn(message) { warnings.push(message) } },
  }
  const engine = { updateConfig() { updates += 1 } }

  installTurnRewindSettings(ctx, { maxFiles: 7 }, engine)

  assert.deepEqual(injected, [])
  assert.equal(updates, 0)
  assert.deepEqual(warnings, [])
})