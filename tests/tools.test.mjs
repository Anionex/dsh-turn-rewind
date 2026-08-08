import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTools } from '../dist/tools.js'

function harness(engine) {
  const definitions = new Map()
  let gate
  let disposeEffect
  const ctx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    effect(callback) {
      disposeEffect = callback()
    },
    on(name, callback) {
      assert.equal(name, 'tools/pre-execute')
      gate = callback
      return () => { gate = undefined }
    },
  }
  registerTools(ctx, engine)
  return {
    definitions,
    exec: {
      agent: { id: 'session-a', session: { header: { cwd: '/workspace' } } },
      signal: new AbortController().signal,
    },
    gate: (...args) => gate(...args),
    dispose: () => disposeEffect(),
  }
}

test('registers the complete tool surface and disposes it as one effect', () => {
  const h = harness({})
  assert.deepEqual([...h.definitions.keys()], [
    'change_ledger_create',
    'change_ledger_list',
    'change_ledger_inspect',
    'change_ledger_plan_restore',
    'change_ledger_apply_restore',
    'change_ledger_delete',
    'change_ledger_recovery_list',
  ])
  h.dispose()
  assert.equal(h.definitions.size, 0)
})

test('destructive tools ask for approval while read-only tools delegate', async () => {
  const h = harness({})
  assert.deepEqual(
    await h.gate({ name: 'change_ledger_apply_restore' }, async () => ({ kind: 'allow' })),
    { kind: 'ask', reason: 'Apply the reviewed workspace restore plan after creating a rescue point.' },
  )
  assert.deepEqual(
    await h.gate({ name: 'change_ledger_delete' }, async () => ({ kind: 'allow' })),
    { kind: 'ask', reason: 'Permanently delete a change-ledger restore point and unreferenced blobs.' },
  )
  assert.deepEqual(
    await h.gate({ name: 'change_ledger_list' }, async () => ({ kind: 'allow' })),
    { kind: 'allow' },
  )
})

test('inspect and restore results remain bounded for model-visible output', async () => {
  const changes = Array.from({ length: 350 }, (_, index) => ({
    path: `src/${String(index).padStart(3, '0')}.ts`,
    kind: 'modified',
    before: { kind: 'file' },
    after: { kind: 'file' },
  }))
  const engine = {
    async list() {
      return Array.from({ length: 350 }, (_, index) => ({
        id: `rp_${index}`,
        kind: 'user',
        workspace: '/workspace',
      }))
    },
    async inspect() {
      return {
        restorePoint: { id: 'rp_x', kind: 'user' },
        currentTreeHash: 'hash',
        headChanged: false,
        operationChanged: false,
        changes,
      }
    },
    async planRestore() {
      return {
        id: 'plan_x',
        restorePointId: 'rp_x',
        workspace: '/workspace',
        expiresAt: 123,
        confirmation: 'RESTORE-ABCD',
        allowHeadChange: false,
        paths: changes.map((change) => change.path),
        changes,
      }
    },
    async applyRestore() {
      return {
        operationId: 'op_x',
        restorePointId: 'rp_x',
        rescuePointId: 'rp_rescue',
        restoredPaths: changes.map((change) => change.path),
      }
    },
    async listRecovery() {
      return Array.from({ length: 80 }, (_, index) => ({
        operationId: `op_${index}`,
        restorePointId: `rp_original_${index}`,
        rescuePointId: `rp_rescue_${index}`,
        state: 'recovery-required',
        paths: changes.map((change) => change.path),
        startedAt: index,
        error: 'x'.repeat(3_000),
      }))
    },
  }
  const h = harness(engine)
  const listed = await h.definitions.get('change_ledger_list').execute({ offset: 100, limit: 200 }, h.exec)
  assert.equal(listed.totalRestorePoints, 350)
  assert.equal(listed.restorePoints.length, 200)
  assert.equal(listed.restorePoints[0].id, 'rp_100')
  assert.equal(listed.hasMore, true)

  const inspected = await h.definitions.get('change_ledger_inspect').execute({
    restore_point_id: 'rp_x',
    offset: 100,
    limit: 200,
  }, h.exec)
  assert.equal(inspected.totalChanges, 350)
  assert.equal(inspected.changes.length, 200)
  assert.equal(inspected.hasMore, true)
  assert.deepEqual(inspected.changes[0], {
    path: 'src/100.ts',
    kind: 'modified',
    beforeType: 'file',
    afterType: 'file',
  })

  const planned = await h.definitions.get('change_ledger_plan_restore').execute({ restore_point_id: 'rp_x' }, h.exec)
  assert.equal(planned.pathCount, 350)
  assert.equal(planned.pathsPreview.length, 100)
  assert.equal(planned.pathsTruncated, true)

  const applied = await h.definitions.get('change_ledger_apply_restore').execute({
    plan_id: 'plan_x',
    confirmation: 'RESTORE-ABCD',
  }, h.exec)
  assert.equal(applied.restoredPathCount, 350)
  assert.equal(applied.restoredPathsPreview.length, 100)
  assert.equal(applied.pathsTruncated, true)

  const recovery = await h.definitions.get('change_ledger_recovery_list').execute({ offset: 10, limit: 50 }, h.exec)
  assert.equal(recovery.totalOperations, 80)
  assert.equal(recovery.operations.length, 50)
  assert.equal(recovery.operations[0].operationId, 'op_10')
  assert.equal(recovery.operations[0].pathCount, 350)
  assert.equal(recovery.operations[0].pathsPreview.length, 20)
  assert.equal(recovery.operations[0].pathsTruncated, true)
  assert.equal(recovery.operations[0].error.length, 2_003)
  assert.equal(recovery.hasMore, true)
})

test('tool adapter requires a DSH agent workspace', async () => {
  const h = harness({ async list() { return [] } })
  await assert.rejects(
    h.definitions.get('change_ledger_list').execute({}, { signal: new AbortController().signal }),
    /AGENT_REQUIRED/,
  )
  await assert.rejects(
    h.definitions.get('change_ledger_list').execute({}, {
      agent: { id: 'session-a', session: { header: {} } },
      signal: new AbortController().signal,
    }),
    /WORKSPACE_REQUIRED/,
  )
})
