import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { ChangeLedgerEngine, ChangeLedgerError, LEDGER_FORMAT_VERSION, resolveConfig } from '../lib/index.js'
import { captureGitTurnCheckpoint, publishGitCheckpoint } from '../lib/git-checkpoint.js'
import { ensureGitWorktreeIdentity } from '../lib/git.js'
import { ensureStoreId, LedgerStore } from '../lib/store.js'

const execFileAsync = promisify(execFile)

async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-test-'))
  const workspace = join(outer, 'workspace')
  const storageDir = join(outer, 'state')
  await mkdir(workspace)
  await git(workspace, 'init', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Change Ledger Test')
  await git(workspace, 'config', 'user.email', 'change-ledger@example.invalid')
  const engine = new ChangeLedgerEngine({ storageDir, staleLockMs: 1, turnCheckpointMode: 'git-native' })
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
  await seedCommitted(f.workspace, { 'src/main.txt': 'turn one\n', 'src/unchanged.txt': 'stable\n' })

  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace,
    sessionId: 'session-web',
    turn: 1,
    turnStartSeq: 4,
  })
  assert.equal(checkpoint.kind, 'turn')
  assert.equal(checkpoint.turn, 1)
  assert.equal(checkpoint.turnStartSeq, 4)
  assert.equal((await f.engine.list({ cwd: f.workspace })).length, 0)
  assert.equal((await f.engine.list({ cwd: f.workspace, includeTurnCheckpoints: true })).length, 1)
  assert.equal((await f.engine.findTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 1 }))?.id, checkpoint.id)

  await writeFile(join(f.workspace, 'src/main.txt'), 'turn two\n')
  const inspection = await f.engine.inspect({ cwd: f.workspace, restorePointId: checkpoint.id })
  assert.deepEqual(inspection.changes.map(change => change.path), ['src/main.txt'])
  assert.equal(inspection.changes[0]?.after?.kind, 'file')
  assert.equal(inspection.changes[0]?.after?.provider, undefined)
  const plan = await f.engine.planRestore({
    cwd: f.workspace,
    restorePointId: checkpoint.id,
    sessionId: 'session-web',
  })
  assert.deepEqual(plan.paths, ['src/main.txt'])
  await f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation, sessionId: 'session-web' })
  assert.equal(await readFile(join(f.workspace, 'src/main.txt'), 'utf8'), 'turn one\n')
})

test('Git-native comparison hashes current files with the repository object format', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-sha256-test-'))
  const workspace = join(outer, 'workspace')
  const storageDir = join(outer, 'state')
  t.after(async () => rm(outer, { recursive: true, force: true }))
  await mkdir(workspace)
  try {
    await execFileAsync('git', ['-C', workspace, 'init', '--object-format=sha256', '-b', 'main'], { encoding: 'utf8' })
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error)
    if (/object-format|sha-?256|hash algorithm/i.test(detail)) {
      t.skip('installed Git does not support SHA-256 repositories')
      return
    }
    throw error
  }
  await git(workspace, 'config', 'user.name', 'Change Ledger Test')
  await git(workspace, 'config', 'user.email', 'change-ledger@example.invalid')
  await seedCommitted(workspace, { 'changed.txt': 'before\n', 'unchanged.txt': 'stable\n' })
  const engine = new ChangeLedgerEngine({ storageDir, staleLockMs: 1, turnCheckpointMode: 'git-native' })
  await engine.initialize()
  const checkpoint = await engine.createTurnCheckpoint({
    cwd: workspace, sessionId: 'session-sha256', turn: 1, turnStartSeq: 1,
  })

  await writeFile(join(workspace, 'changed.txt'), 'after\n')
  const inspection = await engine.inspect({ cwd: workspace, restorePointId: checkpoint.id })
  assert.deepEqual(inspection.changes.map(change => change.path), ['changed.txt'])
  assert.equal(inspection.changes[0]?.after?.provider, undefined)
  const plan = await engine.planRestore({ cwd: workspace, restorePointId: checkpoint.id })
  assert.deepEqual(plan.paths, ['changed.txt'])
  await engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation })
  assert.equal(await readFile(join(workspace, 'changed.txt'), 'utf8'), 'before\n')
})

test('Git-native turn checkpoints preserve HEAD, index, and worktree trees without touching the real index', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'head\n' })
  await writeFile(join(f.workspace, 'state.txt'), 'index\n')
  await git(f.workspace, 'add', 'state.txt')
  await writeFile(join(f.workspace, 'state.txt'), 'worktree\n')
  await writeFile(join(f.workspace, 'untracked.txt'), 'untracked\n')
  const statusBefore = await git(f.workspace, 'status', '--porcelain=v2', '--untracked-files=all')
  const indexBefore = await readFile(join(f.workspace, '.git', 'index'))

  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-v2', turn: 1, turnStartSeq: 1,
  })
  const manifest = await f.engine.store.readManifest(point.workspace, point.id)
  assert.equal(point.format, 2)
  assert.equal(point.trust, 'metadata-fenced')
  assert.equal(manifest.version, 2)
  assert.equal(await git(f.workspace, 'show', `${manifest.git.headTree}:state.txt`), 'head')
  assert.equal(await git(f.workspace, 'show', `${manifest.git.indexTree}:state.txt`), 'index')
  assert.equal(await git(f.workspace, 'show', `${manifest.git.worktreeTree}:state.txt`), 'worktree')
  assert.equal(await git(f.workspace, 'show', `${manifest.git.worktreeTree}:untracked.txt`), 'untracked')
  assert.equal(await git(f.workspace, 'rev-parse', manifest.git.ref), manifest.git.commit)
  assert.deepEqual(await readFile(join(f.workspace, '.git', 'index')), indexBefore)
  assert.equal(await git(f.workspace, 'status', '--porcelain=v2', '--untracked-files=all'), statusBefore)
})

test('Git-native capture reuses clean Git blobs and cached dirty blobs', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.engine = new ChangeLedgerEngine({
    storageDir: f.storageDir,
    staleLockMs: 1,
    turnCheckpointMode: 'git-native',
    maxFileBytes: 64,
    turnCheckpointMaxNewBytes: 1,
  })
  await f.engine.initialize()
  await seedCommitted(f.workspace, { 'large-clean.txt': 'clean content larger than raw budget\n' })
  const clean = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-cache', turn: 1, turnStartSeq: 1,
  })
  const cleanManifest = await f.engine.store.readManifest(clean.workspace, clean.id)
  assert.equal(cleanManifest.version, 2)
  assert.equal(cleanManifest.git.newlyStoredBytes, 0)

  f.engine = new ChangeLedgerEngine({
    storageDir: f.storageDir,
    staleLockMs: 1,
    turnCheckpointMode: 'git-native',
    maxFileBytes: 64,
    turnCheckpointMaxNewBytes: 64,
  })
  await f.engine.initialize()
  await writeFile(join(f.workspace, 'dirty.txt'), 'stable dirty content\n')
  const first = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-cache', turn: 2, turnStartSeq: 5,
  })
  const firstManifest = await f.engine.store.readManifest(first.workspace, first.id)
  assert.equal(firstManifest.version, 2)
  assert.ok(firstManifest.git.newlyStoredBytes > 0)
  const second = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-cache', turn: 3, turnStartSeq: 9,
  })
  const secondManifest = await f.engine.store.readManifest(second.workspace, second.id)
  assert.equal(secondManifest.version, 2)
  assert.equal(secondManifest.git.newlyStoredBytes, 0)
})

test('Git-native checkpoint publication never executes repository-controlled hooks', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const marker = join(f.outer, 'hook-ran')
  const hooksDir = join(f.workspace, '.git', 'dsh-turn-rewind', 'empty-hooks')
  await mkdir(hooksDir, { recursive: true })
  const hook = join(hooksDir, 'reference-transaction')
  await writeFile(hook, `#!/bin/sh\nprintf ran > ${marker}\n`)
  await chmod(hook, 0o755)
  await git(f.workspace, 'config', 'core.hooksPath', hooksDir)

  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-hook-isolation', turn: 1, turnStartSeq: 1,
  })
  await f.engine.delete({
    cwd: f.workspace,
    restorePointId: point.id,
    confirmation: `DELETE ${point.id}`,
  })
  await assert.rejects(readFile(marker), (error) => error?.code === 'ENOENT')
})

