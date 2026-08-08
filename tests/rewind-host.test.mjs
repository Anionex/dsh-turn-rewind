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
    apiProxy: { sessions: { fork: async () => { throw new Error('unexpected fork') } } },
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

test('conversation rewind validates the checkpoint boundary and delegates to the host fork lifecycle', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 1, turnEndSeq: 4 })
  const events = sessionEvents()
  let forkRequest
  const ctx = {
    sessions: {
      get: () => ({ id: 'session-web', header: { cwd: f.workspace }, events }),
    },
    sessionQuery: { readSession: async () => { throw new Error('unexpected cold read') } },
    apiProxy: {
      sessions: {
        async fork(request) {
          forkRequest = request
          return { result: { ok: true, value: { sessionId: 'session-child' } } }
        },
      },
    },
  }
  const handler = createRewindHttpHandler(ctx, f.engine, new TurnCheckpointCoordinator(f.engine))
  const result = await request(handler, 'POST', '/change-ledger/rewind', {
    mode: 'conversation', sessionId: 'session-web', turn: 1, checkpointId: checkpoint.id,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.mode, 'conversation')
  assert.equal(result.body.sessionId, 'session-child')
  assert.equal(typeof forkRequest.rpcId, 'string')
  assert.deepEqual(forkRequest.payload, { sessionId: 'session-web', atSeq: 4 })
})

test('combined rewind restores code before creating the conversation child', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 1, turnEndSeq: 4 })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  const ctx = {
    sessions: {
      get: () => ({ id: 'session-web', header: { cwd: f.workspace }, events: sessionEvents() }),
    },
    sessionQuery: { readSession: async () => { throw new Error('unexpected cold read') } },
    apiProxy: {
      sessions: {
        fork: async () => ({ result: { ok: true, value: { sessionId: 'session-child' } } }),
      },
    },
  }
  const handler = createRewindHttpHandler(ctx, f.engine, new TurnCheckpointCoordinator(f.engine))
  const preview = await request(handler, 'GET', '/change-ledger/rewind?sessionId=session-web&turn=1')
  const result = await request(handler, 'POST', '/change-ledger/rewind', {
    mode: 'both', sessionId: 'session-web', turn: 1, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.mode, 'both')
  assert.equal(result.body.sessionId, 'session-child')
  assert.match(result.body.rescuePointId, /^rp_/)
  assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'checkpoint\n')
})

test('combined rewind without code drift creates only the conversation child', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 1, turnEndSeq: 4 })
  const ctx = {
    sessions: {
      get: () => ({ id: 'session-web', header: { cwd: f.workspace }, events: sessionEvents() }),
    },
    sessionQuery: { readSession: async () => { throw new Error('unexpected cold read') } },
    apiProxy: {
      sessions: {
        fork: async () => ({ result: { ok: true, value: { sessionId: 'session-child' } } }),
      },
    },
  }
  const handler = createRewindHttpHandler(ctx, f.engine, new TurnCheckpointCoordinator(f.engine))
  const result = await request(handler, 'POST', '/change-ledger/rewind', {
    mode: 'both', sessionId: 'session-web', turn: 1, checkpointId: checkpoint.id,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.mode, 'both')
  assert.equal(result.body.sessionId, 'session-child')
  assert.equal(result.body.rescuePointId, undefined)
  assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'checkpoint\n')
})

test('combined rewind compensates code when conversation creation fails', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({ cwd: f.workspace, sessionId: 'session-web', turn: 1, turnEndSeq: 4 })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  const events = sessionEvents()
  const ctx = {
    sessions: {
      get: () => ({ id: 'session-web', header: { cwd: f.workspace }, events }),
    },
    sessionQuery: { readSession: async () => { throw new Error('unexpected cold read') } },
    apiProxy: {
      sessions: {
        fork: async () => ({ result: { ok: false, error: { message: 'fork fixture failure' } } }),
      },
    },
  }
  const handler = createRewindHttpHandler(ctx, f.engine, new TurnCheckpointCoordinator(f.engine))
  const preview = await request(handler, 'GET', '/change-ledger/rewind?sessionId=session-web&turn=1')
  const result = await request(handler, 'POST', '/change-ledger/rewind', {
    mode: 'both', sessionId: 'session-web', turn: 1, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'RESTORE_FAILED_ROLLED_BACK')
  assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'changed\n')
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

function sessionEvents() {
  return [
    { type: 'request/header', seq: 0, data: { header: { config: { provider: 'deepseek', model: 'chat', maxTokens: 4096 } } } },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: {} },
    { type: 'assistant/message', seq: 3, data: {} },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
  ]
}
