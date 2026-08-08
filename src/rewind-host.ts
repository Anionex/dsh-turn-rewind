import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { ChangeLedgerError, errorMessage } from './errors.js'
import type { ChangeLedgerEngine } from './engine.js'

interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
  readonly events: readonly SessionEventLike[]
}

interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: SessionLike
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

interface AgentsLike {
  list(): AgentLike[]
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
}

interface SessionQueryLike {
  readSession(id: string): Promise<{ readonly header: { readonly cwd?: string }; readonly events: readonly SessionEventLike[] }>
}

interface HttpRequestLike {
  method?: string
  url?: string
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'error', listener: (error: unknown) => void): this
}

interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): void
}

interface HttpServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>
  }): () => void
}

interface ApiProxyLike {
  readonly sessions: {
    fork(request: {
      readonly rpcId: string
      readonly payload: { readonly sessionId: string; readonly atSeq: number }
    }): Promise<{
      readonly result:
        | { readonly ok: true; readonly value: { readonly sessionId: string } }
        | { readonly ok: false; readonly error: { readonly message: string } }
    }>
  }
}

declare module 'cordis' {
  interface Context {
    agents: AgentsLike
    sessions: SessionsLike
    sessionQuery: SessionQueryLike
    httpServer: HttpServerLike
    apiProxy: ApiProxyLike
  }

  interface Events {
    'agent/created'(payload: { readonly agent: AgentLike }): void
    'agent/status'(payload: { readonly agent: AgentLike; readonly status: 'idle' | 'running' }): void
  }
}

export const REWIND_HTTP_PATH = '/change-ledger/rewind'
const BODY_LIMIT = 64 * 1024
const CHANGE_PREVIEW_LIMIT = 200

/** In-memory capture status used to distinguish a pending checkpoint from a permanent miss. */
export class TurnCheckpointCoordinator {
  private readonly scheduled = new Map<string, number>()
  private readonly pending = new Set<string>()
  private readonly failures = new Map<string, string>()

  constructor(private readonly engine: ChangeLedgerEngine) {}

  /** Install idle-boundary capture listeners while the Agent service is present. */
  install(ctx: Context): void {
    const schedule = (agent: AgentLike): void => { this.schedule(ctx, agent) }
    ctx.on('agent/created', ({ agent }) => { schedule(agent) })
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') schedule(agent) })
    queueMicrotask(() => { for (const agent of ctx.agents.list()) schedule(agent) })
  }

  /** Current capture state for a session turn when no durable checkpoint exists yet. */
  state(sessionId: string, turn: number): { readonly status: 'pending' | 'failed' | 'missing'; readonly error?: string } {
    const key = checkpointKey(sessionId, turn)
    if (this.pending.has(key)) return { status: 'pending' }
    const error = this.failures.get(key)
    return error === undefined ? { status: 'missing' } : { status: 'failed', error }
  }

  private schedule(ctx: Context, agent: AgentLike): void {
    if (agent.status !== 'idle') return
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    const turn = end?.data.turn
    if (end === undefined || !Number.isSafeInteger(turn) || (turn as number) < 0) return
    if ((this.scheduled.get(agent.id) ?? -1) >= end.seq) return
    this.scheduled.set(agent.id, end.seq)
    const key = checkpointKey(agent.id, turn as number)
    this.pending.add(key)
    this.failures.delete(key)
    try {
      void agent.runMaintenance(async (signal) => {
        await this.engine.createTurnCheckpoint({
          cwd,
          sessionId: agent.id,
          turn: turn as number,
          turnEndSeq: end.seq,
          signal,
        })
      }).catch((error: unknown) => {
        this.failures.set(key, errorMessage(error))
        ctx.logger.warn(`[change-ledger] turn checkpoint failed for ${agent.id} turn ${String(turn)}: ${errorMessage(error)}`)
      }).finally(() => { this.pending.delete(key) })
    } catch (error) {
      this.pending.delete(key)
      this.scheduled.delete(agent.id)
      this.failures.set(key, errorMessage(error))
    }
  }
}

/** Register the same-origin preview/apply endpoint consumed by the browser half. */
export function installRewindHttp(
  ctx: Context,
  engine: ChangeLedgerEngine,
  coordinator: TurnCheckpointCoordinator,
): void {
  ctx.effect(() => ctx.httpServer.register({
    kind: 'exact',
    path: REWIND_HTTP_PATH,
    handler: createRewindHttpHandler(ctx, engine, coordinator),
  }), 'change-ledger.rewindHttp')
}

