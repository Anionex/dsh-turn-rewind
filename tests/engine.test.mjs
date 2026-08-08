import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { ChangeLedgerEngine, ChangeLedgerError, LEDGER_FORMAT_VERSION, resolveConfig } from '../dist/index.js'

const execFileAsync = promisify(execFile)

async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-test-'))
  const workspace = join(outer, 'workspace')
  const storageDir = join(outer, 'state')
  await mkdir(workspace)
  await git(workspace, 'init', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Change Ledger Test')
  await git(workspace, 'config', 'user.email', 'change-ledger@example.invalid')
  const engine = new ChangeLedgerEngine({ storageDir, staleLockMs: 1 })
  await engine.initialize()
  return {
    outer,
    workspace,
    storageDir,
    engine,
    async cleanup() {
      await rm(outer, { recursive: true, force: true })
    },
  }
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout.trim()
}

async function seedCommitted(workspace, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(workspace, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  await git(workspace, 'add', '--all')
  await git(workspace, 'commit', '-m', 'seed')
}

test('creates and lists a content-addressed restore point without Git side effects', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'src/main.txt': 'alpha\n', '.gitignore': 'ignored/\n' })
  await mkdir(join(f.workspace, 'ignored'))
  await writeFile(join(f.workspace, 'ignored/cache.bin'), Buffer.alloc(128, 7))
  await writeFile(join(f.workspace, 'notes.txt'), 'untracked but eligible\n')
  await git(f.workspace, 'add', 'src/main.txt')
  const indexBefore = await git(f.workspace, 'diff', '--cached', '--binary')

  const created = await f.engine.create({ cwd: f.workspace, sessionId: 'session-a', label: 'Before refactor' })
  assert.match(created.id, /^rp_[0-9a-z]+_[0-9a-f]{12}$/)
  assert.equal(created.kind, 'user')
  assert.equal(created.fileCount, 3)
  assert.equal(created.stagedPathCount, 0)
  assert.equal((await f.engine.list({ cwd: f.workspace })).length, 1)
  assert.equal(await git(f.workspace, 'diff', '--cached', '--binary'), indexBefore)
})

test('captures hidden turn checkpoints, finds them by session turn, and restores their code state', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'src/main.txt': 'turn one\n' })

  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace,
    sessionId: 'session-web',
    turn: 1,
    turnEndSeq: 9,
  })
  assert.equal(checkpoint.kind, 'turn')
  assert.equal(checkpoint.turn, 1)
  assert.equal(checkpoint.turnEndSeq, 9)
  assert.equal((await f.engine.list({ cwd: f.workspace })).length, 0)
  assert.equal((await f.engine.list({ cwd: f.workspace, includeTurnCheckpoints: true })).length, 1)
  assert.equal((await f.engine.findTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 1 }))?.id, checkpoint.id)

  await writeFile(join(f.workspace, 'src/main.txt'), 'turn two\n')
  const plan = await f.engine.planRestore({
    cwd: f.workspace,
    restorePointId: checkpoint.id,
    sessionId: 'session-web',
  })
  await f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation, sessionId: 'session-web' })
  assert.equal(await readFile(join(f.workspace, 'src/main.txt'), 'utf8'), 'turn one\n')
})

test('turn checkpoint retention prunes only the oldest checkpoint in the same session', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.engine = new ChangeLedgerEngine({
    storageDir: f.storageDir,
    staleLockMs: 1,
    maxTurnCheckpointsPerSession: 2,
  })
  await f.engine.initialize()
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const first = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 1, turnEndSeq: 3 })
  await writeFile(join(f.workspace, 'state.txt'), 'two\n')
  const second = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 2, turnEndSeq: 7 })
  const other = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's2', turn: 1, turnEndSeq: 4 })
  await writeFile(join(f.workspace, 'state.txt'), 'three\n')
  const third = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 3, turnEndSeq: 11 })

  const points = await f.engine.list({ cwd: f.workspace, includeTurnCheckpoints: true })
  assert.deepEqual(new Set(points.map(point => point.id)), new Set([second.id, third.id, other.id]))
  assert.equal(await f.engine.findTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 1 }), undefined)
  await assert.rejects(
    f.engine.inspect({ cwd: f.workspace, restorePointId: first.id }),
    error => error instanceof ChangeLedgerError && error.code === 'RESTORE_POINT_NOT_FOUND',
  )
})