test('clean tracked Git blobs still obey maxFileBytes', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'large-clean.txt': '12345' })
  const limited = new ChangeLedgerEngine({
    storageDir: join(f.outer, 'clean-file-limit-state'),
    turnCheckpointMode: 'git-native',
    maxFileBytes: 4,
  })
  await limited.initialize()
  await assert.rejects(
    limited.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-clean-limit', turn: 1, turnStartSeq: 1 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'FILE_TOO_LARGE',
  )
})

test('core.filemode=false rewrites a mismatched executable bit in the private worktree tree', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX executable bits are unavailable')
  const f = await fixture()
  t.after(f.cleanup)
  const script = join(f.workspace, 'script.sh')
  await writeFile(script, '#!/bin/sh\n')
  await chmod(script, 0o755)
  await git(f.workspace, 'add', 'script.sh')
  await git(f.workspace, 'commit', '-m', 'add executable')
  await git(f.workspace, 'config', 'core.filemode', 'false')
  await chmod(script, 0o644)
  assert.equal(await git(f.workspace, 'status', '--porcelain'), '')

  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-filemode-false', turn: 1, turnStartSeq: 1,
  })
  const manifest = await f.engine.store.readManifest(point.workspace, point.id)
  assert.equal(manifest.version, 2)
  assert.equal(manifest.entries['script.sh']?.mode, 0o644)
  assert.match(await git(f.workspace, 'ls-tree', manifest.git.worktreeTree, 'script.sh'), /^100644 blob /)
})

test('deleting a Git-native checkpoint removes its exact private ref', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-delete-v2', turn: 1, turnStartSeq: 1,
  })
  const manifest = await f.engine.store.readManifest(point.workspace, point.id)
  assert.equal(manifest.version, 2)
  await f.engine.delete({ cwd: f.workspace, restorePointId: point.id, confirmation: `DELETE ${point.id}` })
  await assert.rejects(git(f.workspace, 'rev-parse', '--verify', manifest.git.ref))
})

test('startup removes a private ref left before manifest publication', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const release = await f.engine.store.acquire(await realpath(f.workspace), identity.lockPath, identity)
  await release()
  const prepared = (await captureGitTurnCheckpoint({
    cwd: f.workspace,
    id: `rp_${Date.now().toString(36)}_111111111111`,
    sessionId: 'session-publish-crash',
    turn: 1,
    turnStartSeq: 1,
    config: f.engine.config,
  })).manifest
  await f.engine.store.writeGitCheckpointJournal('publish', prepared)
  await publishGitCheckpoint(prepared, f.storageDir)
  assert.equal(await git(f.workspace, 'rev-parse', prepared.git.ref), prepared.git.commit)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 1)
  await assert.rejects(git(f.workspace, 'rev-parse', '--verify', prepared.git.ref))
  await assert.rejects(restarted.store.readManifest(prepared.workspace, prepared.id),
    (error) => error instanceof ChangeLedgerError && error.code === 'RESTORE_POINT_NOT_FOUND')
})

test('startup completes publication when the manifest was durable before journal cleanup', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const release = await f.engine.store.acquire(await realpath(f.workspace), identity.lockPath, identity)
  await release()
  const prepared = (await captureGitTurnCheckpoint({
    cwd: f.workspace,
    id: `rp_${Date.now().toString(36)}_222222222222`,
    sessionId: 'session-manifest-crash',
    turn: 1,
    turnStartSeq: 1,
    config: f.engine.config,
  })).manifest
  await f.engine.store.writeGitCheckpointJournal('publish', prepared)
  await publishGitCheckpoint(prepared, f.storageDir)
  await f.engine.store.writeManifest(prepared)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 1)
  assert.equal((await restarted.store.readManifest(prepared.workspace, prepared.id)).id, prepared.id)
  assert.equal(await git(f.workspace, 'rev-parse', prepared.git.ref), prepared.git.commit)
  assert.deepEqual(await restarted.store.listGitCheckpointJournals(), [])
})

test('startup refuses a Git checkpoint journal owned by another storage root without deleting its ref', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const other = new ChangeLedgerEngine({
    storageDir: join(f.outer, 'other-owned-state'), staleLockMs: 1, turnCheckpointMode: 'git-native',
  })
  await other.initialize()
  const point = await other.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-other-store', turn: 1, turnStartSeq: 1,
  })
  const manifest = await other.store.readManifest(point.workspace, point.id)
  assert.equal(manifest.version, 2)
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const release = await f.engine.store.acquire(await realpath(f.workspace), identity.lockPath, identity)
  await release()
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  const journalDir = join(f.storageDir, 'workspaces', workspaceKey, 'git-journals')
  await mkdir(journalDir, { recursive: true })
  await writeFile(join(journalDir, `${manifest.id}.json`), `${JSON.stringify({
    version: 1,
    action: 'publish',
    storeId: manifest.git.storeId,
    workspace: manifest.workspace,
    commonDir: manifest.repository.commonDir,
    worktreeId: manifest.git.worktreeId,
    restorePointId: manifest.id,
    ref: manifest.git.ref,
    commit: manifest.git.commit,
    createdAt: Date.now(),
  }, null, 2)}\n`)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  await assert.rejects(
    restarted.initialize(),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
  assert.equal(await git(f.workspace, 'rev-parse', manifest.git.ref), manifest.git.commit)
  assert.equal((await other.store.readManifest(manifest.workspace, manifest.id)).id, manifest.id)
})

test('one linked worktree cannot delete another linked worktree checkpoint from a copied manifest', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linkedA = join(f.outer, 'linked-owner-a')
  const linkedB = join(f.outer, 'linked-owner-b')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-owner-a-branch', linkedA)
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-owner-b-branch', linkedB)
  await f.engine.createTurnCheckpoint({ cwd: linkedA, sessionId: 'session-owner-a', turn: 1, turnStartSeq: 1 })
  const pointB = await f.engine.createTurnCheckpoint({ cwd: linkedB, sessionId: 'session-owner-b', turn: 1, turnStartSeq: 1 })
  const manifestB = await f.engine.store.readManifest(pointB.workspace, pointB.id)
  assert.equal(manifestB.version, 2)
  const identityA = await ensureGitWorktreeIdentity(linkedA)
  const workspaceA = await realpath(linkedA)
  const workspaceKeyA = `git-${createHash('sha256').update(`${identityA.commonDir}\0${identityA.worktreeId}`).digest('hex')}`
  const copiedPath = join(f.storageDir, 'workspaces', workspaceKeyA, 'manifests', `${pointB.id}.json`)
  await writeFile(copiedPath, `${JSON.stringify({
    ...manifestB,
    workspace: workspaceA,
    repository: { ...manifestB.repository, root: workspaceA },
  }, null, 2)}\n`)

  await assert.rejects(
    f.engine.delete({ cwd: linkedA, restorePointId: pointB.id, confirmation: `DELETE ${pointB.id}` }),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
  assert.equal(await git(linkedB, 'rev-parse', manifestB.git.ref), manifestB.git.commit)
  assert.equal((await f.engine.store.readManifest(pointB.workspace, pointB.id)).id, pointB.id)
})

test('missing all store identity copies fails closed when Git-native checkpoints already exist', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-missing-store-id', turn: 1, turnStartSeq: 1,
  })
  await rm(join(f.storageDir, 'store-id'))
  await rm(join(f.storageDir, 'store-id.repair'))

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  await assert.rejects(
    restarted.initialize(),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
})

test('store identity repair is stable for empty roots and fails closed without a valid v2 copy', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-store-id-test-'))
  t.after(() => rm(outer, { recursive: true, force: true }))
  const emptyState = join(outer, 'empty-state')
  await mkdir(emptyState)
  await writeFile(join(emptyState, 'store-id'), '')
  const empty = new ChangeLedgerEngine({ storageDir: emptyState })
  await empty.initialize()
  assert.match(await readFile(join(emptyState, 'store-id'), 'utf8'), /^[0-9a-f]{32}\n$/)

  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-malformed-store-id', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.storageDir, 'store-id'), '')
  const repaired = new ChangeLedgerEngine({ storageDir: f.storageDir })
  await repaired.initialize()
  assert.match(await readFile(join(f.storageDir, 'store-id'), 'utf8'), /^[0-9a-f]{32}\n$/)
  await writeFile(join(f.storageDir, 'store-id'), '')
  await writeFile(join(f.storageDir, 'store-id.repair'), '')
  const corrupted = new ChangeLedgerEngine({ storageDir: f.storageDir })
  await assert.rejects(
    corrupted.initialize(),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
})

