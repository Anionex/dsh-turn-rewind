import type { ResolvedChangeLedgerConfig, RestoreOperation, RestorePointManifest, RestorePointManifestV2 } from './types.js';
export interface GitCheckpointJournal {
    readonly version: 1;
    readonly action: 'publish' | 'delete';
    readonly storeId: string;
    readonly workspace: string;
    readonly commonDir: string;
    readonly worktreeId: string;
    readonly restorePointId: string;
    readonly ref: string;
    readonly commit: string;
    readonly createdAt: number;
}
export interface TurnCheckpointSkip {
    readonly version: 1;
    readonly sessionId: string;
    readonly turn: number;
    readonly turnStartSeq: number;
    readonly reason: string;
    readonly createdAt: number;
}
/** Durable content-addressed storage and per-workspace locking. */
export declare class LedgerStore {
    readonly config: ResolvedChangeLedgerConfig;
    private readonly workspaceKeys;
    private storeIdValue;
    constructor(config: ResolvedChangeLedgerConfig);
    /** Create the state root and reconcile crash-interrupted operations. */
    initialize(): Promise<number>;
    /** Durable owner of this storage root's private Git namespace. */
    get storeId(): string;
    /** Acquire the exclusive lock for one canonical workspace. */
    acquire(workspace: string, sharedLockPath?: string, binding?: {
        readonly commonDir: string;
        readonly gitDir: string;
        readonly worktreeId: string;
    }, signal?: AbortSignal): Promise<() => Promise<void>>;
    private acquireOne;
    /** Persist a blob if it is not already present, and verify existing content. */
    putBlob(workspace: string, hash: string, content: Buffer): Promise<void>;
    /** Read and verify one content-addressed blob. */
    readBlob(workspace: string, hash: string): Promise<Buffer>;
    /** Write one restore-point manifest atomically. */
    writeManifest(manifest: RestorePointManifest): Promise<void>;
    /** Load and validate one restore-point manifest. */
    readManifest(workspace: string, id: string): Promise<RestorePointManifest>;
    /** List all validated restore points for one workspace, newest first. */
    listManifests(workspace: string, signal?: AbortSignal): Promise<RestorePointManifest[]>;
    /** List validated manifests directly from one storage directory, newest first. */
    listManifestsInDir(workspaceDir: string, signal?: AbortSignal): Promise<RestorePointManifest[]>;
    /** Delete one restore-point manifest. Blobs remain until garbage collection succeeds. */
    deleteManifest(workspace: string, id: string): Promise<void>;
    /** Delete one restore-point manifest directly from its storage directory. */
    deleteManifestInDir(workspaceDir: string, id: string): Promise<void>;
    /** Persist the intent needed to finish or roll back a Git ref/manifest transition after a crash. */
    writeGitCheckpointJournal(action: GitCheckpointJournal['action'], manifest: RestorePointManifestV2): Promise<void>;
    /** List every persisted workspace directory under this storage root. */
    listWorkspaceDirs(signal?: AbortSignal): Promise<string[]>;
    /** List every pending Git checkpoint transition across this storage root. */
    listGitCheckpointJournals(): Promise<GitCheckpointJournal[]>;
    /** List pending Git checkpoint transitions directly from one storage directory. */
    listGitCheckpointJournalsInDir(workspaceDir: string, signal?: AbortSignal): Promise<GitCheckpointJournal[]>;
    /** Remove one completed Git checkpoint transition journal. */
    deleteGitCheckpointJournal(workspace: string, id: string): Promise<void>;
    /** Persist one explicit automatic-checkpoint skip so the UI survives restarts. */
    writeTurnCheckpointSkip(workspace: string, skip: TurnCheckpointSkip): Promise<void>;
    /** Read one durable automatic-checkpoint skip. */
    readTurnCheckpointSkip(workspace: string, sessionId: string, turn: number, turnStartSeq: number): Promise<TurnCheckpointSkip | undefined>;
    /** Remove a stale skip after the same turn obtains a ready checkpoint. */
    deleteTurnCheckpointSkip(workspace: string, sessionId: string, turn: number, turnStartSeq: number): Promise<void>;
    /** Mark a legacy capture whose unreferenced blobs need crash recovery. */
    writeSnapshotCleanup(workspace: string): Promise<void>;
    /** Clear a completed legacy-capture cleanup marker. */
    deleteSnapshotCleanup(workspace: string): Promise<void>;
    /** Persist one restore-operation journal. */
    writeOperation(operation: RestoreOperation): Promise<void>;
    /** List validated restore operations for one workspace. */
    listOperations(workspace: string): Promise<RestoreOperation[]>;
    /** List validated restore operations directly from one storage directory. */
    listOperationsInDir(workspaceDir: string, signal?: AbortSignal): Promise<RestoreOperation[]>;
    /** Return whether an incomplete operation still references a restore point. */
    isReferencedByRecovery(workspace: string, restorePointId: string): Promise<boolean>;
    /** Delete blobs not referenced by any remaining manifest. */
    collectGarbage(workspace: string, additionalReferenced?: Iterable<string>, signal?: AbortSignal): Promise<{
        deletedBlobs: number;
        retainedBlobs: number;
    }>;
    /** Delete blobs under one storage directory that no manifest in it references. */
    collectGarbageInDir(workspaceDir: string, signal?: AbortSignal): Promise<{
        deletedBlobs: number;
        retainedBlobs: number;
    }>;
    /** Remove every persisted automatic-checkpoint skip marker under one storage directory. */
    clearTurnOutcomesInDir(workspaceDir: string): Promise<number>;
    private sweepBlobs;
    /** Finish a prior bounded legacy capture's orphan cleanup, if one is pending. */
    reconcileSnapshotCleanup(workspace: string, signal?: AbortSignal): Promise<boolean>;
    private workspaceDir;
    private assertManifestOwned;
    private assertGitCheckpointJournalOwned;
    private assertManifestWorkspaceIdentity;
    private assertGitCheckpointJournalWorkspaceIdentity;
    private manifestPath;
    private operationPath;
    private gitCheckpointJournalPath;
    private turnCheckpointSkipPath;
    private blobPath;
    private bindGitWorkspace;
    private reconcileWorkspaceMigrations;
    private completeWorkspaceMigration;
    private assertNoUnresolvedWorkspaceOwnership;
    private ensureWorktreeClaim;
    private completeWorkspaceRebind;
    private rewriteWorkspaceRoot;
    private prepareLockReclaim;
    private completeLockReclaims;
    private acquireLockReclaimOwnership;
    private lockIsReclaimable;
}
/** Create or read the durable owner of one storage root's private Git namespace. */
export declare function ensureStoreId(storageDir: string): Promise<string>;