/** Build the exact-route handler as a testable unit. */
export function createRewindHttpHandler(
  ctx: Pick<Context, 'sessions' | 'sessionQuery' | 'apiProxy'>,
  engine: ChangeLedgerEngine,
  coordinator: TurnCheckpointCoordinator,
): (request: HttpRequestLike, response: HttpResponseLike) => Promise<void> {
  return async (request, response) => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url ?? REWIND_HTTP_PATH, 'http://dsh.local')
        const sessionId = requiredText(url.searchParams.get('sessionId'), 'sessionId')
        const turn = nonNegativeInteger(url.searchParams.get('turn'), 'turn')
        const cwd = await sessionCwd(ctx, sessionId)
        const checkpoint = await engine.findTurnCheckpoint({ cwd, sessionId, turn })
        if (checkpoint === undefined) {
          json(response, 200, coordinator.state(sessionId, turn))
          return
        }
        const inspection = await engine.inspect({ cwd, restorePointId: checkpoint.id })
        if (inspection.changes.length === 0) {
          json(response, 200, {
            status: 'ready', sessionId, turn, checkpointId: checkpoint.id,
            turnEndSeq: checkpoint.turnEndSeq, totalChanges: 0, changes: [], truncated: false,
            headChanged: inspection.headChanged, operationChanged: inspection.operationChanged,
          })
          return
        }
        const plan = await engine.planRestore({ cwd, restorePointId: checkpoint.id, sessionId })
        json(response, 200, {
          status: 'ready', sessionId, turn, checkpointId: checkpoint.id,
          turnEndSeq: checkpoint.turnEndSeq,
          totalChanges: inspection.changes.length,
          changes: inspection.changes.slice(0, CHANGE_PREVIEW_LIMIT).map(change => ({ path: change.path, kind: change.kind })),
          truncated: inspection.changes.length > CHANGE_PREVIEW_LIMIT,
          headChanged: inspection.headChanged,
          operationChanged: inspection.operationChanged,
          planId: plan.id,
          confirmation: plan.confirmation,
        })
        return
      }
      if (request.method === 'POST') {
        const body = objectBody(await readBody(request))
        const mode = body.mode
        if (mode !== 'code' && mode !== 'conversation' && mode !== 'both') {
          throw new ChangeLedgerError('INVALID_ARGUMENTS', 'mode must be "code", "conversation", or "both"')
        }
        const sessionId = requiredText(body.sessionId, 'sessionId')
        const planId = optionalText(body.planId, 'planId')
        const confirmation = optionalText(body.confirmation, 'confirmation')
        if (mode === 'code') {
          if (planId === undefined || confirmation === undefined) {
            throw new ChangeLedgerError('NO_CHANGES', 'the selected turn has no code changes to restore')
          }
          const result = await engine.applyRestore({ planId, confirmation, sessionId })
          json(response, 200, { status: 'completed', mode, ...result })
          return
        }

        const turn = nonNegativeInteger(body.turn, 'turn')
        const checkpointId = requiredText(body.checkpointId, 'checkpointId')
        const checkpoint = await checkpointForRequest(ctx, engine, sessionId, turn, checkpointId)
        if (mode === 'conversation') {
          const fork = await createConversationFork(ctx, sessionId, turn, checkpoint.turnEndSeq)
          json(response, 200, { status: 'completed', mode, sessionId: fork.sessionId })
          return
        }

        let restoreResult: Awaited<ReturnType<ChangeLedgerEngine['applyRestore']>> | undefined
        if (planId !== undefined || confirmation !== undefined) {
          if (planId === undefined || confirmation === undefined) {
            throw new ChangeLedgerError('INVALID_ARGUMENTS', 'planId and confirmation must be supplied together')
          }
          restoreResult = await engine.applyRestore({ planId, confirmation, sessionId })
        }

        try {
          const fork = await createConversationFork(ctx, sessionId, turn, checkpoint.turnEndSeq)
          json(response, 200, { status: 'completed', mode, sessionId: fork.sessionId, ...restoreResult })
        } catch (forkError) {
          if (restoreResult === undefined) throw forkError
          try {
            const cwd = await sessionCwd(ctx, sessionId)
            const rollbackPlan = await engine.planRestore({
              cwd,
              restorePointId: restoreResult.rescuePointId,
              sessionId,
            })
            await engine.applyRestore({
              planId: rollbackPlan.id,
              confirmation: rollbackPlan.confirmation,
              sessionId,
            })
          } catch (rollbackError) {
            throw new AggregateError([forkError, rollbackError], 'conversation fork failed and code compensation also failed')
          }
          throw new ChangeLedgerError(
            'RESTORE_FAILED_ROLLED_BACK',
            `conversation fork failed; code was recovered from ${restoreResult.rescuePointId}: ${errorMessage(forkError)}`,
            { cause: forkError },
          )
        }
        return
      }
      json(response, 405, { error: 'method not allowed' })
    } catch (error) {
      const status = error instanceof ChangeLedgerError && error.code === 'RESTORE_POINT_NOT_FOUND' ? 404 : 409
      json(response, status, { error: errorMessage(error), code: error instanceof ChangeLedgerError ? error.code : 'REWIND_FAILED' })
    }
  }
}

