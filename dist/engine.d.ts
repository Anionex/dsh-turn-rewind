import { LedgerStore } from './store.js';
import { type ChangeLedgerConfig, type RecoverySummary, type ResolvedChangeLedgerConfig, type RestorePlan, type RestorePointInspection, type RestorePointSummary, type RestoreResult } from './types.js';
/** Persistent workspace change-set engine, independent of the DSH tool adapter. */
export declare class ChangeLedgerEngine {
    readonly config: ResolvedChangeLedgerConfig;
    readonly store: LedgerStore;
    private readonly plans;
    private readonly ready;
    /** Build an engine and start crash-journal reconciliation. */
    constructor(config?: ChangeLedgerConfig);
    /** Wait for startup reconciliation and return the number of interrupted journals found. */
    initialize(): Promise<number>;
    /** Create a durable restore point for the current Git worktree. */
    create(options: {
        readonly cwd: string;
        readonly sessionId?: string;
        readonly label?: string;
        readonly signal?: AbortSignal;
    }): Promise<RestorePointSummary>;
    /** Capture one completed DSH turn for user-triggered Web rewind. */
    createTurnCheckpoint(options: {
        readonly cwd: string;
        readonly sessionId: string;
        readonly turn: number;
        readonly turnEndSeq: number;
        readonly signal?: AbortSignal;
    }): Promise<RestorePointSummary>;
    /** Find the newest checkpoint for one completed session turn. */
    findTurnCheckpoint(options: {
        readonly cwd: string;
        readonly sessionId: string;
        readonly turn: number;
        readonly signal?: AbortSignal;
    }): Promise<RestorePointSummary | undefined>;
    /** List restore points for the current worktree. */
    list(options: {
        readonly cwd: string;
        readonly includeRescue?: boolean;
        readonly includeTurnCheckpoints?: boolean;
        readonly signal?: AbortSignal;
    }): Promise<RestorePointSummary[]>;
    /** Compare one restore point with the current worktree. */
    inspect(options: {
        readonly cwd: string;
        readonly restorePointId: string;
        readonly signal?: AbortSignal;
    }): Promise<RestorePointInspection>;
    /** Produce an expiring, exact confirmation plan for a restore. */
    planRestore(options: {
        readonly cwd: string;
        readonly restorePointId: string;
        readonly sessionId?: string;
        readonly paths?: readonly string[];
        readonly allowHeadChange?: boolean;
        readonly signal?: AbortSignal;
    }): Promise<RestorePlan>;
    /** Apply one approved restore plan, creating a durable rescue point first. */
    applyRestore(options: {
        readonly planId: string;
        readonly confirmation: string;
        readonly sessionId?: string;
        readonly signal?: AbortSignal;
    }): Promise<RestoreResult>;
    /** Delete one restore point and collect unreferenced blobs. */
    delete(options: {
        readonly cwd: string;
        readonly restorePointId: string;
        readonly confirmation: string;
        readonly signal?: AbortSignal;
    }): Promise<{
        readonly restorePointId: string;
        readonly deletedBlobs: number;
        readonly retainedBlobs: number;
    }>;
    /** List restore operations that were interrupted or require manual recovery. */
    listRecovery(options: {
        readonly cwd: string;
        readonly signal?: AbortSignal;
    }): Promise<RecoverySummary[]>;
    private createLocked;
    private restorePaths;
    private verifyPaths;
    private assertStorageSeparated;
    private expirePlans;
}
/** Resolve and validate every deployment-varying configuration value. */
export declare function resolveConfig(config: ChangeLedgerConfig): ResolvedChangeLedgerConfig;
//# sourceMappingURL=engine.d.ts.map