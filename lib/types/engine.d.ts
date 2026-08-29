import { LedgerStore } from './store.js';
import { type ChangeLedgerConfig, type RecoverySummary, type ResolvedChangeLedgerConfig, type RestorePlan, type RestorePointInspection, type RestorePointManifest, type RestorePointSummary, type RestoreResult, type WorkspaceOverview, type WorkspacePurgeReport } from './types.js';
/** Persistent workspace change-set engine, independent of the DSH tool adapter. */
export declare class ChangeLedgerEngine {
    private readonly currentConfig;
    readonly store: LedgerStore;
    private readonly plans;
    private readonly activePlans;
    private readonly ready;
    /** Build an engine and start crash-journal reconciliation. */
    constructor(config?: ChangeLedgerConfig);
    /** Currently resolved configuration; runtime-tunable fields update in place. */
    get config(): ResolvedChangeLedgerConfig;
    /**
     * Swap runtime-tunable configuration (limits, modes, timeouts, trust) in place.
     * The storage root must never move once the engine owns locks and journals.
     */
    updateConfig(config: ChangeLedgerConfig): void;
    /** Wait for startup reconciliation and return the number of interrupted journals found. */
    initialize(): Promise<number>;
    private initializeStore;
    private acquireWorkspace;
    private reconcileGitCheckpointJournals;
    private publishGitManifest;
    private deleteManifestWithGit;
    private tryReadManifest;
    /** Create a durable restore point for the current Git worktree. */
    create(options: {
        readonly cwd: string;
        readonly sessionId?: string;
        readonly label?: string;
        readonly signal?: AbortSignal;
    }): Promise<RestorePointSummary>;
    /** Capture project files before one DSH turn begins its first step. */
    createTurnCheckpoint(options: {
        readonly cwd: string;
        readonly sessionId: string;
        readonly turn: number;
        readonly turnStartSeq: number;
        readonly signal?: AbortSignal;
    }): Promise<RestorePointSummary>;
    /** Persist one bounded automatic-checkpoint skip without blocking a later turn retry. */
    recordTurnCheckpointSkip(options: {
        readonly cwd: string;
        readonly sessionId: string;
        readonly turn: number;
        readonly turnStartSeq: number;
        readonly reason: string;
        readonly signal?: AbortSignal;
    }): Promise<void>;
    /** Read a durable skip marker for one exact prompt boundary. */
    findTurnCheckpointSkip(options: {
        readonly cwd: string;
        readonly sessionId: string;
        readonly turn: number;
        readonly turnStartSeq: number;
        readonly signal?: AbortSignal;
    }): Promise<{
        readonly reason: string;
    } | undefined>;
    /** Find the prompt-anchored checkpoint captured before one session turn. */
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
        readonly expectedCurrentTreeHash?: string;
        readonly expectedRepository?: RestorePointManifest['repository'];
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
    /** Inventory every workspace this storage root has ever persisted state for. */
    listWorkspaces(options?: {
        readonly signal?: AbortSignal;
    }): Promise<WorkspaceOverview[]>;
    /** Delete unprotected restore points recorded for one workspace and collect unused blobs. */
    purgeWorkspace(options: {
        readonly workspace: string;
        /** Restrict the purge to these restore points; protection rules still apply. */
        readonly restorePointIds?: readonly string[];
        readonly signal?: AbortSignal;
    }): Promise<WorkspacePurgeReport>;
    private purgeWorkspaceDir;
    private createLocked;
    private restorePaths;
    private assertPathFresh;
    private verifyPaths;
    private captureSelectedEntries;
    private assertStorageSeparated;
    private expirePlans;
}
/** Resolve and validate every deployment-varying configuration value. */
export declare function resolveConfig(config: ChangeLedgerConfig): ResolvedChangeLedgerConfig;
