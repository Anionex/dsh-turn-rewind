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
} from '../lib/index.js'

const execFileAsync = promisify(execFile)

async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), 'dsh-turn-rewind-test-'))
  const workspace = join(outer, 'workspace')
  await mkdir(workspace)
  await git(workspace, 'init', '-b', 'main')
  await git(workspace, 'config', 'user.name', 'Turn Rewind Test')
  await git(workspace, 'config', 'user.email', 'turn-rewind@example.invalid')
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

test('first-step checkpoint finishes before the user turn continues', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const agent = preStepAgent('session-web', f.workspace, 2, 8)
  const { coordinator, listener } = installedCoordinator(f.engine)
  let visibleBeforeNext = false

  const decision = await listener(
    { agent, turn: 2, step: 1, signal: new AbortController().signal },
    async () => {
      visibleBeforeNext = (await f.engine.findTurnCheckpoint({
        cwd: f.workspace, sessionId: agent.id, turn: 2,
      })) !== undefined
      return { kind: 'enter' }
    },
  )

  assert.deepEqual(decision, { kind: 'enter' })
  assert.equal(visibleBeforeNext, true)
  assert.equal((await f.engine.findTurnCheckpoint({
    cwd: f.workspace, sessionId: agent.id, turn: 2,
  }))?.turnStartSeq, 8)
  assert.equal(coordinator.state(agent.id, 2).status, 'missing')
})

test('checkpoint capture serializes one worktree and failure never blocks the turn', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const nested = join(f.workspace, 'nested')
  await mkdir(nested)
  const original = f.engine.createTurnCheckpoint.bind(f.engine)
  let active = 0
  let maxActive = 0
  let failedAttempts = 0
  f.engine.createTurnCheckpoint = async (options) => {
    if (options.sessionId === 'session-failed') {
      failedAttempts += 1
      throw new Error('capture failed')
    }
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      return await original(options)
    } finally {
      active -= 1
    }
  }
  const warnings = []
  const { coordinator, listener } = installedCoordinator(f.engine, warnings)
  const first = preStepAgent('session-one', f.workspace, 1, 1)
  const second = preStepAgent('session-two', nested, 2, 8)
  const failed = preStepAgent('session-failed', f.workspace, 3, 12)
  let continued = 0
  await Promise.all([
    listener({ agent: first, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' })),
    listener({ agent: second, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' })),
    listener({ agent: failed, turn: 3, step: 1, signal: new AbortController().signal }, async () => { continued += 1; return { kind: 'enter' } }),
  ])
  await listener(
    { agent: failed, turn: 3, step: 1, signal: new AbortController().signal },
    async () => { continued += 1; return { kind: 'enter' } },
  )

  assert.equal(maxActive, 1)
  assert.equal(failedAttempts, 1)
  assert.equal(continued, 2)
  assert.equal(coordinator.state('session-failed', 3).status, 'failed')
  assert.match(coordinator.state('session-failed', 3).error, /capture failed/)
  assert.equal(warnings.length, 1)
})

test('HTTP preview mints a message-bound plan and code-only restore applies it', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]))

  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  assert.equal(preview.status, 200)
  assert.equal(preview.body.status, 'ready')
  assert.equal(preview.body.messageSeq, 2)
  assert.equal(preview.body.turnStartSeq, 1)
  assert.equal(preview.body.checkpointId, checkpoint.id)
  assert.equal(preview.body.totalChanges, 1)
  assert.match(preview.body.planId, /^plan_/)

  const applied = await request(handler, 'POST', '/turn-rewind', {
    mode: 'code', sessionId: 'session-web', messageSeq: 2, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.mode, 'code')
  assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'checkpoint\n')
})

test('preview fails closed if files change between inspection and plan creation', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'previewed\n')
  const originalPlan = f.engine.planRestore.bind(f.engine)
  f.engine.planRestore = async (options) => {
    await writeFile(join(f.workspace, 'code.txt'), 'changed during preview\n')
    return originalPlan(options)
  }
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]))

  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  assert.equal(preview.status, 409)
  assert.equal(preview.body.code, 'PLAN_STALE')
})

