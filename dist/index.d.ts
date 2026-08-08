/**
 * DSH Change Ledger: persistent, inspectable, approval-gated workspace restore points.
 * @module @dsh-external/change-ledger
 */
import { Service, type Context } from 'cordis';
import { ChangeLedgerEngine } from './engine.js';
import type { ChangeLedgerConfig } from './types.js';
export * from './engine.js';
export * from './errors.js';
export * from './rewind-host.js';
export * from './types.js';
declare module 'cordis' {
    interface Context {
        changeLedger: ChangeLedgerService;
    }
}
/** Cordis service exposed as `ctx.changeLedger` for other DSH plugins. */
export declare class ChangeLedgerService extends Service {
    static inject: string[];
    readonly engine: ChangeLedgerEngine;
    /** Register the service, startup reconciliation, and model-facing tools. */
    constructor(ctx: Context, config?: ChangeLedgerConfig);
    /** Wait for startup reconciliation. */
    initialize(): ReturnType<ChangeLedgerEngine['initialize']>;
    /** Create a user restore point. */
    create(options: Parameters<ChangeLedgerEngine['create']>[0]): ReturnType<ChangeLedgerEngine['create']>;
    /** Capture one completed turn for Web rewind. */
    createTurnCheckpoint(options: Parameters<ChangeLedgerEngine['createTurnCheckpoint']>[0]): ReturnType<ChangeLedgerEngine['createTurnCheckpoint']>;
    /** Find the newest checkpoint for one completed turn. */
    findTurnCheckpoint(options: Parameters<ChangeLedgerEngine['findTurnCheckpoint']>[0]): ReturnType<ChangeLedgerEngine['findTurnCheckpoint']>;
    /** List restore points. */
    list(options: Parameters<ChangeLedgerEngine['list']>[0]): ReturnType<ChangeLedgerEngine['list']>;
    /** Compare a restore point with the current worktree. */
    inspect(options: Parameters<ChangeLedgerEngine['inspect']>[0]): ReturnType<ChangeLedgerEngine['inspect']>;
    /** Create an expiring restore plan. */
    planRestore(options: Parameters<ChangeLedgerEngine['planRestore']>[0]): ReturnType<ChangeLedgerEngine['planRestore']>;
    /** Apply an exact restore plan after approval. */
    applyRestore(options: Parameters<ChangeLedgerEngine['applyRestore']>[0]): ReturnType<ChangeLedgerEngine['applyRestore']>;
    /** Delete one restore point and collect unused blobs. */
    delete(options: Parameters<ChangeLedgerEngine['delete']>[0]): ReturnType<ChangeLedgerEngine['delete']>;
    /** List interrupted restore operations and their rescue points. */
    listRecovery(options: Parameters<ChangeLedgerEngine['listRecovery']>[0]): ReturnType<ChangeLedgerEngine['listRecovery']>;
}
export default ChangeLedgerService;
//# sourceMappingURL=index.d.ts.map