test('worktree discovery preserves legal trailing spaces in the root path', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-space-test-'))
  t.after(async () => rm(outer, { recursive: true, force: true }))
  const workspace = join(outer, 'workspace ')
  await mkdir(workspace)
  await git(workspace, 'init', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Change Ledger Test')
  await git(workspace, 'config', 'user.email', 'change-ledger@example.invalid')
  await seedCommitted(workspace, { 'a.txt': 'a\n' })
  const engine = new ChangeLedgerEngine({ storageDir: join(outer, 'state') })

  const point = await engine.create({ cwd: workspace })
  assert.equal(point.workspace, await realpath(workspace))
})

test('inspect classifies add, delete, content, mode, and symlink changes', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, {
    'delete.txt': 'remove me\n',
    'modify.txt': 'before\n',
    'mode.sh': '#!/bin/sh\nexit 0\n',
    'target-a.txt': 'a\n',
    'target-b.txt': 'b\n',
  })
  await symlink('target-a.txt', join(f.workspace, 'link.txt'))
  await git(f.workspace, 'add', 'link.txt')
  await git(f.workspace, 'commit', '-m', 'add symlink')
  const point = await f.engine.create({ cwd: f.workspace })

  await rm(join(f.workspace, 'delete.txt'))
  await writeFile(join(f.workspace, 'modify.txt'), 'after\n')
  await chmod(join(f.workspace, 'mode.sh'), 0o755)
  await rm(join(f.workspace, 'link.txt'))
  await symlink('target-b.txt', join(f.workspace, 'link.txt'))
  await writeFile(join(f.workspace, 'added.txt'), 'new\n')

  const inspection = await f.engine.inspect({ cwd: f.workspace, restorePointId: point.id })
  assert.deepEqual(
    Object.fromEntries(inspection.changes.map((change) => [change.path, change.kind])),
    {
      'added.txt': 'added',
      'delete.txt': 'deleted',
      'link.txt': 'modified',
      'mode.sh': 'mode-changed',
      'modify.txt': 'modified',
    },
  )
})

test('full restore is two-step, approval-ready, verified, and reversible through a rescue point', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'keep.txt': 'original\n', 'delete.txt': 'present\n' })
  const point = await f.engine.create({ cwd: f.workspace, sessionId: 'session-a' })

  await writeFile(join(f.workspace, 'keep.txt'), 'changed\n')
  await rm(join(f.workspace, 'delete.txt'))
  await writeFile(join(f.workspace, 'new.txt'), 'created later\n')
  const stagedBefore = await git(f.workspace, 'diff', '--cached', '--binary')

  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id, sessionId: 'session-a' })
  assert.equal(plan.paths.length, 3)
  await assert.rejects(
    f.engine.applyRestore({ planId: plan.id, confirmation: 'WRONG', sessionId: 'session-a' }),
    (error) => error instanceof ChangeLedgerError && error.code === 'CONFIRMATION_MISMATCH',
  )
  const result = await f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation, sessionId: 'session-a' })
  assert.equal(await readFile(join(f.workspace, 'keep.txt'), 'utf8'), 'original\n')
  assert.equal(await readFile(join(f.workspace, 'delete.txt'), 'utf8'), 'present\n')
  await assert.rejects(lstat(join(f.workspace, 'new.txt')), { code: 'ENOENT' })
  assert.equal(await git(f.workspace, 'diff', '--cached', '--binary'), stagedBefore)

  const all = await f.engine.list({ cwd: f.workspace, includeRescue: true })
  const rescue = all.find((entry) => entry.id === result.rescuePointId)
  assert.equal(rescue?.kind, 'rescue')
  const rescuePlan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: result.rescuePointId, sessionId: 'session-a' })
  await f.engine.applyRestore({ planId: rescuePlan.id, confirmation: rescuePlan.confirmation, sessionId: 'session-a' })
  assert.equal(await readFile(join(f.workspace, 'keep.txt'), 'utf8'), 'changed\n')
  await assert.rejects(lstat(join(f.workspace, 'delete.txt')), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.workspace, 'new.txt'), 'utf8'), 'created later\n')
})