test('concurrent malformed store-id repair elects one durable identity', async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), 'dsh-store-id-race-'))
  t.after(() => rm(storageDir, { recursive: true, force: true }))
  await writeFile(join(storageDir, 'store-id'), '')
  const values = await Promise.all(Array.from({ length: 24 }, () => ensureStoreId(storageDir)))
  assert.equal(new Set(values).size, 1)
  assert.equal((await readFile(join(storageDir, 'store-id'), 'utf8')).trim(), values[0])
  assert.equal((await readFile(join(storageDir, 'store-id.repair'), 'utf8')).trim(), values[0])
})

test('startup completes a journaled Git-native deletion', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-delete-crash', turn: 1, turnStartSeq: 1,
  })
  const manifest = await f.engine.store.readManifest(point.workspace, point.id)
  assert.equal(manifest.version, 2)
  await f.engine.store.writeGitCheckpointJournal('delete', manifest)
  await f.engine.store.deleteManifest(manifest.workspace, manifest.id)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 1)
  await assert.rejects(git(f.workspace, 'rev-parse', '--verify', manifest.git.ref))
  assert.deepEqual(await restarted.store.listGitCheckpointJournals(), [])
})

test('different storage roots contend on one Git worktree lock', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const other = new ChangeLedgerEngine({ storageDir: join(f.outer, 'other-state'), staleLockMs: 1 })
  await other.initialize()
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const release = await f.engine.store.acquire(await realpath(f.workspace), identity.lockPath)
  try {
    await assert.rejects(
      other.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-lock', turn: 1, turnStartSeq: 1 }),
      (error) => error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED',
    )
  } finally {
    await release()
  }
})

test('concurrent stale-lock reclaim never grants overlapping local leases', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const workspace = await realpath(f.workspace)
  const config = resolveConfig({ storageDir: f.storageDir, staleLockMs: 1 })
  const seedStore = new LedgerStore(config)
  const releaseSeed = await seedStore.acquire(workspace)
  const lockPath = join(
    f.storageDir,
    'workspaces',
    createHash('sha256').update(workspace).digest('hex'),
    'lock.json',
  )
  const stale = JSON.parse(await readFile(lockPath, 'utf8'))
  await releaseSeed()
  await writeFile(lockPath, `${JSON.stringify({ ...stale, pid: 2_147_483_647, createdAt: 0 })}\n`)

  const attempts = await Promise.allSettled(Array.from({ length: 30 }, async () => {
    const store = new LedgerStore(config)
    const release = await store.acquire(workspace)
    const acquiredAt = Date.now()
    await new Promise(resolve => setTimeout(resolve, 80))
    const releasedAt = Date.now()
    await release()
    return { acquiredAt, releasedAt }
  }))
  const intervals = attempts
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
    .sort((left, right) => left.acquiredAt - right.acquiredAt)
  assert.ok(intervals.length >= 1)
  for (let index = 1; index < intervals.length; index += 1) {
    assert.ok(intervals[index].acquiredAt >= intervals[index - 1].releasedAt)
  }
})

test('a paused stale reclaimer cannot quarantine a newly published lock', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const workspace = await realpath(f.workspace)
  const config = resolveConfig({ storageDir: f.storageDir, staleLockMs: 1 })
  const seedStore = new LedgerStore(config)
  const releaseSeed = await seedStore.acquire(workspace)
  const lockPath = join(
    f.storageDir,
    'workspaces',
    createHash('sha256').update(workspace).digest('hex'),
    'lock.json',
  )
  const stale = JSON.parse(await readFile(lockPath, 'utf8'))
  await releaseSeed()
  await writeFile(lockPath, `${JSON.stringify({ ...stale, pid: 2_147_483_647, createdAt: 0 })}\n`)

  const paused = new LedgerStore(config)
  const acquireOwnership = paused.acquireLockReclaimOwnership.bind(paused)
  let reachedResolve
  const reached = new Promise(resolve => { reachedResolve = resolve })
  let resumeResolve
  const resume = new Promise(resolve => { resumeResolve = resolve })
  let pauseOnce = true
  paused.acquireLockReclaimOwnership = async (...args) => {
    if (pauseOnce) {
      pauseOnce = false
      reachedResolve()
      await resume
    }
    return acquireOwnership(...args)
  }
  const pausedAttempt = paused.acquire(workspace)
  await reached

  const winner = new LedgerStore(config)
  const releaseWinner = await winner.acquire(workspace)
  const winningLock = JSON.parse(await readFile(lockPath, 'utf8'))
  resumeResolve()
  await assert.rejects(
    pausedAttempt,
    (error) => error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED',
  )
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).nonce, winningLock.nonce)
  await releaseWinner()
})

test('a crashed stale-reclaim owner is replaced by one durable successor', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const workspace = await realpath(f.workspace)
  const config = resolveConfig({ storageDir: f.storageDir, staleLockMs: 1 })
  const seedStore = new LedgerStore(config)
  const releaseSeed = await seedStore.acquire(workspace)
  const lockDir = join(f.storageDir, 'workspaces', createHash('sha256').update(workspace).digest('hex'))
  const lockPath = join(lockDir, 'lock.json')
  const stale = JSON.parse(await readFile(lockPath, 'utf8'))
  await releaseSeed()
  await writeFile(lockPath, `${JSON.stringify({ ...stale, pid: 2_147_483_647, createdAt: 0 })}\n`)

  const crashed = new LedgerStore(config)
  assert.equal(await crashed.prepareLockReclaim(lockPath, false), true)
  const journalPath = join(lockDir, (await readdir(lockDir)).find(name => /^lock\.json\.reclaim-[0-9a-f]{64}\.json$/.test(name)))
  const candidate = { ...stale, pid: process.pid, createdAt: Date.now(), nonce: 'crashed-reclaim-owner' }
  assert.equal(await crashed.acquireLockReclaimOwnership(journalPath, candidate), true)
  const ownerPath = join(lockDir, (await readdir(lockDir)).find(name => name.includes('.json.owner-')))
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
  await writeFile(ownerPath, `${JSON.stringify({ ...owner, pid: 2_147_483_647, createdAt: 0 })}\n`)
  await rm(lockPath)

  const successor = new LedgerStore(config)
  const releaseSuccessor = await successor.acquire(workspace)
  assert.equal((await readdir(lockDir)).some(name => name.includes('.reclaim-') || name.includes('.owner-')), false)
  await releaseSuccessor()
})

test('a foreign-host shared lock is never reclaimed from local pid state', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const foreignLock = {
    pid: 2_147_483_647,
    hostId: '0'.repeat(64),
    createdAt: 0,
    nonce: 'foreign-host-lock',
  }
  await mkdir(dirname(identity.lockPath), { recursive: true })
  await writeFile(identity.lockPath, `${JSON.stringify(foreignLock)}\n`)

  const other = new ChangeLedgerEngine({ storageDir: join(f.outer, 'foreign-lock-state'), staleLockMs: 1 })
  await other.initialize()
  await assert.rejects(
    other.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-foreign-lock', turn: 1, turnStartSeq: 1 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED',
  )
  assert.deepEqual(JSON.parse(await readFile(identity.lockPath, 'utf8')), foreignLock)
})

