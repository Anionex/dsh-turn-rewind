/**
 * DSH Turn Rewind, powered by persistent, inspectable, approval-gated Change Ledger restore points.
 * @module @dsh-external/turn-rewind
 */
import { Service, type Context } from 'cordis'
import { ChangeLedgerEngine } from './engine.js'
import { installRewindHttp, TurnCheckpointCoordinator } from './rewind-host.js'
import type { ChangeLedgerConfig } from './types.js'

export * from './engine.js'
export * from './errors.js'
export * from './rewind-host.js'
export * from './types.js'

declare module 'cordis' {
  interface Context {
    changeLedger: ChangeLedgerService
  }
}

/** Cordis service exposed as `ctx.changeLedger` for other DSH plugins. */
export class ChangeLedgerService extends Service {
  readonly engine: ChangeLedgerEngine

  /** Register the service and startup reconciliation. */
  constructor(ctx: Context, config: ChangeLedgerConfig = {}) {
    super(ctx, 'changeLedger')
    this.engine = new ChangeLedgerEngine(config)
    const checkpoints = new TurnCheckpointCoordinator(this.engine)
    ctx.inject(['agents'], (scope: Context) => { checkpoints.install(scope) })
    ctx.inject(['httpServer', 'sessions', 'sessionQuery', 'apiProxy', 'agents'], (scope: Context) => {
      installRewindHttp(scope, this.engine, checkpoints)
    })
    void this.engine.initialize().then((reconciled) => {
      if (reconciled > 0) {
        ctx.logger.warn(`[change-ledger] marked ${reconciled} interrupted restore operation(s) for manual recovery`)
      } else {
        ctx.logger.info(`[change-ledger] ready; state=${this.engine.config.storageDir}`)
      }
    }).catch((error: unknown) => {
      ctx.logger.error(`[change-ledger] startup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Wait for startup reconciliation. */
  initialize(): ReturnType<ChangeLedgerEngine['initialize']> {
    return this.engine.initialize()
  }

  /** Create a user restore point. */
  create(options: Parameters<ChangeLedgerEngine['create']>[0]): ReturnType<ChangeLedgerEngine['create']> {
    return this.engine.create(options)
  }

  /** Capture project files before one turn enters its first Agent step. */
  createTurnCheckpoint(
    options: Parameters<ChangeLedgerEngine['createTurnCheckpoint']>[0],
  ): ReturnType<ChangeLedgerEngine['createTurnCheckpoint']> {
    return this.engine.createTurnCheckpoint(options)
  }

  /** Find the prompt-anchored checkpoint for one session turn. */
  findTurnCheckpoint(
    options: Parameters<ChangeLedgerEngine['findTurnCheckpoint']>[0],
  ): ReturnType<ChangeLedgerEngine['findTurnCheckpoint']> {
    return this.engine.findTurnCheckpoint(options)
  }

  /** List restore points. */
  list(options: Parameters<ChangeLedgerEngine['list']>[0]): ReturnType<ChangeLedgerEngine['list']> {
    return this.engine.list(options)
  }

  /** Compare a restore point with the current worktree. */
  inspect(options: Parameters<ChangeLedgerEngine['inspect']>[0]): ReturnType<ChangeLedgerEngine['inspect']> {
    return this.engine.inspect(options)
  }

  /** Create an expiring restore plan. */
  planRestore(options: Parameters<ChangeLedgerEngine['planRestore']>[0]): ReturnType<ChangeLedgerEngine['planRestore']> {
    return this.engine.planRestore(options)
  }

  /** Apply an exact restore plan after approval. */
  applyRestore(options: Parameters<ChangeLedgerEngine['applyRestore']>[0]): ReturnType<ChangeLedgerEngine['applyRestore']> {
    return this.engine.applyRestore(options)
  }

  /** Delete one restore point and collect unused blobs. */
  delete(options: Parameters<ChangeLedgerEngine['delete']>[0]): ReturnType<ChangeLedgerEngine['delete']> {
    return this.engine.delete(options)
  }

  /** List interrupted restore operations and their rescue points. */
  listRecovery(options: Parameters<ChangeLedgerEngine['listRecovery']>[0]): ReturnType<ChangeLedgerEngine['listRecovery']> {
    return this.engine.listRecovery(options)
  }
}

export default ChangeLedgerService