test('selective restore changes only reviewed paths', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'a.txt'), 'a1\n')
  await writeFile(join(f.workspace, 'b.txt'), 'b1\n')

  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id, paths: ['a.txt'] })
  await f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation })
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'a0\n')
  assert.equal(await readFile(join(f.workspace, 'b.txt'), 'utf8'), 'b1\n')
})

test('a plan becomes stale when a selected path changes after review', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a0\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'a.txt'), 'a1\n')
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id })
  await writeFile(join(f.workspace, 'a.txt'), 'a2\n')
  await assert.rejects(
    f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation }),
    (error) => error instanceof ChangeLedgerError && error.code === 'PLAN_STALE',
  )
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'a2\n')
})

test('planning refuses to overwrite an ignored file omitted from the current snapshot', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { '.gitignore': '' })
  await writeFile(join(f.workspace, 'scratch.txt'), 'restore-point content\n')
  const point = await f.engine.create({ cwd: f.workspace })

  await writeFile(join(f.workspace, '.gitignore'), 'scratch.txt\n')
  await writeFile(join(f.workspace, 'scratch.txt'), 'valuable ignored content\n')
  await assert.rejects(
    f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id, paths: ['scratch.txt'] }),
    (error) => error instanceof ChangeLedgerError && error.code === 'UNMANAGED_PATH_CONFLICT',
  )
  assert.equal(await readFile(join(f.workspace, 'scratch.txt'), 'utf8'), 'valuable ignored content\n')
})

test('apply rechecks for an ignored file created after restore planning', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { '.gitignore': '' })
  await writeFile(join(f.workspace, 'scratch.txt'), 'restore-point content\n')
  const point = await f.engine.create({ cwd: f.workspace })
  await rm(join(f.workspace, 'scratch.txt'))
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id, paths: ['scratch.txt'] })

  await writeFile(join(f.workspace, '.gitignore'), 'scratch.txt\n')
  await writeFile(join(f.workspace, 'scratch.txt'), 'created after review\n')
  await assert.rejects(
    f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation }),
    (error) => error instanceof ChangeLedgerError && error.code === 'UNMANAGED_PATH_CONFLICT',
  )
  assert.equal(await readFile(join(f.workspace, 'scratch.txt'), 'utf8'), 'created after review\n')
})

test('HEAD changes are blocked unless explicitly reviewed', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a0\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'a.txt'), 'a1\n')
  await git(f.workspace, 'add', 'a.txt')
  await git(f.workspace, 'commit', '-m', 'advance head')

  await assert.rejects(
    f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id }),
    (error) => error instanceof ChangeLedgerError && error.code === 'HEAD_CHANGED',
  )
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id, allowHeadChange: true })
  assert.equal(plan.allowHeadChange, true)
})

test('an explicitly reviewed HEAD drift does not authorize later HEAD changes', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a0\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'a.txt'), 'a1\n')
  await git(f.workspace, 'add', 'a.txt')
  await git(f.workspace, 'commit', '-m', 'first reviewed head change')
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id, allowHeadChange: true })

  await writeFile(join(f.workspace, 'b.txt'), 'later commit\n')
  await git(f.workspace, 'add', 'b.txt')
  await git(f.workspace, 'commit', '-m', 'unreviewed later head change')
  await assert.rejects(
    f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation }),
    (error) => error instanceof ChangeLedgerError && error.code === 'PLAN_STALE_REPOSITORY',
  )
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'a1\n')
})