test('host identity validation fails before creating a shared lock', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const storageDir = join(f.outer, 'invalid-host-id-state')
  const script = `
    import { ChangeLedgerEngine } from './lib/index.js'
    const [workspace, storageDir] = process.argv.slice(1)
    const engine = new ChangeLedgerEngine({ storageDir, turnCheckpointMode: 'git-native' })
    await engine.initialize()
    try {
      await engine.createTurnCheckpoint({ cwd: workspace, sessionId: 'invalid-host', turn: 1, turnStartSeq: 1 })
      process.exitCode = 2
    } catch (error) {
      if (error?.code !== 'HOST_ID_UNAVAILABLE') throw error
    }
  `
  const options = { cwd: process.cwd(), env: { ...process.env, DSH_TURN_REWIND_HOST_ID: 'invalid' } }
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script, f.workspace, storageDir], options)
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  await assert.rejects(readFile(identity.lockPath), (error) => error?.code === 'ENOENT')
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script, f.workspace, storageDir], options)
  await assert.rejects(readFile(identity.lockPath), (error) => error?.code === 'ENOENT')
})

test('Git workspace binding refuses to migrate a state directory owned by an active legacy process', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const workspace = await realpath(f.workspace)
  const storageDir = join(f.outer, 'legacy-lock-state')
  const engine = new ChangeLedgerEngine({ storageDir, staleLockMs: 1, turnCheckpointMode: 'git-native' })
  await engine.initialize()
  const legacyDir = join(storageDir, 'workspaces', createHash('sha256').update(workspace).digest('hex'))
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, 'lock.json'), `${JSON.stringify({
    pid: process.pid,
    createdAt: 0,
    nonce: 'legacy-active-lock',
  })}\n`)

  await assert.rejects(
    engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-legacy-lock', turn: 1, turnStartSeq: 1 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED',
  )
  assert.equal((await lstat(legacyDir)).isDirectory(), true)
})

test('legacy locks without host identity fail closed even when their pid appears stale locally', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const workspace = await realpath(f.workspace)
  const storageDir = join(f.outer, 'legacy-foreign-lock-state')
  const engine = new ChangeLedgerEngine({ storageDir, staleLockMs: 1, turnCheckpointMode: 'git-native' })
  await engine.initialize()
  const legacyDir = join(storageDir, 'workspaces', createHash('sha256').update(workspace).digest('hex'))
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, 'lock.json'), `${JSON.stringify({
    pid: 2_147_483_647,
    createdAt: 0,
    nonce: 'legacy-unknown-host-lock',
  })}\n`)

  await assert.rejects(
    engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-legacy-foreign', turn: 1, turnStartSeq: 1 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED',
  )
})

test('linked worktrees have distinct durable identities that survive a move', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linked = join(f.outer, 'linked')
  const moved = join(f.outer, 'linked-moved')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-branch', linked)
  const mainIdentity = await ensureGitWorktreeIdentity(f.workspace)
  const linkedIdentity = await ensureGitWorktreeIdentity(linked)
  assert.notEqual(mainIdentity.worktreeId, linkedIdentity.worktreeId)
  assert.notEqual(mainIdentity.lockPath, linkedIdentity.lockPath)
  const point = await f.engine.createTurnCheckpoint({
    cwd: linked, sessionId: 'session-linked-move', turn: 1, turnStartSeq: 1,
  })
  await git(f.workspace, 'worktree', 'move', linked, moved)
  const movedIdentity = await ensureGitWorktreeIdentity(moved)
  assert.equal(movedIdentity.worktreeId, linkedIdentity.worktreeId)
  assert.equal(movedIdentity.lockPath, linkedIdentity.lockPath)
  assert.equal((await f.engine.findTurnCheckpoint({ cwd: moved, sessionId: 'session-linked-move', turn: 1 }))?.id, point.id)
  await writeFile(join(moved, 'state.txt'), 'changed after move\n')
  const plan = await f.engine.planRestore({ cwd: moved, restorePointId: point.id })
  await f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation })
  assert.equal(await readFile(join(moved, 'state.txt'), 'utf8'), 'one\n')
})

test('a recreated linked worktree cannot inherit an identity left by the removed incarnation', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linked = join(f.outer, 'linked-recreated')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-recreated-old', linked)
  const oldIdentity = await ensureGitWorktreeIdentity(linked)
  await git(f.workspace, 'worktree', 'remove', linked)
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-recreated-new', linked)

  await assert.rejects(
    ensureGitWorktreeIdentity(linked),
    (error) => error instanceof ChangeLedgerError
      && error.code === 'STATE_CORRUPT'
      && error.message.includes('detached central copy'),
  )
  const centralPath = join(
    oldIdentity.commonDir,
    'dsh-turn-rewind-worktree-identities',
    `${createHash('sha256').update(oldIdentity.gitDir).digest('hex')}.id`,
  )
  assert.equal((await readFile(centralPath, 'utf8')).trim(), oldIdentity.worktreeId)
})

test('a deleted primary worktree identity is recovered and its durable claim survives total identity loss', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-worktree-id-recovery', turn: 1, turnStartSeq: 1,
  })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const identityDir = join(identity.gitDir, 'dsh-turn-rewind')
  await writeFile(join(identityDir, 'worktree-id'), '')

  const recovered = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  await recovered.initialize()
  assert.equal((await recovered.list({ cwd: f.workspace, includeTurnCheckpoints: true }))[0]?.id, point.id)
  assert.equal((await readFile(join(identityDir, 'worktree-id'), 'utf8')).trim(), identity.worktreeId)
  await rm(identityDir, { recursive: true })
  const centralPath = join(
    identity.commonDir,
    'dsh-turn-rewind-worktree-identities',
    `${createHash('sha256').update(identity.gitDir).digest('hex')}.id`,
  )
  await rm(centralPath)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  await rm(join(f.storageDir, 'workspaces', workspaceKey, 'workspace-binding.json'))
  const failed = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  await failed.initialize()
  await assert.rejects(
    failed.list({ cwd: f.workspace, includeTurnCheckpoints: true }),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
  assert.deepEqual(await readdir(join(f.storageDir, 'worktree-claims')), [`${identity.worktreeId}.json`])
  assert.equal((await readdir(join(f.storageDir, 'workspaces'))).filter(name => name.startsWith('git-')).length, 1)
})

test('a moved linked worktree with total identity loss fails closed instead of opening an empty namespace', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linked = join(f.outer, 'linked-identity-loss')
  const moved = join(f.outer, 'linked-identity-loss-moved')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-identity-loss-branch', linked)
  await f.engine.createTurnCheckpoint({
    cwd: linked, sessionId: 'session-linked-identity-loss', turn: 1, turnStartSeq: 1,
  })
  const identity = await ensureGitWorktreeIdentity(linked)
  await git(f.workspace, 'worktree', 'move', linked, moved)
  await mkdir(linked)
  await rm(join(identity.gitDir, 'dsh-turn-rewind'), { recursive: true })
  await rm(join(
    identity.commonDir,
    'dsh-turn-rewind-worktree-identities',
    `${createHash('sha256').update(identity.gitDir).digest('hex')}.id`,
  ))

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  await restarted.initialize()
  await assert.rejects(
    restarted.list({ cwd: moved, includeTurnCheckpoints: true }),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
})

test('moving an entire repository fails closed instead of hiding its existing checkpoint namespace', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-repository-move', turn: 1, turnStartSeq: 1,
  })
  const workspaceDirsBefore = await readdir(join(f.storageDir, 'workspaces'))
  const moved = join(f.outer, 'workspace-moved')
  await rename(f.workspace, moved)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  await restarted.initialize()
  await assert.rejects(
    restarted.list({ cwd: moved, includeTurnCheckpoints: true }),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
  assert.deepEqual(await readdir(join(f.storageDir, 'workspaces')), workspaceDirsBefore)
})

