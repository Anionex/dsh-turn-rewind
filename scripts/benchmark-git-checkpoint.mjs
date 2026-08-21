import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { ChangeLedgerEngine } from '../lib/index.js'

const execFileAsync = promisify(execFile)
const options = parseArgs(process.argv.slice(2))
const outer = await mkdtemp(join(tmpdir(), 'dsh-turn-rewind-bench-'))
const workspace = join(outer, 'workspace')
const storageDir = join(outer, 'state')
const result = {
  fixture: options,
  status: 'running',
  captures: [],
}

try {
  await mkdir(workspace)
  await git(workspace, 'init', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Turn Rewind Benchmark')
  await git(workspace, 'config', 'user.email', 'turn-rewind-benchmark@example.invalid')
  const content = Buffer.alloc(options.bytesPerFile, 0x61)
  await parallelRange(options.files, 64, async (index) => {
    const directory = join(workspace, 'fixture', String(Math.floor(index / 250)).padStart(4, '0'))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${String(index).padStart(6, '0')}.bin`), content)
  })
  await git(workspace, 'add', '--all')
  await git(workspace, 'commit', '-m', 'benchmark fixture')

  const engine = new ChangeLedgerEngine({
    storageDir,
    turnCheckpointMode: 'git-native',
    maxFiles: options.files + 100,
    maxSnapshotBytes: options.files * options.bytesPerFile + 1024 * 1024,
    turnCheckpointTimeoutMs: options.timeoutMs,
    turnCheckpointMaxNewBytes: Math.max(options.dirtyFiles * options.bytesPerFile * 2, 1024 * 1024),
  })
  await engine.initialize()
  result.captures.push(await measure(engine, workspace, 'clean', 1))
  await parallelRange(options.dirtyFiles, 32, async (index) => {
    const path = join(workspace, 'fixture', String(Math.floor(index / 250)).padStart(4, '0'), `${String(index).padStart(6, '0')}.bin`)
    await writeFile(path, Buffer.alloc(options.bytesPerFile, 0x62))
  })
  result.captures.push(await measure(engine, workspace, 'dirty-cold-cache', 2))
  result.captures.push(await measure(engine, workspace, 'dirty-warm-cache', 3))
  const warmPoint = await engine.findTurnCheckpoint({ cwd: workspace, sessionId: 'benchmark-session', turn: 3 })
  assert.notEqual(warmPoint, undefined)
  const comparisonStarted = performance.now()
  const inspection = await engine.inspect({ cwd: workspace, restorePointId: warmPoint.id })
  assert.deepEqual(inspection.changes, [])
  result.comparison = {
    label: 'warm-checkpoint-vs-unchanged-worktree',
    wallMs: Math.round((performance.now() - comparisonStarted) * 100) / 100,
    changeCount: inspection.changes.length,
  }

  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.exitCode = 1
} finally {
  try {
    await rm(outer, { recursive: true, force: true })
    result.cleanup = 'passed'
  } catch (error) {
    result.cleanup = 'failed'
    result.cleanupError = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

async function measure(engine, workspace, label, turn) {
  const statusBefore = await git(workspace, 'status', '--porcelain=v2', '--untracked-files=all')
  const headsBefore = await git(workspace, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
  const indexBefore = await readFile(join(workspace, '.git', 'index'))
  const started = performance.now()
  const point = await engine.createTurnCheckpoint({
    cwd: workspace,
    sessionId: 'benchmark-session',
    turn,
    turnStartSeq: turn * 4 - 3,
  })
  const manifest = await engine.store.readManifest(point.workspace, point.id)
  assert.equal(manifest.version, 2)
  assert.equal(await git(workspace, 'status', '--porcelain=v2', '--untracked-files=all'), statusBefore)
  assert.equal(await git(workspace, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), headsBefore)
  assert.deepEqual(await readFile(join(workspace, '.git', 'index')), indexBefore)
  return {
    label,
    wallMs: Math.round((performance.now() - started) * 100) / 100,
    fileCount: manifest.fileCount,
    logicalBytes: manifest.totalBytes,
    worktreeBytesRead: manifest.git.newlyStoredBytes,
  }
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout.trim()
}

async function parallelRange(count, concurrency, task) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const current = next
      next += 1
      await task(current)
    }
  }))
}

function parseArgs(args) {
  if (args[0] === '--') args = args.slice(1)
  const values = { files: 15_500, bytesPerFile: 24 * 1024, dirtyFiles: 10, timeoutMs: 5_000 }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const raw = args[index + 1]
    const key = {
      '--files': 'files',
      '--bytes-per-file': 'bytesPerFile',
      '--dirty-files': 'dirtyFiles',
      '--timeout-ms': 'timeoutMs',
    }[flag]
    if (key === undefined || raw === undefined || !/^\d+$/.test(raw)) usage()
    values[key] = Number(raw)
  }
  if (!Number.isSafeInteger(values.files) || values.files <= 0
    || !Number.isSafeInteger(values.bytesPerFile) || values.bytesPerFile <= 0
    || !Number.isSafeInteger(values.dirtyFiles) || values.dirtyFiles < 0 || values.dirtyFiles > values.files
    || !Number.isSafeInteger(values.timeoutMs) || values.timeoutMs <= 0) usage()
  return values
}

function usage() {
  process.stderr.write('usage: pnpm benchmark:git-checkpoint -- [--files N] [--bytes-per-file N] [--dirty-files N] [--timeout-ms N]\n')
  process.exit(2)
}
