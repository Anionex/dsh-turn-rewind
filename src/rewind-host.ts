import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { ChangeLedgerError, errorMessage } from './errors.js'
import type { ChangeLedgerEngine } from './engine.js'
import { discoverRepositoryRoot } from './git.js'

interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

interface SessionHeaderLike {
  readonly cwd?: string
  readonly parentSession?: string
  readonly seedLength?: number
}

interface SessionLike {
  readonly id: string
  readonly header: SessionHeaderLike
  readonly events: readonly SessionEventLike[]
}

interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: SessionLike
}

interface AgentsLike {
  list(): AgentLike[]
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
}

interface SessionQueryLike {
  readSession(id: string): Promise<{ readonly session: SessionHeaderLike; readonly events: readonly SessionEventLike[] }>
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
    create(request: {
      readonly rpcId: string
      readonly payload: { readonly cwd: string }
    }): Promise<{
      readonly result:
        | { readonly ok: true; readonly value: { readonly sessionId: string } }
        | { readonly ok: false; readonly error: { readonly message: string } }
    }>
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
    'agent/pre-step'(
      payload: {
        readonly agent: AgentLike
        readonly turn: number
        readonly step: number
        readonly signal: AbortSignal
      },
      next: () => Promise<unknown>,
    ): Promise<unknown>
  }
}

export const REWIND_HTTP_PATH = '/turn-rewind'
const BODY_LIMIT = 64 * 1024
const INITIAL_CHANGE_PREVIEW_LIMIT = 8
const MAX_CHANGE_PAGE_SIZE = 200

/** Capture each turn before its opening user message can trigger model or tool work. */
export class TurnCheckpointCoordinator {
  private readonly captures = new Map<string, Promise<void>>()
  private readonly pending = new Set<string>()
  private readonly failures = new Map<string, string>()
  private readonly workspaceTails = new Map<string, Promise<void>>()

  constructor(private readonly engine: ChangeLedgerEngine) {}