test('a hostless local lock prevents linked-worktree rebind from mutating durable state', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linked = join(f.outer, 'linked-hostless-rebind')
  const moved = join(f.outer, 'linked-hostless-rebind-moved')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-hostless-rebind-branch', linked)
  const previousWorkspace = await realpath(linked)
  const point = await f.engine.createTurnCheckpoint({
    cwd: linked, sessionId: 'session-hostless-rebind', turn: 1, turnStartSeq: 1,
  })
  const identity = await ensureGitWorktreeIdentity(linked)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  const workspaceDir = join(f.storageDir, 'workspaces', workspaceKey)
  const bindingPath = join(workspaceDir, 'workspace-binding.json')
  const manifestPath = join(workspaceDir, 'manifests', `${point.id}.json`)
  await git(f.workspace, 'worktree', 'move', linked, moved)
  await writeFile(join(workspaceDir, 'lock.json'), `${JSON.stringify({
    pid: 2_147_483_647,
    createdAt: 0,
    nonce: 'hostless-rebind-lock',
  })}\n`)
  const bindingBefore = await readFile(bindingPath, 'utf8')
  const manifestBefore = await readFile(manifestPath, 'utf8')
  const bindingStatBefore = await lstat(bindingPath)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 0)
  await assert.rejects(
    restarted.list({ cwd: moved, includeTurnCheckpoints: true }),
    (error) => error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED',
  )
  const bindingStatAfter = await lstat(bindingPath)
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore)
  assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore)
  assert.equal(bindingStatAfter.ino, bindingStatBefore.ino)
  assert.equal(bindingStatAfter.mtimeMs, bindingStatBefore.mtimeMs)
  assert.equal(JSON.parse(bindingBefore).workspace, previousWorkspace)
})

test('an atomic worktree claim prevents copied repositories from creating duplicate namespaces concurrently', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const copied = join(f.outer, 'workspace-copy')
  await cp(f.workspace, copied, { recursive: true })
  assert.equal((await ensureGitWorktreeIdentity(copied)).worktreeId, identity.worktreeId)
  const other = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1, turnCheckpointMode: 'git-native' })
  await other.initialize()

  const results = await Promise.allSettled([
    f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-claim-original', turn: 1, turnStartSeq: 1 }),
    other.createTurnCheckpoint({ cwd: copied, sessionId: 'session-claim-copy', turn: 1, turnStartSeq: 1 }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected?.reason instanceof ChangeLedgerError && rejected.reason.code === 'STATE_CORRUPT', true)
  assert.deepEqual(await readdir(join(f.storageDir, 'worktree-claims')), [`${identity.worktreeId}.json`])
  assert.equal((await readdir(join(f.storageDir, 'workspaces'))).filter(name => name.startsWith('git-')).length, 1)
})

test('startup completes a crash-interrupted workspace rebind before validating mixed durable paths', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linked = join(f.outer, 'linked-rebind-crash')
  const moved = join(f.outer, 'linked-rebind-crash-moved')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-rebind-crash-branch', linked)
  const previousWorkspace = await realpath(linked)
  const identity = await ensureGitWorktreeIdentity(linked)
  const first = await f.engine.createTurnCheckpoint({
    cwd: linked, sessionId: 'session-rebind-crash', turn: 1, turnStartSeq: 1,
  })
  const second = await f.engine.createTurnCheckpoint({
    cwd: linked, sessionId: 'session-rebind-crash', turn: 2, turnStartSeq: 2,
  })
  const firstManifest = await f.engine.store.readManifest(previousWorkspace, first.id)
  assert.equal(firstManifest.version, 2)
  await f.engine.store.writeGitCheckpointJournal('publish', firstManifest)
  const operationId = `op_${Date.now().toString(36)}_abcdef123456`
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: operationId,
    workspace: previousWorkspace,
    restorePointId: first.id,
    rescuePointId: second.id,
    paths: ['state.txt'],
    startedAt: Date.now(),
    finishedAt: Date.now(),
    state: 'completed',
  })

  await git(f.workspace, 'worktree', 'move', linked, moved)
  const currentWorkspace = await realpath(moved)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  const workspaceDir = join(f.storageDir, 'workspaces', workspaceKey)
  const firstManifestPath = join(workspaceDir, 'manifests', `${first.id}.json`)
  const operationPath = join(workspaceDir, 'operations', `${operationId}.json`)
  const partiallyReboundManifest = JSON.parse(await readFile(firstManifestPath, 'utf8'))
  partiallyReboundManifest.workspace = currentWorkspace
  partiallyReboundManifest.repository.root = currentWorkspace
  await writeFile(firstManifestPath, `${JSON.stringify(partiallyReboundManifest, null, 2)}\n`)
  const partiallyReboundOperation = JSON.parse(await readFile(operationPath, 'utf8'))
  partiallyReboundOperation.workspace = currentWorkspace
  await writeFile(operationPath, `${JSON.stringify(partiallyReboundOperation, null, 2)}\n`)
  await writeFile(join(workspaceDir, 'workspace-rebind.json'), `${JSON.stringify({
    version: 1,
    previousWorkspace,
    currentWorkspace,
    commonDir: identity.commonDir,
    worktreeId: identity.worktreeId,
  }, null, 2)}\n`)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1, turnCheckpointMode: 'git-native' })
  assert.equal(await restarted.initialize(), 1)
  const binding = JSON.parse(await readFile(join(workspaceDir, 'workspace-binding.json'), 'utf8'))
  assert.equal(binding.workspace, currentWorkspace)
  await assert.rejects(readFile(join(workspaceDir, 'workspace-rebind.json')), (error) => error?.code === 'ENOENT')
  for (const filename of await readdir(join(workspaceDir, 'manifests'))) {
    const manifest = JSON.parse(await readFile(join(workspaceDir, 'manifests', filename), 'utf8'))
    assert.equal(manifest.workspace, currentWorkspace)
    assert.equal(manifest.repository.root, currentWorkspace)
  }
  const operation = JSON.parse(await readFile(operationPath, 'utf8'))
  assert.equal(operation.workspace, currentWorkspace)
  assert.deepEqual(await restarted.store.listGitCheckpointJournals(), [])
  assert.equal((await restarted.list({ cwd: moved, includeTurnCheckpoints: true })).length, 2)
  assert.equal((await restarted.inspect({ cwd: moved, restorePointId: first.id })).restorePoint.id, first.id)
  await writeFile(join(moved, 'state.txt'), 'changed after move\n')
  const plan = await restarted.planRestore({ cwd: moved, restorePointId: first.id })
  await restarted.applyRestore({ planId: plan.id, confirmation: plan.confirmation })
  assert.equal(await readFile(join(moved, 'state.txt'), 'utf8'), 'one\n')
})

test('startup completes legacy directory migration after rename but before binding publication', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  const rescue = await f.engine.create({ cwd: f.workspace })
  const operationId = `op_${Date.now().toString(36)}_fedcba654321`
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: operationId,
    workspace: point.workspace,
    restorePointId: point.id,
    rescuePointId: rescue.id,
    paths: ['state.txt'],
    startedAt: Date.now(),
    state: 'interrupted',
  })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  const workspacesDir = join(f.storageDir, 'workspaces')
  const workspaceDir = join(workspacesDir, workspaceKey)
  await rm(join(workspaceDir, 'workspace-binding.json'))
  await writeFile(join(workspacesDir, `.workspace-migration-${workspaceKey}.json`), `${JSON.stringify({
    version: 1,
    workspace: point.workspace,
    legacyKey: createHash('sha256').update(point.workspace).digest('hex'),
    targetKey: workspaceKey,
    commonDir: identity.commonDir,
    gitDir: identity.gitDir,
    worktreeId: identity.worktreeId,
  }, null, 2)}\n`)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 1)
  assert.equal((await restarted.store.listOperations(point.workspace))[0]?.id, operationId)
  assert.equal(JSON.parse(await readFile(join(workspaceDir, 'workspace-binding.json'), 'utf8')).workspace, point.workspace)
})