test('failed restore rolls back to the rescue snapshot', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'baseline\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'a.txt'), 'current\n')
  const inspection = await f.engine.inspect({ cwd: f.workspace, restorePointId: point.id })
  const baselineBlob = inspection.changes[0]?.before?.kind === 'file' ? inspection.changes[0].before.blob : undefined
  assert.ok(baselineBlob)
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id })

  const originalReadBlob = f.engine.store.readBlob.bind(f.engine.store)
  const originalWriteOperation = f.engine.store.writeOperation.bind(f.engine.store)
  f.engine.store.readBlob = async (workspace, hash) => {
    if (hash === baselineBlob) throw new Error('injected blob read failure')
    return originalReadBlob(workspace, hash)
  }
  f.engine.store.writeOperation = async (operation) => {
    if (operation.state === 'rollback-running') throw new Error('injected journal write failure')
    return originalWriteOperation(operation)
  }
  await assert.rejects(
    f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation }),
    (error) => error instanceof ChangeLedgerError
      && error.code === 'RESTORE_FAILED_ROLLED_BACK'
      && error.message.includes('journal warning'),
  )
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'current\n')
})

test('startup marks a non-terminal operation interrupted and exposes its rescue path', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a\n' })
  const original = await f.engine.create({ cwd: f.workspace })
  const rescue = await f.engine.create({ cwd: f.workspace })
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: `op_${Date.now().toString(36)}_abcdefabcdef`,
    workspace: original.workspace,
    restorePointId: original.id,
    rescuePointId: rescue.id,
    paths: ['a.txt'],
    startedAt: Date.now(),
    state: 'running',
  })

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 1)
  const recovery = await restarted.listRecovery({ cwd: f.workspace })
  assert.equal(recovery.length, 1)
  assert.equal(recovery[0]?.state, 'interrupted')
  assert.equal(recovery[0]?.rescuePointId, rescue.id)
})

test('delete requires exact confirmation and garbage-collects only unreferenced blobs', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'shared\n' })
  const first = await f.engine.create({ cwd: f.workspace })
  const second = await f.engine.create({ cwd: f.workspace })
  await assert.rejects(
    f.engine.delete({ cwd: f.workspace, restorePointId: first.id, confirmation: 'yes' }),
    (error) => error instanceof ChangeLedgerError && error.code === 'CONFIRMATION_MISMATCH',
  )
  const one = await f.engine.delete({ cwd: f.workspace, restorePointId: first.id, confirmation: `DELETE ${first.id}` })
  assert.equal(one.deletedBlobs, 0)
  const two = await f.engine.delete({ cwd: f.workspace, restorePointId: second.id, confirmation: `DELETE ${second.id}` })
  assert.ok(two.deletedBlobs >= 1)
})

test('symlink contents round-trip without following the target', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'target-a': 'a', 'target-b': 'b' })
  await symlink('target-a', join(f.workspace, 'link'))
  await git(f.workspace, 'add', 'link')
  await git(f.workspace, 'commit', '-m', 'link')
  const point = await f.engine.create({ cwd: f.workspace })
  await rm(join(f.workspace, 'link'))
  await symlink('target-b', join(f.workspace, 'link'))
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id })
  await f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation })
  assert.equal(await readlink(join(f.workspace, 'link')), 'target-a')
})

test('configured size limits fail loudly instead of silently omitting files', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'large.bin': '0123456789' })
  const limited = new ChangeLedgerEngine({ storageDir: join(f.outer, 'small-state'), maxFileBytes: 4 })
  await assert.rejects(
    limited.create({ cwd: f.workspace }),
    (error) => error instanceof ChangeLedgerError && error.code === 'FILE_TOO_LARGE',
  )
})

test('startup does not steal an active process lock', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a\n' })
  const original = await f.engine.create({ cwd: f.workspace })
  const rescue = await f.engine.create({ cwd: f.workspace })
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: `op_${Date.now().toString(36)}_123456abcdef`,
    workspace: original.workspace,
    restorePointId: original.id,
    rescuePointId: rescue.id,
    paths: ['a.txt'],
    startedAt: Date.now(),
    state: 'running',
  })
  const release = await f.engine.store.acquire(original.workspace)
  try {
    const concurrent = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
    assert.equal(await concurrent.initialize(), 0)
  } finally {
    await release()
  }
  const afterCrash = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await afterCrash.initialize(), 1)
})