test('only the opening direct user message of a turn can own rewind', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  const events = oneTurnEvents()
  events.splice(3, 0, { type: 'user/message', seq: 3, data: { source: { kind: 'user' } } })
  events[4] = { ...events[4], seq: 4 }
  events[5] = { ...events[5], seq: 5 }
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, events)],
  ]))

  const steering = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=3')
  assert.equal(steering.status, 404)
  assert.equal(steering.body.code, 'RESTORE_POINT_NOT_FOUND')
})

test('reviewed HEAD and branch changes remain restorable without moving Git history', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'committed later\n')
  await git(f.workspace, 'add', 'code.txt')
  await git(f.workspace, 'commit', '-m', 'later')
  await git(f.workspace, 'switch', '-c', 'topic')
  const headBefore = (await execFileAsync('git', ['-C', f.workspace, 'rev-parse', 'HEAD'])).stdout.trim()
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]))

  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  assert.equal(preview.body.headChanged, true)
  assert.equal(preview.body.checkpointBranch, 'main')
  assert.equal(preview.body.currentBranch, 'topic')
  assert.match(preview.body.planId, /^plan_/)
  const applied = await request(handler, 'POST', '/turn-rewind', {
    mode: 'code', sessionId: 'session-web', messageSeq: 2, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })
  assert.equal(applied.status, 200)
  assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'checkpoint\n')
  assert.equal((await execFileAsync('git', ['-C', f.workspace, 'rev-parse', 'HEAD'])).stdout.trim(), headBefore)
  assert.equal((await execFileAsync('git', ['-C', f.workspace, 'branch', '--show-current'])).stdout.trim(), 'topic')
})

test('Git operation changes stay blocked', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  await writeFile(join(f.workspace, '.git', 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n')
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]))

  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  assert.equal(preview.body.operationChanged, true)
  assert.equal(preview.body.restoreBlocked, true)
  assert.equal(preview.body.planId, undefined)
})

test('any running Agent in the worktree, including the source Session, blocks preview and apply', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-source', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  const sessions = new Map([
    ['session-source', liveSession('session-source', f.workspace, oneTurnEvents())],
  ])
  const sourceAgent = { id: 'session-source', status: 'running', session: sessions.get('session-source') }
  const blocked = handlerFor(f, sessions, { agents: { list: () => [sourceAgent] } })
  const preview = await request(blocked, 'GET', '/turn-rewind?sessionId=session-source&messageSeq=2')
  assert.deepEqual(preview.body.activeSessionIds, ['session-source'])
  assert.equal(preview.body.planId, undefined)

  const open = handlerFor(f, sessions)
  const ready = await request(open, 'GET', '/turn-rewind?sessionId=session-source&messageSeq=2')
  const applyBlocked = await request(handlerFor(f, sessions, { agents: { list: () => [sourceAgent] } }), 'POST', '/turn-rewind', {
    mode: 'code', sessionId: 'session-source', messageSeq: 2, checkpointId: checkpoint.id,
    planId: ready.body.planId, confirmation: ready.body.confirmation,
  })
  assert.equal(applyBlocked.body.code, 'WORKSPACE_IN_USE')
})

test('combined rewind of the first message creates a blank Session after restoring files', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  let createPayload
  const sessions = new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ])
  const handler = handlerFor(f, sessions, {
    apiProxy: { sessions: {
      async create(requestValue) {
        assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'checkpoint\n')
        createPayload = requestValue.payload
        return okSession('session-new')
      },
      async fork() { throw new Error('first message must not fork a completed turn') },
    } },
  })
  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  const applied = await request(handler, 'POST', '/turn-rewind', {
    mode: 'both', sessionId: 'session-web', messageSeq: 2, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })

  assert.equal(applied.status, 200)
  assert.equal(applied.body.sessionId, 'session-new')
  assert.deepEqual(createPayload, { cwd: f.workspace })
})

test('combined rewind of a later message forks at the previous completed turn', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 2, turnStartSeq: 5,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'changed in turn two\n')
  let forkPayload
  const sessions = new Map([
    ['session-web', liveSession('session-web', f.workspace, twoTurnEvents())],
  ])
  const handler = handlerFor(f, sessions, {
    apiProxy: { sessions: {
      async create() { throw new Error('later messages must fork') },
      async fork(requestValue) { forkPayload = requestValue.payload; return okSession('session-child') },
    } },
  })
  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=6')
  const applied = await request(handler, 'POST', '/turn-rewind', {
    mode: 'both', sessionId: 'session-web', messageSeq: 6, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })

  assert.equal(applied.body.sessionId, 'session-child')
  assert.deepEqual(forkPayload, { sessionId: 'session-web', atSeq: 4 })
})