test('startup leaves a legacy migration journal untouched when its hostless lock ownership is uncertain', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  const rescue = await f.engine.create({ cwd: f.workspace })
  const operationId = `op_${Date.now().toString(36)}_a1b2c3d4e5f6`
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: operationId,
    workspace: point.workspace,
    restorePointId: point.id,
    rescuePointId: rescue.id,
    paths: ['state.txt'],
    startedAt: Date.now(),
    state: 'running',
  })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  const legacyKey = createHash('sha256').update(point.workspace).digest('hex')
  const workspacesDir = join(f.storageDir, 'workspaces')
  const workspaceDir = join(workspacesDir, workspaceKey)
  const legacyDir = join(workspacesDir, legacyKey)
  await rm(join(workspaceDir, 'workspace-binding.json'))
  await rm(join(workspaceDir, 'lock.json'), { force: true })
  await import('node:fs/promises').then(({ rename }) => rename(workspaceDir, legacyDir))
  await writeFile(join(legacyDir, 'lock.json'), `${JSON.stringify({
    pid: 2_147_483_647,
    createdAt: 0,
    nonce: 'uncertain-legacy-migration-lock',
  })}\n`)
  const journalPath = join(workspacesDir, `.workspace-migration-${workspaceKey}.json`)
  await writeFile(journalPath, `${JSON.stringify({
    version: 1,
    workspace: point.workspace,
    legacyKey,
    targetKey: workspaceKey,
    commonDir: identity.commonDir,
    gitDir: identity.gitDir,
    worktreeId: identity.worktreeId,
  }, null, 2)}\n`)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 0)
  assert.equal((await lstat(legacyDir)).isDirectory(), true)
  await assert.rejects(lstat(workspaceDir), (error) => error?.code === 'ENOENT')
  assert.equal((await lstat(journalPath)).isFile(), true)
  assert.equal(JSON.parse(await readFile(join(legacyDir, 'operations', `${operationId}.json`), 'utf8')).state, 'running')

  await rm(join(f.storageDir, 'worktree-claims', `${identity.worktreeId}.json`), { force: true })
  const moved = join(f.outer, 'workspace-moved-with-pending-migration')
  await rename(f.workspace, moved)
  const workspaceDirsBefore = (await readdir(workspacesDir)).sort()
  const movedEngine = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await movedEngine.initialize(), 0)
  await assert.rejects(
    movedEngine.list({ cwd: moved, includeTurnCheckpoints: true }),
    (error) => error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT',
  )
  assert.deepEqual((await readdir(workspacesDir)).sort(), workspaceDirsBefore)
})

test('listRecovery rebinds interrupted operations after a linked worktree move', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linked = join(f.outer, 'linked-recovery')
  const moved = join(f.outer, 'linked-recovery-moved')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-recovery-branch', linked)
  const point = await f.engine.create({ cwd: linked })
  const rescue = await f.engine.create({ cwd: linked })
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: `op_${Date.now().toString(36)}_123456abcdef`,
    workspace: point.workspace,
    restorePointId: point.id,
    rescuePointId: rescue.id,
    paths: ['state.txt'],
    startedAt: Date.now(),
    state: 'interrupted',
  })
  await git(f.workspace, 'worktree', 'move', linked, moved)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  await restarted.initialize()
  const recoveries = await restarted.listRecovery({ cwd: moved })
  assert.equal(recoveries.length, 1)
  assert.equal(recoveries[0]?.restorePointId, point.id)
})

test('startup reconciles a publication journal after a linked worktree move', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const linked = join(f.outer, 'linked-crash')
  const moved = join(f.outer, 'linked-crash-moved')
  await git(f.workspace, 'worktree', 'add', '-b', 'linked-crash-branch', linked)
  const identity = await ensureGitWorktreeIdentity(linked)
  const release = await f.engine.store.acquire(await realpath(linked), identity.lockPath, identity)
  await release()
  const prepared = (await captureGitTurnCheckpoint({
    cwd: linked,
    id: `rp_${Date.now().toString(36)}_333333333333`,
    sessionId: 'session-linked-crash',
    turn: 1,
    turnStartSeq: 1,
    config: f.engine.config,
  })).manifest
  await f.engine.store.writeGitCheckpointJournal('publish', prepared)
  await publishGitCheckpoint(prepared, f.storageDir)
  await git(f.workspace, 'worktree', 'move', linked, moved)

  const restarted = new ChangeLedgerEngine({ storageDir: f.storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 1)
  await assert.rejects(git(moved, 'rev-parse', '--verify', prepared.git.ref))
  assert.deepEqual(await restarted.store.listGitCheckpointJournals(), [])
})

test('Git-native checkpoints preserve unborn HEAD, staged deletion, and binary worktree bytes', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await writeFile(join(f.workspace, 'staged.bin'), Buffer.from([0, 1, 2, 255]))
  await git(f.workspace, 'add', 'staged.bin')
  await rm(join(f.workspace, 'staged.bin'))
  await writeFile(join(f.workspace, 'worktree.bin'), Buffer.from([9, 0, 8, 255]))
  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-unborn', turn: 1, turnStartSeq: 1,
  })
  const manifest = await f.engine.store.readManifest(point.workspace, point.id)
  assert.equal(manifest.version, 2)
  assert.equal(await git(f.workspace, 'ls-tree', manifest.git.headTree), '')
  assert.match(await git(f.workspace, 'ls-tree', manifest.git.indexTree, '--', 'staged.bin'), /staged\.bin$/)
  assert.equal(await git(f.workspace, 'ls-tree', manifest.git.worktreeTree, '--', 'staged.bin'), '')
  assert.deepEqual(await readFile(join(f.workspace, 'worktree.bin')), Buffer.from([9, 0, 8, 255]))

  await writeFile(join(f.workspace, 'worktree.bin'), Buffer.from([1, 2, 3]))
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id })
  await f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation })
  assert.deepEqual(await readFile(join(f.workspace, 'worktree.bin')), Buffer.from([9, 0, 8, 255]))
})