test('restore plans expire and are bound to their creating session', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'before\n' })
  const expiring = new ChangeLedgerEngine({ storageDir: join(f.outer, 'expiring-state'), planTtlMs: 200 })
  const point = await expiring.create({ cwd: f.workspace, sessionId: 'session-a' })
  await writeFile(join(f.workspace, 'a.txt'), 'after\n')
  const plan = await expiring.planRestore({ cwd: f.workspace, restorePointId: point.id, sessionId: 'session-a' })
  await assert.rejects(
    expiring.applyRestore({ planId: plan.id, confirmation: plan.confirmation, sessionId: 'session-b' }),
    (error) => error instanceof ChangeLedgerError && error.code === 'SESSION_MISMATCH',
  )
  await new Promise((resolve) => setTimeout(resolve, 220))
  await assert.rejects(
    expiring.applyRestore({ planId: plan.id, confirmation: plan.confirmation, sessionId: 'session-a' }),
    (error) => error instanceof ChangeLedgerError && error.code === 'PLAN_NOT_FOUND',
  )
})

test('state storage may not overlap the managed workspace', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a\n' })
  const overlapping = new ChangeLedgerEngine({ storageDir: join(f.workspace, '.ledger-state') })
  await assert.rejects(
    overlapping.create({ cwd: f.workspace }),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_WORKSPACE_OVERLAP',
  )
  await assert.rejects(
    overlapping.list({ cwd: f.workspace }),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_WORKSPACE_OVERLAP',
  )
})

test('sparse checkouts and submodule gitlinks fail loudly', async (t) => {
  const sparse = await fixture()
  t.after(sparse.cleanup)
  await seedCommitted(sparse.workspace, { 'a.txt': 'a\n' })
  await git(sparse.workspace, 'config', 'core.sparseCheckout', 'true')
  await assert.rejects(
    sparse.engine.create({ cwd: sparse.workspace }),
    (error) => error instanceof ChangeLedgerError && error.code === 'SPARSE_CHECKOUT_UNSUPPORTED',
  )

  const submodule = await fixture()
  t.after(submodule.cleanup)
  await seedCommitted(submodule.workspace, { 'a.txt': 'a\n' })
  const head = await git(submodule.workspace, 'rev-parse', 'HEAD')
  await git(submodule.workspace, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/example`)
  await assert.rejects(
    submodule.engine.create({ cwd: submodule.workspace }),
    (error) => error instanceof ChangeLedgerError && error.code === 'SUBMODULE_UNSUPPORTED',
  )
})

test('invalid Git boolean configuration is not mistaken for an absent optional value', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a\n' })
  await git(f.workspace, 'config', 'core.sparseCheckout', 'not-a-boolean')
  await assert.rejects(
    f.engine.create({ cwd: f.workspace }),
    (error) => error instanceof ChangeLedgerError && error.code === 'GIT_COMMAND_FAILED',
  )
})

test('a failed manifest write leaves no orphaned content blobs', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'content\n' })
  const originalWriteManifest = f.engine.store.writeManifest.bind(f.engine.store)
  f.engine.store.writeManifest = async () => {
    throw new Error('injected manifest failure')
  }
  await assert.rejects(f.engine.create({ cwd: f.workspace }), /injected manifest failure/)
  f.engine.store.writeManifest = originalWriteManifest
  const gc = await f.engine.store.collectGarbage(await realpath(f.workspace))
  assert.deepEqual(gc, { deletedBlobs: 0, retainedBlobs: 0 })
  const point = await f.engine.create({ cwd: f.workspace })
  assert.equal(point.fileCount, 1)
})

test('durable manifests are rejected when their tree hash does not match their entries', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'content\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  const workspaceKey = createHash('sha256').update(await realpath(f.workspace)).digest('hex')
  const manifestPath = join(f.storageDir, 'workspaces', workspaceKey, 'manifests', `${point.id}.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.treeHash = '0'.repeat(64)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  await assert.rejects(
    f.engine.store.readManifest(await realpath(f.workspace), point.id),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
})

test('the blob store rejects content that does not match its requested address', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const workspace = await realpath(f.workspace)
  await assert.rejects(
    f.engine.store.putBlob(workspace, '0'.repeat(64), Buffer.from('different content')),
    (error) => error instanceof ChangeLedgerError && error.code === 'BLOB_HASH_MISMATCH',
  )
})

test('default storage follows DSH_HOME', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-home-test-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    assert.equal(resolveConfig({}).storageDir, join(root, 'change-ledger', 'v1'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