  /** Install the first-step gate; checkpoint failures are recorded but never reject the user turn. */
  install(ctx: Context): void {
    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
      if (step === 1) await this.capture(ctx, agent, turn, signal)
      return next()
    }, { prepend: true })
  }

  /** Current capture state for a session turn when no durable checkpoint exists yet. */
  state(sessionId: string, turn: number): { readonly status: 'pending' | 'failed' | 'missing'; readonly error?: string } {
    const key = checkpointKey(sessionId, turn)
    if (this.pending.has(key)) return { status: 'pending' }
    const error = this.failures.get(key)
    return error === undefined ? { status: 'missing' } : { status: 'failed', error }
  }

  private async capture(
    ctx: Pick<Context, 'logger'>,
    agent: AgentLike,
    turn: number,
    signal: AbortSignal,
  ): Promise<void> {
    const key = checkpointKey(agent.id, turn)
    const existing = this.captures.get(key)
    if (existing !== undefined) {
      await existing
      return
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const start = agent.session.events.findLast(event => event.type === 'turn/start' && event.data.turn === turn)
    if (start === undefined) {
      this.recordFailure(ctx, agent.id, turn, new Error('turn/start is unavailable before the first step'))
      return
    }
    this.pending.add(key)
    this.failures.delete(key)
    const capture = (async () => {
      try {
        const workspace = await discoverRepositoryRoot(cwd, signal)
        await this.serializeWorkspace(workspace, signal, async () => {
          await this.engine.createTurnCheckpoint({
            cwd: workspace,
            sessionId: agent.id,
            turn,
            turnStartSeq: start.seq,
            signal,
          })
        })
      } catch (error) {
        this.recordFailure(ctx, agent.id, turn, error)
      } finally {
        this.pending.delete(key)
      }
    })()
    this.captures.set(key, capture)
    await capture
  }

  private async serializeWorkspace(workspace: string, signal: AbortSignal, task: () => Promise<void>): Promise<void> {
    const previous = this.workspaceTails.get(workspace) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      signal.throwIfAborted()
      await task()
    })
    this.workspaceTails.set(workspace, current)
    try {
      await current
    } finally {
      if (this.workspaceTails.get(workspace) === current) this.workspaceTails.delete(workspace)
    }
  }

  private recordFailure(
    ctx: Pick<Context, 'logger'>,
    sessionId: string,
    turn: number,
    error: unknown,
  ): void {
    const message = errorMessage(error)
    this.failures.set(checkpointKey(sessionId, turn), message)
    ctx.logger.warn(`[turn-rewind] checkpoint failed for ${sessionId} turn ${String(turn)}: ${message}`)
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
  ctx: Pick<Context, 'sessions' | 'sessionQuery' | 'apiProxy'> & { readonly agents?: AgentsLike },
  engine: ChangeLedgerEngine,
  coordinator: TurnCheckpointCoordinator,
): (request: HttpRequestLike, response: HttpResponseLike) => Promise<void> {
  return async (request, response) => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url ?? REWIND_HTTP_PATH, 'http://dsh.local')
        const sessionId = requiredText(url.searchParams.get('sessionId'), 'sessionId')
        const messageSeq = nonNegativeInteger(url.searchParams.get('messageSeq'), 'messageSeq')
        const detailsOnly = url.searchParams.get('details') === '1'
        const offset = nonNegativeInteger(url.searchParams.get('offset') ?? '0', 'offset')
        const limit = pageSize(url.searchParams.get('limit'), detailsOnly ? MAX_CHANGE_PAGE_SIZE : INITIAL_CHANGE_PREVIEW_LIMIT)
        const { target, checkpoint } = await resolveMessageCheckpoint(ctx, engine, sessionId, messageSeq)
        if (checkpoint === undefined) {
          json(response, 200, coordinator.state(sessionId, target.turn))
          return
        }
        const inspection = await engine.inspect({ cwd: checkpoint.cwd, restorePointId: checkpoint.id })
        const activeSessionIds = await sharedWorkspaceSessions(ctx.agents, checkpoint.cwd)
        const changes = inspection.changes.slice(offset, offset + limit)
        const common = {
          status: 'ready', sessionId, messageSeq, turn: checkpoint.turn, checkpointId: checkpoint.id,
          turnStartSeq: checkpoint.turnStartSeq,
          totalChanges: inspection.changes.length,
          changes: changes.map(change => ({ path: change.path, kind: change.kind })),
          offset,
          truncated: offset + changes.length < inspection.changes.length,
          headChanged: inspection.headChanged,
          operationChanged: inspection.operationChanged,
          checkpointHead: inspection.restorePoint.head,
          checkpointBranch: inspection.restorePoint.branch,
          checkpointOperation: inspection.restorePoint.operation,
          currentHead: inspection.currentHead,
          currentBranch: inspection.currentBranch,
          currentOperation: inspection.currentOperation,
          activeSessionIds,
          restoreBlocked: activeSessionIds.length > 0 || inspection.operationChanged,
        } as const
        if (inspection.changes.length === 0) {
          json(response, 200, common)
          return
        }
        if (detailsOnly || activeSessionIds.length > 0 || inspection.operationChanged) {
          json(response, 200, common)
          return
        }
        const plan = await engine.planRestore({
          cwd: checkpoint.cwd,
          restorePointId: checkpoint.id,
          sessionId,
          allowHeadChange: inspection.headChanged,
          expectedCurrentTreeHash: inspection.currentTreeHash,
          expectedRepository: inspection.currentRepository,
        })
        json(response, 200, { ...common, planId: plan.id, confirmation: plan.confirmation })
        return
      }
      if (request.method === 'POST') {
        const body = objectBody(await readBody(request))
        const mode = body.mode
        if (mode !== 'code' && mode !== 'both') {
          throw new ChangeLedgerError('INVALID_ARGUMENTS', 'mode must be "code" or "both"')
        }
        const sessionId = requiredText(body.sessionId, 'sessionId')
        const messageSeq = nonNegativeInteger(body.messageSeq, 'messageSeq')
        const checkpointId = requiredText(body.checkpointId, 'checkpointId')
        const checkpoint = await checkpointForRequest(ctx, engine, sessionId, messageSeq, checkpointId)
        const activeSessionIds = await sharedWorkspaceSessions(ctx.agents, checkpoint.cwd)
        if (activeSessionIds.length > 0) {
          throw new ChangeLedgerError(
            'WORKSPACE_IN_USE',
            `project files are also used by active sessions: ${activeSessionIds.slice(0, 5).join(', ')}`,
          )
        }
        const planId = optionalText(body.planId, 'planId')
        const confirmation = optionalText(body.confirmation, 'confirmation')
        if (planId === undefined || confirmation === undefined) {
          throw new ChangeLedgerError('NO_CHANGES', 'the selected turn has no project files to restore')
        }
        const restoreResult = await engine.applyRestore({ planId, confirmation, sessionId })
        if (mode === 'code') {
          json(response, 200, { status: 'completed', mode, ...restoreResult })
          return
        }

        try {
          const fork = await createConversationRestart(ctx, sessionId, checkpoint)
          json(response, 200, { status: 'completed', mode, sessionId: fork.sessionId, ...restoreResult })
        } catch (forkError) {
          if (restoreResult === undefined) throw forkError
          try {
            const rollbackPlan = await engine.planRestore({
              cwd: checkpoint.cwd,
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

async function readSession(
  ctx: Pick<Context, 'sessions' | 'sessionQuery'>,
  sessionId: string,
): Promise<SessionLike> {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live
  const stored = await ctx.sessionQuery.readSession(sessionId)
  return { id: sessionId, header: stored.session, events: stored.events }
}

interface MessageTarget {
  readonly messageSeq: number
  readonly turn: number
  readonly turnStartSeq: number
  readonly previousTurnEndSeq?: number
  readonly cwd: string
}

interface MessageCheckpoint extends MessageTarget {
  readonly id: string
}

async function resolveMessageCheckpoint(
  ctx: Pick<Context, 'sessions' | 'sessionQuery'>,
  engine: ChangeLedgerEngine,
  sessionId: string,
  messageSeq: number,
): Promise<{ readonly target: MessageTarget; readonly checkpoint?: MessageCheckpoint }> {
  let current = await readSession(ctx, sessionId)
  const target = messageTarget(current, messageSeq)
  const direct = await engine.findTurnCheckpoint({ cwd: target.cwd, sessionId, turn: target.turn })
  if (direct !== undefined) {
    if (direct.turnStartSeq !== target.turnStartSeq) {
      throw new ChangeLedgerError('PLAN_STALE', 'the message checkpoint no longer matches its turn start')
    }
    return { target, checkpoint: { ...target, id: direct.id } }
  }

  const seen = new Set<string>([sessionId])
  while (true) {
    const parentId = current.header.parentSession
    const seedLength = current.header.seedLength
    if ((parentId === undefined) !== (seedLength === undefined)) {
      throw new ChangeLedgerError('PLAN_STALE', 'session fork lineage has incomplete parent metadata')
    }
    if (parentId === undefined || seedLength === undefined
      || target.messageSeq >= seedLength || target.turnStartSeq >= seedLength) {
      return { target }
    }
    if (seen.has(parentId)) {
      throw new ChangeLedgerError('PLAN_STALE', 'session fork lineage contains a cycle')
    }
    seen.add(parentId)
    try {
      current = await readSession(ctx, parentId)
    } catch (error) {
      throw new ChangeLedgerError('PLAN_STALE', `parent session ${parentId} is unavailable`, { cause: error })
    }
    const parentTarget = messageTarget(current, messageSeq)
    if (parentTarget.turn !== target.turn
      || parentTarget.turnStartSeq !== target.turnStartSeq
      || parentTarget.previousTurnEndSeq !== target.previousTurnEndSeq) {
      throw new ChangeLedgerError('PLAN_STALE', 'session fork lineage no longer matches the inherited message boundary')
    }
    const inherited = await engine.findTurnCheckpoint({ cwd: target.cwd, sessionId: parentId, turn: target.turn })
    if (inherited === undefined) continue
    if (inherited.turnStartSeq !== target.turnStartSeq) {
      throw new ChangeLedgerError('PLAN_STALE', 'the inherited message checkpoint no longer matches the fork boundary')
    }
    return { target, checkpoint: { ...target, id: inherited.id } }
  }
}

async function checkpointForRequest(
  ctx: Pick<Context, 'sessions' | 'sessionQuery'>,
  engine: ChangeLedgerEngine,
  sessionId: string,
  messageSeq: number,
  requestedId: string,
): Promise<MessageCheckpoint> {
  const { target, checkpoint } = await resolveMessageCheckpoint(ctx, engine, sessionId, messageSeq)
  if (checkpoint === undefined) {
    throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `message ${String(target.messageSeq)} has no rewind checkpoint`)
  }
  if (requestedId !== checkpoint.id) {
    throw new ChangeLedgerError('PLAN_STALE', 'the selected message checkpoint changed; reopen the rewind dialog')
  }
  return checkpoint
}

async function createConversationRestart(
  ctx: Pick<Context, 'sessions' | 'sessionQuery' | 'apiProxy'>,
  sourceId: string,
  checkpoint: MessageCheckpoint,
): Promise<{ readonly sessionId: string }> {
  const source = await readSession(ctx, sourceId)
  const current = messageTarget(source, checkpoint.messageSeq)
  if (current.turn !== checkpoint.turn
    || current.turnStartSeq !== checkpoint.turnStartSeq
    || current.previousTurnEndSeq !== checkpoint.previousTurnEndSeq) {
    throw new ChangeLedgerError('PLAN_STALE', 'the session no longer contains the selected message boundary')
  }
  const response = checkpoint.previousTurnEndSeq === undefined
    ? await ctx.apiProxy.sessions.create({
        rpcId: randomUUID(),
        payload: { cwd: checkpoint.cwd },
      })
    : await ctx.apiProxy.sessions.fork({
        rpcId: randomUUID(),
        payload: { sessionId: sourceId, atSeq: checkpoint.previousTurnEndSeq },
      })
  if (!response.result.ok) {
    throw new ChangeLedgerError('CONVERSATION_REWIND_FAILED', response.result.error.message)
  }
  return { sessionId: requiredText(response.result.value.sessionId, 'fork sessionId') }
}

function messageTarget(session: SessionLike, messageSeq: number): MessageTarget {
  const cwd = session.header.cwd
  if (cwd === undefined) throw new ChangeLedgerError('WORKSPACE_REQUIRED', `session ${session.id} has no workspace`)
  const message = session.events.find(event => event.type === 'user/message' && event.seq === messageSeq && isDirectUserMessage(event))
  if (message === undefined) {
    throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `session ${session.id} has no user message at ${String(messageSeq)}`)
  }
  const start = session.events.findLast(event => event.type === 'turn/start' && event.seq < messageSeq)
  const turn = start?.data.turn
  if (start === undefined || !Number.isSafeInteger(turn) || (turn as number) < 0) {
    throw new ChangeLedgerError('PLAN_STALE', 'the selected user message has no valid turn start')
  }
  const openingMessage = session.events.find(event => (
    event.type === 'user/message'
    && event.seq > start.seq
    && event.seq <= messageSeq
    && isDirectUserMessage(event)
  ))
  if (openingMessage?.seq !== messageSeq) {
    throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', 'rewind is available only for the opening user message of a turn')
  }
  const interveningEnd = session.events.find(event => event.type === 'turn/end' && event.seq > start.seq && event.seq < messageSeq)
  if (interveningEnd !== undefined) {
    throw new ChangeLedgerError('PLAN_STALE', 'the selected user message is outside its recorded turn')
  }
  const previousEnd = session.events.findLast(event => event.type === 'turn/end' && event.seq < start.seq)
  return {
    messageSeq,
    turn: turn as number,
    turnStartSeq: start.seq,
    ...(previousEnd === undefined ? {} : { previousTurnEndSeq: previousEnd.seq }),
    cwd,
  }
}

function isDirectUserMessage(event: SessionEventLike): boolean {
  const source = event.data.source
  return source !== null && typeof source === 'object' && !Array.isArray(source)
    && (source as Record<string, unknown>).kind === 'user'
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

function pageSize(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback
  const parsed = nonNegativeInteger(value, 'limit')
  if (parsed < 1 || parsed > MAX_CHANGE_PAGE_SIZE) {
    throw new ChangeLedgerError('INVALID_ARGUMENTS', `limit must be between 1 and ${String(MAX_CHANGE_PAGE_SIZE)}`)
  }
  return parsed
}

async function sharedWorkspaceSessions(
  agents: AgentsLike | undefined,
  cwd: string,
): Promise<readonly string[]> {
  const listed = agents?.list() ?? []
  if (listed.length === 0) return []
  const root = await discoverRepositoryRoot(cwd)
  const shared: string[] = []
  for (const agent of listed) {
    if (agent.status !== 'running') continue
    const session = agent.session
    if (session.header.cwd === undefined) continue
    try {
      if (await discoverRepositoryRoot(session.header.cwd) === root) shared.push(session.id)
    } catch {
      // A live Session whose cwd is not a valid Git worktree cannot share this worktree.
    }
  }
  return shared.sort()
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