test('file changes after preview invalidate the restore plan before any conversation is created', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'previewed\n')
  let conversationCreated = false
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]), {
    apiProxy: { sessions: {
      async create() { conversationCreated = true; return okSession('unexpected') },
      async fork() { conversationCreated = true; return okSession('unexpected') },
    } },
  })
  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  await writeFile(join(f.workspace, 'code.txt'), 'changed again\n')
  const applied = await request(handler, 'POST', '/turn-rewind', {
    mode: 'both', sessionId: 'session-web', messageSeq: 2, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })

  assert.equal(applied.body.code, 'PLAN_STALE')
  assert.equal(conversationCreated, false)
})

test('combined rewind compensates restored files when conversation creation fails', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'changed\n')
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]), {
    apiProxy: { sessions: {
      async create() { return failedSession('create failed') },
      async fork() { throw new Error('unexpected fork') },
    } },
  })
  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  const applied = await request(handler, 'POST', '/turn-rewind', {
    mode: 'both', sessionId: 'session-web', messageSeq: 2, checkpointId: checkpoint.id,
    planId: preview.body.planId, confirmation: preview.body.confirmation,
  })

  assert.equal(applied.body.code, 'RESTORE_FAILED_ROLLED_BACK')
  assert.equal(await readFile(join(f.workspace, 'code.txt'), 'utf8'), 'changed\n')
})

test('a no-op checkpoint never degrades into conversation branching', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const checkpoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  let created = false
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]), {
    apiProxy: { sessions: {
      async create() { created = true; return okSession('unexpected') },
      async fork() { created = true; return okSession('unexpected') },
    } },
  })
  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  assert.equal(preview.body.totalChanges, 0)
  assert.equal(preview.body.planId, undefined)
  const applied = await request(handler, 'POST', '/turn-rewind', {
    mode: 'both', sessionId: 'session-web', messageSeq: 2, checkpointId: checkpoint.id,
  })
  assert.equal(applied.body.code, 'NO_CHANGES')
  assert.equal(created, false)
})

test('preview is paged while details can retrieve the complete file list', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'session-web', turn: 1, turnStartSeq: 1,
  })
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(f.workspace, `later-${String(index).padStart(2, '0')}.txt`), 'later\n')
  }
  const handler = handlerFor(f, new Map([
    ['session-web', liveSession('session-web', f.workspace, oneTurnEvents())],
  ]))
  const preview = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2')
  assert.equal(preview.body.totalChanges, 12)
  assert.equal(preview.body.changes.length, 8)
  assert.equal(preview.body.truncated, true)
  const details = await request(handler, 'GET', '/turn-rewind?sessionId=session-web&messageSeq=2&details=1&offset=8&limit=200')
  assert.equal(details.body.changes.length, 4)
  assert.equal(details.body.truncated, false)
  assert.equal(details.body.planId, undefined)
})

test('child checkpoints win, sibling checkpoints do not leak, and inherited messages respect seedLength', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const parentPoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'parent', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'sibling snapshot\n')
  const siblingPoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'sibling-a', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'child snapshot\n')
  const childPoint = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'child', turn: 1, turnStartSeq: 1,
  })
  await writeFile(join(f.workspace, 'code.txt'), 'current\n')
  const events = oneTurnEvents()
  const sessions = new Map([
    ['parent', liveSession('parent', f.workspace, events)],
    ['child', liveSession('child', f.workspace, events, { parentSession: 'parent', seedLength: 5 })],
    ['sibling-a', liveSession('sibling-a', f.workspace, events, { parentSession: 'parent', seedLength: 5 })],
    ['sibling-b', liveSession('sibling-b', f.workspace, events, { parentSession: 'parent', seedLength: 5 })],
    ['cutoff', liveSession('cutoff', f.workspace, events, { parentSession: 'parent', seedLength: 2 })],
  ])
  const handler = handlerFor(f, sessions)

  assert.equal((await request(handler, 'GET', '/turn-rewind?sessionId=child&messageSeq=2')).body.checkpointId, childPoint.id)
  assert.equal((await request(handler, 'GET', '/turn-rewind?sessionId=sibling-a&messageSeq=2')).body.checkpointId, siblingPoint.id)
  assert.equal((await request(handler, 'GET', '/turn-rewind?sessionId=sibling-b&messageSeq=2')).body.checkpointId, parentPoint.id)
  assert.equal((await request(handler, 'GET', '/turn-rewind?sessionId=cutoff&messageSeq=2')).body.status, 'missing')
})

