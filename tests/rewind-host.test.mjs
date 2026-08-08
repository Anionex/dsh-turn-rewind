import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  ChangeLedgerEngine,
  TurnCheckpointCoordinator,
  createRewindHttpHandler,
} from '../dist/index.js'

const execFileAsync = promisify(execFile)

async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-change-ledger-rewind-test-'))
  const workspace = join(outer, 'workspace')
  await mkdir(workspace)
  await git(workspace, 'init', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Change Ledger Test')
  await git(workspace, 'config', 'user.email', 'change-ledger@example.invalid')
  await writeFile(join(workspace, 'code.txt'), 'checkpoint\n')
  await git(workspace, 'add', '--all')
  await git(workspace, 'commit', '-m', 'seed')
  const engine = new ChangeLedgerEngine({ storageDir: join(outer, 'state') })
  await engine.initialize()
  return { outer, workspace, engine, cleanup: () => rm(outer, { recursive: true, force: true }) }
}

async function git(cwd, ...args) {
  await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
}

test('idle turn capture runs as Agent maintenance and persists the completed boundary', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const agent = {
    id: 'session-web',
    status: 'idle',
    session: {
      id: 'session-web',
      header: { cwd: f.workspace },
      events: [{ type: 'turn/end', seq: 8, data: { turn: 2 } }],
    },
    runMaintenance(task) { return task(new AbortController().signal) },
  }
  const listeners = new Map()
  const ctx = {
    agents: { list: () => [agent] },
    logger: { warn() {} },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
  }
  const coordinator = new TurnCheckpointCoordinator(f.engine)
  coordinator.install(ctx)
  let checkpoint
  for (let attempt = 0; attempt < 50 && checkpoint === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
    checkpoint = await f.engine.findTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 2 })
  }
  assert.equal(checkpoint?.turnEndSeq, 8)
  assert.equal(coordinator.state('session-web', 2).status, 'missing')
})

test('HTTP preview mints a session-bound plan and code apply restores the checkpoint', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 1, turnEndSeq: 5 })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  const coordinator = new TurnCheckpointCoordinator(f.engine)
  const ctx = {
    sessions: { get: id => id === 'session-web' ? { header: { cwd: f.workspace } } : undefined },
    sessionQuery: { readSession: async () => { throw new Error('unexpected cold read') } },
  }
  const handler = createRewindHttpHandler(ctx, f.engine, coordinator)

  const preview = await request(handler, 'GET', '/change-ledger/rewind?sessionId=session-web&turn=1')
  assert.equal(preview.status, 200)
  assert.equal(preview.body.status, 'ready')
  assert.equal(preview.body.totalChanges, 1)
  assert.deepEqual(preview.body.changes, [{ path: 'code.txt', kind: 'modified' }])

  const applied = await request(handler, 'POST', '/change-ledger/rewind', {
    mode: 'code',
    sessionId: 'session-web',
    planId: preview.body.planId,
    confirmation: preview.body.confirmation,
  })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.status, 'completed')
  assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'checkpoint\n')
})

async function request(handler, method, url, body) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  let status = 0
  let text = ''
  const response = {
    writeHead(value) { status = value },
    end(value = '') { text += value },
  }
  const pending = handler(request, response)
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', JSON.stringify(body))
    request.emit('end')
  })
  await pending
  return { status, body: JSON.parse(text) }
}
