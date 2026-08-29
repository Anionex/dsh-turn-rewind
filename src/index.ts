/**
 * DSH Turn Rewind, powered by persistent, inspectable, approval-gated Change Ledger restore points.
 * @module @anionex/dsh-turn-rewind
 */
import type { Context } from '@deepseek-ai/cordis'
import { ChangeLedgerEngine } from './engine.js'
import { installManageHttp, installRewindHttp, TurnCheckpointCoordinator } from './rewind-host.js'
import { installTurnRewindSettings } from './settings.js'
import type { ChangeLedgerConfig } from './types.js'

export * from './engine.js'
export * from './errors.js'
export * from './rewind-host.js'
export * from './settings.js'
export * from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    changeLedger: ChangeLedgerService
  }
}

/** Cordis service exposed as `ctx.changeLedger` for other DSH plugins. */
export class ChangeLedgerService {
  readonly engine: ChangeLedgerEngine

  /** Register the service and startup reconciliation. */
  constructor(ctx: Context, config: ChangeLedgerConfig = {}) {
    ctx.provide('changeLedger', this)
    this.engine = new ChangeLedgerEngine(config)
    const checkpoints = new TurnCheckpointCoordinator(this.engine)
    ctx.inject(['agents'], (scope: Context) => { checkpoints.install(scope) })
    ctx.inject(['webServer', 'sessions', 'sessionQuery', 'apiProxy', 'agents'], (scope: Context) => {
      installRewindHttp(scope, this.engine, checkpoints)
      installManageHttp(scope, this.engine)
    })
    installTurnRewindSettings(ctx, config, this.engine)
    void this.engine.initialize().then((reconciled) => {
      if (reconciled > 0) {
        ctx.logger.warn(`[change-ledger] reconciled ${reconciled} interrupted durable operation(s)`)
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

  /** Inventory every workspace this storage root has persisted state for. */
  listWorkspaces(options?: Parameters<ChangeLedgerEngine['listWorkspaces']>[0]): ReturnType<ChangeLedgerEngine['listWorkspaces']> {
    return this.engine.listWorkspaces(options)
  }

  /** Delete unprotected restore points recorded for one workspace. */
  purgeWorkspace(options: Parameters<ChangeLedgerEngine['purgeWorkspace']>[0]): ReturnType<ChangeLedgerEngine['purgeWorkspace']> {
    return this.engine.purgeWorkspace(options)
  }

  /** Swap runtime-tunable configuration; the storage root must stay fixed. */
  updateConfig(config: ChangeLedgerConfig): void {
    this.engine.updateConfig(config)
  }
}

export default ChangeLedgerService