test('persisted multi-level lineage validates every inherited message boundary and fails closed', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const point = await f.engine.createTurnCheckpoint({
    cwd: f.workspace, sessionId: 'root', turn: 1, turnStartSeq: 1,
  })
  const events = oneTurnEvents()
  const stored = new Map([
    ['leaf', { session: { cwd: f.workspace, parentSession: 'middle', seedLength: 5 }, events }],
    ['middle', { session: { cwd: f.workspace, parentSession: 'root', seedLength: 5 }, events }],
    ['root', { session: { cwd: f.workspace }, events }],
  ])
  const handler = createRewindHttpHandler({
    sessions: { get: () => undefined },
    sessionQuery: { readSession: async id => stored.get(id) ?? Promise.reject(new Error(`missing ${id}`)) },
    apiProxy: defaultApiProxy(),
  }, f.engine, new TurnCheckpointCoordinator(f.engine))
  assert.equal((await request(handler, 'GET', '/turn-rewind?sessionId=leaf&messageSeq=2')).body.checkpointId, point.id)

  stored.set('middle', {
    session: { cwd: f.workspace, parentSession: 'root', seedLength: 5 },
    events: events.map(event => event.type === 'turn/start' ? { ...event, seq: 9 } : event),
  })
  const stale = await request(handler, 'GET', '/turn-rewind?sessionId=leaf&messageSeq=2')
  assert.equal(stale.body.code, 'PLAN_STALE')
})

async function request(handler, method, url, body) {
  const requestValue = new EventEmitter()
  requestValue.method = method
  requestValue.url = url
  let status = 0
  let text = ''
  const response = {
    writeHead(value) { status = value },
    end(value = '') { text += value },
  }
  const pending = handler(requestValue, response)
  queueMicrotask(() => {
    if (body !== undefined) requestValue.emit('data', JSON.stringify(body))
    requestValue.emit('end')
  })
  await pending
  return { status, body: JSON.parse(text) }
}

function handlerFor(fixtureValue, sessions, overrides = {}) {
  const ctx = {
    sessions: { get: id => sessions.get(id) },
    sessionQuery: { readSession: async id => {
      const session = sessions.get(id)
      if (session === undefined) throw new Error(`missing ${id}`)
      return { session: session.header, events: session.events }
    } },
    apiProxy: defaultApiProxy(),
    ...overrides,
  }
  return createRewindHttpHandler(ctx, fixtureValue.engine, new TurnCheckpointCoordinator(fixtureValue.engine))
}

function defaultApiProxy() {
  return { sessions: {
    async create() { throw new Error('unexpected session.create') },
    async fork() { throw new Error('unexpected session.fork') },
  } }
}

function okSession(sessionId) {
  return { result: { ok: true, value: { sessionId } } }
}

function failedSession(message) {
  return { result: { ok: false, error: { message } } }
}

function liveSession(id, cwd, events, extraHeader = {}) {
  return { id, header: { cwd, ...extraHeader }, events }
}

function oneTurnEvents() {
  return [
    { type: 'request/header', seq: 0, data: {} },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, data: {} },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
  ]
}

function twoTurnEvents() {
  return [
    ...oneTurnEvents(),
    { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 6, data: { source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 7, data: {} },
    { type: 'turn/end', seq: 8, data: { turn: 2 } },
  ]
}

function preStepAgent(id, cwd, turn, startSeq) {
  return {
    id,
    status: 'running',
    session: { id, header: { cwd }, events: [{ type: 'turn/start', seq: startSeq, data: { turn } }] },
  }
}

function installedCoordinator(engine, warnings = []) {
  let listener
  const coordinator = new TurnCheckpointCoordinator(engine)
  coordinator.install({
    logger: { warn(value) { warnings.push(value) } },
    on(name, value) { if (name === 'agent/pre-step') listener = value; return () => {} },
  })
  assert.equal(typeof listener, 'function')
  return { coordinator, listener }
}