async function sessionCwd(ctx: Pick<Context, 'sessions' | 'sessionQuery'>, sessionId: string): Promise<string> {
  const live = ctx.sessions.get(sessionId)
  const cwd = live?.header.cwd ?? (await ctx.sessionQuery.readSession(sessionId)).header.cwd
  if (cwd === undefined) throw new ChangeLedgerError('WORKSPACE_REQUIRED', `session ${sessionId} has no workspace`)
  return cwd
}

async function checkpointForRequest(
  ctx: Pick<Context, 'sessions' | 'sessionQuery'>,
  engine: ChangeLedgerEngine,
  sessionId: string,
  turn: number,
  requestedId: string,
): Promise<{ readonly id: string; readonly turnEndSeq: number }> {
  const cwd = await sessionCwd(ctx, sessionId)
  const checkpoint = await engine.findTurnCheckpoint({ cwd, sessionId, turn })
  if (checkpoint === undefined || checkpoint.turnEndSeq === undefined) {
    throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `turn ${String(turn)} has no rewind checkpoint`)
  }
  if (requestedId !== checkpoint.id) {
    throw new ChangeLedgerError('PLAN_STALE', 'the selected turn checkpoint changed; reopen the rewind dialog')
  }
  return { id: checkpoint.id, turnEndSeq: checkpoint.turnEndSeq }
}

async function createConversationFork(
  ctx: Pick<Context, 'sessions' | 'sessionQuery' | 'apiProxy'>,
  sourceId: string,
  turn: number,
  turnEndSeq: number,
): Promise<{ readonly sessionId: string }> {
  const live = ctx.sessions.get(sourceId)
  const source = live ?? { id: sourceId, ...await ctx.sessionQuery.readSession(sourceId) }
  const boundary = source.events.find(event => (
    event.type === 'turn/end' && event.seq === turnEndSeq && event.data.turn === turn
  ))
  if (boundary === undefined) throw new ChangeLedgerError('PLAN_STALE', 'the session no longer contains the checkpoint turn boundary')
  const response = await ctx.apiProxy.sessions.fork({
    rpcId: randomUUID(),
    payload: { sessionId: sourceId, atSeq: turnEndSeq },
  })
  if (!response.result.ok) {
    throw new ChangeLedgerError('CONVERSATION_REWIND_FAILED', response.result.error.message)
  }
  return { sessionId: requiredText(response.result.value.sessionId, 'fork sessionId') }
}

function checkpointKey(sessionId: string, turn: number): string {
  return `${sessionId}\0${String(turn)}`
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a non-empty string`)
  return value
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, name)
}

function nonNegativeInteger(value: unknown, name: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a non-negative safe integer`)
  }
  return parsed as number
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('INVALID_ARGUMENTS', 'request body must be an object')
  }
  return value as Record<string, unknown>
}

async function readBody(request: HttpRequestLike): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > BODY_LIMIT) {
        reject(new ChangeLedgerError('INVALID_ARGUMENTS', 'request body is too large'))
        return
      }
      chunks.push(bytes)
    })
    request.on('end', resolve)
    request.on('error', reject)
  })
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new ChangeLedgerError('INVALID_ARGUMENTS', 'request body must be valid JSON', { cause: error })
  }
}

function json(response: HttpResponseLike, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(value)}\n`)
}