test('malformed path-state cache records are discarded instead of trusted', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'base.txt': 'base\n' })
  await writeFile(join(f.workspace, 'dirty.txt'), 'dirty bytes\n')
  await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-cache-corrupt', turn: 1, turnStartSeq: 1 })
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  const cachePath = join(f.storageDir, 'workspaces', workspaceKey, 'git-cache.json')
  const cache = JSON.parse(await readFile(cachePath, 'utf8'))
  await writeFile(join(f.workspace, 'wrong-cache.bin'), Buffer.alloc(Buffer.byteLength('dirty bytes\n'), 0x78))
  cache.paths['dirty.txt'].oid = await git(f.workspace, 'hash-object', '-w', 'wrong-cache.bin')
  await rm(join(f.workspace, 'wrong-cache.bin'))
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`)
  const constrained = new ChangeLedgerEngine({
    storageDir: f.storageDir,
    staleLockMs: 1,
    turnCheckpointMode: 'git-native',
    turnCheckpointMaxNewBytes: 1,
  })
  await constrained.initialize()
  await assert.rejects(
    constrained.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-cache-corrupt', turn: 2, turnStartSeq: 5 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'TURN_CHECKPOINT_NEW_CONTENT_LIMIT',
  )
})

test('caller cancellation is not mislabeled as an automatic checkpoint timeout', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(
    f.engine.createTurnCheckpoint({
      cwd: f.workspace, sessionId: 'session-abort', turn: 1, turnStartSeq: 1, signal: controller.signal,
    }),
    (error) => !(error instanceof ChangeLedgerError && error.code === 'TURN_CHECKPOINT_TIMEOUT'),
  )
})

test('inherited Git directory and object-store overrides cannot redirect checkpoint plumbing', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const redirectedObjects = join(f.outer, 'redirected-objects')
  await mkdir(redirectedObjects)
  const previousGitDir = process.env.GIT_DIR
  const previousObjectDirectory = process.env.GIT_OBJECT_DIRECTORY
  process.env.GIT_DIR = join(f.outer, 'not-a-repository')
  process.env.GIT_OBJECT_DIRECTORY = redirectedObjects
  try {
    const point = await f.engine.createTurnCheckpoint({
      cwd: f.workspace, sessionId: 'session-sanitized-env', turn: 1, turnStartSeq: 1,
    })
    assert.equal(point.format, 2)
    assert.deepEqual(await readdir(redirectedObjects), [])
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previousGitDir
    if (previousObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY
    else process.env.GIT_OBJECT_DIRECTORY = previousObjectDirectory
  }
})

test('legacy automatic checkpoints obey the real pre-step deadline', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const bounded = new ChangeLedgerEngine({
    storageDir: join(f.outer, 'bounded-state'),
    staleLockMs: 1,
    turnCheckpointMode: 'legacy',
    turnCheckpointTimeoutMs: 1,
  })
  await bounded.initialize()
  await assert.rejects(
    bounded.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-real-timeout', turn: 1, turnStartSeq: 1 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'TURN_CHECKPOINT_TIMEOUT',
  )
})

test('automatic checkpoint deadline errors are normalized across manifest discovery', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  const bounded = new ChangeLedgerEngine({
    storageDir: join(f.outer, 'bounded-manifest-state'),
    staleLockMs: 1,
    turnCheckpointMode: 'legacy',
    turnCheckpointTimeoutMs: 100,
  })
  await bounded.initialize()
  bounded.store.listManifests = async () => new Promise(() => {})
  const startedAt = Date.now()
  await assert.rejects(
    bounded.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-manifest-timeout', turn: 1, turnStartSeq: 1 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'TURN_CHECKPOINT_TIMEOUT',
  )
  assert.ok(Date.now() - startedAt < 300)
})

test('startup garbage-collects blobs left by a failed bounded legacy capture', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'orphan candidate\n' })
  const storageDir = join(f.outer, 'bounded-cleanup-state')
  const bounded = new ChangeLedgerEngine({ storageDir, staleLockMs: 1, turnCheckpointMode: 'legacy' })
  await bounded.initialize()
  bounded.store.writeManifest = async () => { throw new Error('injected bounded manifest failure') }
  await assert.rejects(
    bounded.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-bounded-cleanup', turn: 1, turnStartSeq: 1 }),
    /injected bounded manifest failure/,
  )
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
  const workspaceDir = join(storageDir, 'workspaces', workspaceKey)
  assert.equal((await lstat(join(workspaceDir, 'snapshot-cleanup.json'))).isFile(), true)

  const restarted = new ChangeLedgerEngine({ storageDir, staleLockMs: 1 })
  assert.equal(await restarted.initialize(), 1)
  await assert.rejects(readFile(join(workspaceDir, 'snapshot-cleanup.json')), (error) => error?.code === 'ENOENT')
  const blobPrefixes = await readdir(join(workspaceDir, 'blobs'))
  assert.deepEqual(blobPrefixes, [])
})

test('a later bounded legacy capture reconciles an earlier failed capture before replacing its cleanup marker', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'first content\n' })
  const storageDir = join(f.outer, 'same-process-cleanup-state')
  const bounded = new ChangeLedgerEngine({ storageDir, staleLockMs: 1, turnCheckpointMode: 'legacy' })
  await bounded.initialize()
  const writeManifest = bounded.store.writeManifest.bind(bounded.store)
  let failOnce = true
  bounded.store.writeManifest = async (manifest) => {
    if (failOnce) {
      failOnce = false
      throw new Error('injected first bounded failure')
    }
    return writeManifest(manifest)
  }
  await assert.rejects(
    bounded.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-same-process-cleanup', turn: 1, turnStartSeq: 1 }),
    /injected first bounded failure/,
  )
  await writeFile(join(f.workspace, 'state.txt'), 'second content\n')
  await bounded.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-same-process-cleanup', turn: 2, turnStartSeq: 2,
  })
  const gc = await bounded.store.collectGarbage(await realpath(f.workspace))
  assert.equal(gc.deletedBlobs, 0)
})

test('durable skip markers survive restart and are cleared by a ready checkpoint', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'state.txt': 'one\n' })
  await f.engine.recordTurnCheckpointSkip({
    cwd: f.workspace,
    sessionId: 'session-durable-skip',
    turn: 1,
    turnStartSeq: 1,
    reason: '[TURN_CHECKPOINT_TIMEOUT] automatic checkpoint exceeded 5000 ms',
  })
  const restarted = new ChangeLedgerEngine({
    storageDir: f.storageDir,
    staleLockMs: 1,
    turnCheckpointMode: 'git-native',
  })
  await restarted.initialize()
  assert.match((await restarted.findTurnCheckpointSkip({
    cwd: f.workspace, sessionId: 'session-durable-skip', turn: 1, turnStartSeq: 1,
  }))?.reason ?? '', /TURN_CHECKPOINT_TIMEOUT/)
  await restarted.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-durable-skip', turn: 1, turnStartSeq: 1,
  })
  assert.equal(await restarted.findTurnCheckpointSkip({
    cwd: f.workspace, sessionId: 'session-durable-skip', turn: 1, turnStartSeq: 1,
  }), undefined)
  await restarted.recordTurnCheckpointSkip({
    cwd: f.workspace,
    sessionId: 'session-durable-skip',
    turn: 1,
    turnStartSeq: 1,
    reason: '[TURN_CHECKPOINT_TIMEOUT] stale delayed outcome',
  })
  assert.equal(await restarted.findTurnCheckpointSkip({
    cwd: f.workspace, sessionId: 'session-durable-skip', turn: 1, turnStartSeq: 1,
  }), undefined)
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
  const first = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 1, turnStartSeq: 1 })
  await writeFile(join(f.workspace, 'state.txt'), 'two\n')
  const second = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 2, turnStartSeq: 5 })
  const other = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's2', turn: 1, turnStartSeq: 1 })
  await writeFile(join(f.workspace, 'state.txt'), 'three\n')
  const third = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 3, turnStartSeq: 9 })

  const points = await f.engine.list({ cwd: f.workspace, includeTurnCheckpoints: true })
  assert.deepEqual(new Set(points.map(point => point.id)), new Set([second.id, third.id, other.id]))
  assert.equal(await f.engine.findTurnCheckpoint({ cwd: f.workspace, sessionId: 's1', turn: 1 }), undefined)
  await assert.rejects(
    f.engine.inspect({ cwd: f.workspace, restorePointId: first.id }),
    error => error instanceof ChangeLedgerError && error.code === 'RESTORE_POINT_NOT_FOUND',
  )
})

test('a nested linked worktree is excluded from the snapshot instead of failing path validation', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'src/main.txt': 'alpha\n' })
  await git(f.workspace, 'worktree', 'add', 'nested', '-b', 'topic/agent')
  await writeFile(join(f.workspace, 'nested', 'inner.txt'), 'inner checkout\n')

  const point = await f.engine.create({ cwd: f.workspace, sessionId: 'session-a' })
  assert.equal(point.fileCount, 1)
  const manifest = await f.engine.store.readManifest(await realpath(f.workspace), point.id)
  assert.deepEqual(Object.keys(manifest.entries), ['src/main.txt'])
  const inspection = await f.engine.inspect({ cwd: f.workspace, restorePointId: point.id })
  assert.equal(inspection.changes.length, 0)
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

test('one restore plan cannot be applied concurrently', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'before\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'a.txt'), 'after\n')
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id })

  const acquire = f.engine.store.acquire.bind(f.engine.store)
  let enteredResolve
  const entered = new Promise(resolve => { enteredResolve = resolve })
  let continueResolve
  const continueRestore = new Promise(resolve => { continueResolve = resolve })
  f.engine.store.acquire = async (workspace) => {
    const release = await acquire(workspace)
    enteredResolve()
    await continueRestore
    return release
  }

  const first = f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation })
  await entered
  try {
    await assert.rejects(
      f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation }),
      (error) => error instanceof ChangeLedgerError && error.code === 'PLAN_IN_PROGRESS',
    )
  } finally {
    continueResolve()
  }
  await first
  const points = await f.engine.list({ cwd: f.workspace, includeRescue: true })
  assert.equal(points.filter(candidate => candidate.kind === 'rescue').length, 1)
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

test('apply rechecks selected bytes immediately before the first mutation', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'a.txt': 'a0\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'a.txt'), 'a1\n')
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id })
  const writeOperation = f.engine.store.writeOperation.bind(f.engine.store)
  let injected = false
  f.engine.store.writeOperation = async (operation) => {
    await writeOperation(operation)
    if (!injected && operation.state === 'running') {
      injected = true
      await writeFile(join(f.workspace, 'a.txt'), 'a2\n')
    }
  }
  await assert.rejects(
    f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation }),
    (error) => error instanceof ChangeLedgerError && error.code === 'RESTORE_FAILED_ROLLED_BACK',
  )
  assert.equal(await readFile(join(f.workspace, 'a.txt'), 'utf8'), 'a1\n')
})

test('restore refuses a parent symlink swapped in while reading checkpoint content', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await seedCommitted(f.workspace, { 'dir/file.txt': 'checkpoint\n' })
  const point = await f.engine.create({ cwd: f.workspace })
  await writeFile(join(f.workspace, 'dir/file.txt'), 'changed\n')
  const outside = join(f.outer, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'file.txt'), 'outside-safe\n')
  const plan = await f.engine.planRestore({ cwd: f.workspace, restorePointId: point.id })
  const readBlob = f.engine.store.readBlob.bind(f.engine.store)
  let swapped = false
  f.engine.store.readBlob = async (workspace, hash) => {
    const content = await readBlob(workspace, hash)
    if (!swapped) {
      swapped = true
      await rm(join(f.workspace, 'dir/file.txt'))
      await rm(join(f.workspace, 'dir'))
      await symlink(outside, join(f.workspace, 'dir'))
    }
    return content
  }
  await assert.rejects(
    f.engine.applyRestore({ planId: plan.id, confirmation: plan.confirmation }),
    (error) => error instanceof ChangeLedgerError
      && (error.code === 'RESTORE_FAILED_ROLLED_BACK' || error.code === 'RESTORE_FAILED_RECOVERY_REQUIRED'),
  )
  assert.equal(await readFile(join(outside, 'file.txt'), 'utf8'), 'outside-safe\n')
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
  const operationId = `op_${Date.now().toString(36)}_123456abcdef`
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: operationId,
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
    assert.equal((await f.engine.store.listOperations(original.workspace)).find(operation => operation.id === operationId)?.state, 'running')
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
  const identity = await ensureGitWorktreeIdentity(f.workspace)
  const workspaceKey = `git-${createHash('sha256').update(`${identity.commonDir}\0${identity.worktreeId}`).digest('hex')}`
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
    const config = resolveConfig({})
    assert.equal(config.storageDir, join(root, 'change-ledger', 'v1'))
    assert.equal(config.turnCheckpointMode, 'legacy')
    assert.equal(config.turnCheckpointTimeoutMs, 5_000)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('updateConfig swaps runtime-tunable values in place and freezes the storage root', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  assert.equal(f.engine.config.turnCheckpointTimeoutMs, 5_000)
  f.engine.updateConfig({ storageDir: f.storageDir, turnCheckpointTimeoutMs: 250, turnCheckpointMode: 'off' })
  assert.equal(f.engine.config.turnCheckpointTimeoutMs, 250)
  assert.equal(f.engine.config.turnCheckpointMode, 'off')
  assert.equal(f.engine.store.config.turnCheckpointTimeoutMs, 250)
  assert.throws(
    () => f.engine.updateConfig({ storageDir: f.storageDir, turnCheckpointTimeoutMs: 0 }),
    (error) => error instanceof ChangeLedgerError && error.code === 'INVALID_CONFIG',
  )
  assert.throws(
    () => f.engine.updateConfig({ storageDir: join(f.outer, 'elsewhere') }),
    (error) => error instanceof ChangeLedgerError && error.code === 'INVALID_CONFIG',
  )
  assert.equal(f.engine.config.storageDir, f.storageDir)
  assert.equal(f.engine.config.turnCheckpointTimeoutMs, 250)
})

test('listWorkspaces groups checkpoints and recovery counts across workspaces', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-manage-'))
  t.after(async () => rm(outer, { recursive: true, force: true }))
  const first = join(outer, 'first')
  const second = join(outer, 'second')
  for (const workspace of [first, second]) {
    await mkdir(workspace)
    await git(workspace, 'init', '-b', 'main')
    await git(workspace, 'config', 'user.name', 'Change Ledger Test')
    await git(workspace, 'config', 'user.email', 'change-ledger@example.invalid')
    await writeFile(join(workspace, 'file.txt'), `${workspace}\n`)
    await git(workspace, 'add', '--all')
    await git(workspace, 'commit', '-m', 'seed')
  }
  const engine = new ChangeLedgerEngine({ storageDir: join(outer, 'state') })
  await engine.initialize()
  const firstPoint = await engine.create({ cwd: first, label: 'one' })
  const secondPoint = await engine.create({ cwd: second, label: 'two' })
  const secondRescue = await engine.create({ cwd: second })
  await engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: `op_${Date.now().toString(36)}_0000aaaa1111`,
    workspace: secondPoint.workspace,
    restorePointId: secondPoint.id,
    rescuePointId: secondRescue.id,
    paths: ['file.txt'],
    startedAt: Date.now(),
    state: 'interrupted',
  })

  const workspaces = await engine.listWorkspaces()
  assert.equal(workspaces.length, 2)
  assert.equal(workspaces[0].workspace, firstPoint.workspace)
  assert.equal(workspaces[1].workspace, secondPoint.workspace)
  assert.deepEqual(workspaces[0].restorePoints.map((point) => point.id), [firstPoint.id])
  assert.deepEqual(workspaces[1].restorePoints.map((point) => point.id), [secondRescue.id, secondPoint.id])
  assert.equal(workspaces[0].recoveryCount, 0)
  assert.equal(workspaces[1].recoveryCount, 1)
  assert.ok(workspaces[0].totalBytes > 0)
  assert.equal(workspaces[1].totalBytes, secondPoint.totalBytes + secondRescue.totalBytes)
})

test('purgeWorkspace deletes unprotected points, keeps recovery references, and collects blobs', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const workspace = await realpath(f.workspace)
  const protectedRestore = await f.engine.create({ cwd: workspace, label: 'protected' })
  const protectedRescue = await f.engine.create({ cwd: workspace, label: 'rescued' })
  await writeFile(join(workspace, 'doomed-only.txt'), 'unique content for the doomed point\n')
  const doomed = await f.engine.create({ cwd: workspace, label: 'doomed' })
  await f.engine.store.writeOperation({
    version: LEDGER_FORMAT_VERSION,
    id: `op_${Date.now().toString(36)}_0000bbbb2222`,
    workspace,
    restorePointId: protectedRestore.id,
    rescuePointId: protectedRescue.id,
    paths: ['code.txt'],
    startedAt: Date.now(),
    state: 'interrupted',
  })

  const report = await f.engine.purgeWorkspace({ workspace })
  assert.equal(report.deletedRestorePoints, 1)
  assert.equal(report.retainedRestorePoints, 2)
  assert.ok(report.deletedBlobs > 0)
  const remaining = await f.engine.list({ cwd: workspace })
  assert.deepEqual(remaining.map((point) => point.id).sort(), [protectedRestore.id, protectedRescue.id].sort())

  const targeted = await f.engine.purgeWorkspace({ workspace, restorePointIds: [protectedRescue.id] })
  assert.equal(targeted.deletedRestorePoints, 0)
  assert.equal(targeted.retainedRestorePoints, 1)
})

test('purgeWorkspace refuses to delete while another operation owns the durable workspace lock', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const workspace = await realpath(f.workspace)
  const point = await f.engine.create({ cwd: workspace, label: 'must remain' })
  const release = await f.engine.store.acquire(workspace)
  try {
    await assert.rejects(
      () => f.engine.purgeWorkspace({ workspace }),
      (error) => error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED',
    )
  } finally {
    await release()
  }
  assert.deepEqual((await f.engine.list({ cwd: workspace })).map((entry) => entry.id), [point.id])
})

test('purgeWorkspace cleans storage for a workspace whose directory no longer exists', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-orphans-'))
  t.after(async () => rm(outer, { recursive: true, force: true }))
  const workspace = join(outer, 'gone')
  await mkdir(workspace)
  await git(workspace, 'init', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Change Ledger Test')
  await git(workspace, 'config', 'user.email', 'change-ledger@example.invalid')
  await writeFile(join(workspace, 'file.txt'), 'content\n')
  await git(workspace, 'add', '--all')
  await git(workspace, 'commit', '-m', 'seed')
  const engine = new ChangeLedgerEngine({ storageDir: join(outer, 'state') })
  await engine.initialize()
  const point = await engine.create({ cwd: workspace, label: 'orphaned' })
  await rm(workspace, { recursive: true, force: true })

  const beforeRestart = await engine.listWorkspaces()
  assert.equal(beforeRestart.length, 1)
  const report = await engine.purgeWorkspace({ workspace: point.workspace })
  assert.equal(report.deletedRestorePoints, 1)
  assert.ok(report.deletedBlobs > 0)
  assert.equal((await engine.listWorkspaces()).length, 0)
})
