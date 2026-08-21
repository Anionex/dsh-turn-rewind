/** Durable format version. Readers reject every other version. */
export declare const LEDGER_FORMAT_VERSION: 1;
/** Git-native checkpoint format used by bounded automatic turn capture. */
export declare const GIT_CHECKPOINT_FORMAT_VERSION: 2;
/** A persisted restore-point identifier. */
export type RestorePointId = string;
/** A persisted restore-operation identifier. */
export type RestoreOperationId = string;
/** An in-memory, expiring restore-plan identifier. */
export type RestorePlanId = string;
/** One regular-file snapshot. */
export interface FileSnapshotEntry {
    readonly kind: 'file';
    readonly blob: string;
    readonly size: number;
    readonly mode: number;
    /** Absent for v1 Ledger blobs; `git` means `blob` is a Git object ID. */
    readonly provider?: 'git';
}
/** One symbolic-link snapshot. */
export interface SymlinkSnapshotEntry {
    readonly kind: 'symlink';
    readonly target: string;
    readonly mode: number;
}
/** One path captured by a restore point. */
export type SnapshotEntry = FileSnapshotEntry | SymlinkSnapshotEntry;
/** Git facts that fence a restore point to the repository state it observed. */
export interface RepositoryState {
    readonly root: string;
    readonly commonDir: string;
    readonly head?: string;
    readonly branch?: string;
    readonly operation?: string;
    readonly stagedPaths: readonly string[];
}
/** Why a restore point exists. */
export type RestorePointKind = 'user' | 'rescue' | 'turn';
/** Durable workspace restore point. */
export interface RestorePointManifestV1 {
    readonly version: typeof LEDGER_FORMAT_VERSION;
    readonly id: RestorePointId;
    readonly kind: RestorePointKind;
    readonly workspace: string;
    readonly repository: RepositoryState;
    readonly sessionId?: string;
    readonly label?: string;
    readonly parentRestorePoint?: RestorePointId;
    /** DSH turn whose opening user request owns this automatic Web rewind checkpoint. */
    readonly turn?: number;
    /** Inclusive `turn/start` event sequence; the snapshot was captured before the turn entered its first step. */
    readonly turnStartSeq?: number;
    /** Legacy inclusive `turn/end` event sequence used by checkpoints created before prompt-anchored rewind. */
    readonly turnEndSeq?: number;
    readonly createdAt: number;
    readonly treeHash: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly entries: Readonly<Record<string, SnapshotEntry>>;
    readonly restoreCount: number;
    readonly lastRestoredAt?: number;
}
/** Git-native metadata pinned by a private ref. */
export interface GitCheckpointMetadata {
    readonly objectFormat: 'sha1' | 'sha256';
    readonly trust: 'metadata-fenced' | 'byte-verified';
    /** Stable owner of refs created by one Change Ledger storage root. */
    readonly storeId: string;
    /** Durable identity stored inside this specific Git worktree metadata directory. */
    readonly worktreeId: string;
    readonly headTree: string;
    readonly indexTree: string;
    readonly worktreeTree: string;
    readonly envelopeTree: string;
    readonly commit: string;
    readonly ref: string;
    readonly newlyStoredBytes: number;
}
/** Automatic turn checkpoint whose content is stored in the repository object database. */
export interface RestorePointManifestV2 extends Omit<RestorePointManifestV1, 'version' | 'treeHash'> {
    readonly version: typeof GIT_CHECKPOINT_FORMAT_VERSION;
    /** Deterministic sidecar identity; Git tree integrity is verified separately. */
    readonly treeHash: string;
    readonly git: GitCheckpointMetadata;
}
/** Durable workspace restore point in either supported format. */
export type RestorePointManifest = RestorePointManifestV1 | RestorePointManifestV2;
/** Observable difference between a restore point and the current workspace. */
export interface WorkspaceChange {
    readonly path: string;
    readonly kind: 'added' | 'deleted' | 'modified' | 'mode-changed' | 'type-changed';
    readonly before?: SnapshotEntry;
    readonly after?: SnapshotEntry;
}
/** Result of comparing one restore point with its workspace. */
export interface RestorePointInspection {
    readonly restorePoint: RestorePointSummary;
    readonly currentTreeHash: string;
    readonly currentRepository: RepositoryState;
    readonly currentHead?: string;
    readonly currentBranch?: string;
    readonly currentOperation?: string;
    readonly headChanged: boolean;
    readonly operationChanged: boolean;
    readonly changes: readonly WorkspaceChange[];
}
/** Compact restore-point metadata for lists and tool results. */
export interface RestorePointSummary {
    readonly format: typeof LEDGER_FORMAT_VERSION | typeof GIT_CHECKPOINT_FORMAT_VERSION;
    readonly id: RestorePointId;
    readonly kind: RestorePointKind;
    readonly workspace: string;
    readonly sessionId?: string;
    readonly label?: string;
    readonly parentRestorePoint?: RestorePointId;
    readonly turn?: number;
    readonly turnStartSeq?: number;
    readonly turnEndSeq?: number;
    readonly createdAt: number;
    readonly treeHash: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly restoreCount: number;
    readonly lastRestoredAt?: number;
    readonly head?: string;
    readonly branch?: string;
    readonly operation?: string;
    readonly stagedPathCount: number;
    readonly trust?: GitCheckpointMetadata['trust'];
}
/** An expiring restore plan whose confirmation must be echoed exactly. */
export interface RestorePlan {
    readonly id: RestorePlanId;
    readonly restorePointId: RestorePointId;
    readonly workspace: string;
    readonly repository: RepositoryState;
    readonly sessionId?: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly confirmation: string;
    readonly allowHeadChange: boolean;
    readonly paths: readonly string[];
    readonly changes: readonly WorkspaceChange[];
    readonly expected: Readonly<Record<string, SnapshotEntry | null>>;
}
/** Durable journal for one attempted restore. */
export interface RestoreOperation {
    readonly version: typeof LEDGER_FORMAT_VERSION;
    readonly id: RestoreOperationId;
    readonly workspace: string;
    readonly restorePointId: RestorePointId;
    readonly rescuePointId: RestorePointId;
    readonly sessionId?: string;
    readonly paths: readonly string[];
    readonly startedAt: number;
    readonly finishedAt?: number;
    readonly state: 'running' | 'rollback-running' | 'completed' | 'rolled-back' | 'interrupted' | 'recovery-required';
    readonly error?: string;
    readonly rollbackError?: string;
}
/** A completed restore result. */
export interface RestoreResult {
    readonly operationId: RestoreOperationId;
    readonly restorePointId: RestorePointId;
    readonly rescuePointId: RestorePointId;
    readonly restoredPaths: readonly string[];
}
/** Public plugin configuration. */
export interface ChangeLedgerConfig {
    /** State directory. Must live outside every managed workspace. */
    readonly storageDir?: string;
    /** Maximum user and rescue restore points retained per workspace. */
    readonly maxRestorePoints?: number;
    /** Maximum automatic turn checkpoints retained per session. */
    readonly maxTurnCheckpointsPerSession?: number;
    /** Maximum number of files in one restore point. */
    readonly maxFiles?: number;
    /** Maximum bytes read from one regular file. */
    readonly maxFileBytes?: number;
    /** Maximum aggregate regular-file bytes in one restore point. */
    readonly maxSnapshotBytes?: number;
    /** Restore-plan lifetime in milliseconds. */
    readonly planTtlMs?: number;
    /** Age after which a lock whose owner is gone may be reclaimed. */
    readonly staleLockMs?: number;
    /** Automatic turn-checkpoint implementation. Git-native is bounded and avoids rereading clean tracked content. */
    readonly turnCheckpointMode?: 'off' | 'git-native' | 'legacy';
    /** Maximum time one automatic checkpoint may block the first Agent step. */
    readonly turnCheckpointTimeoutMs?: number;
    /** Maximum uncached worktree bytes read by one automatic Git-native checkpoint. */
    readonly turnCheckpointMaxNewBytes?: number;
    /** Fast trusts fenced Git/stat metadata; strict rereads every eligible path. */
    readonly turnCheckpointTrust?: 'fast' | 'strict';
}
/** Fully resolved plugin configuration. */
export interface ResolvedChangeLedgerConfig {
    readonly storageDir: string;
    readonly maxRestorePoints: number;
    readonly maxTurnCheckpointsPerSession: number;
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxSnapshotBytes: number;
    readonly planTtlMs: number;
    readonly staleLockMs: number;
    readonly turnCheckpointMode: 'off' | 'git-native' | 'legacy';
    readonly turnCheckpointTimeoutMs: number;
    readonly turnCheckpointMaxNewBytes: number;
    readonly turnCheckpointTrust: 'fast' | 'strict';
}
/** Current incomplete restore operation. */
export interface RecoverySummary {
    readonly operationId: RestoreOperationId;
    readonly restorePointId: RestorePointId;
    readonly rescuePointId: RestorePointId;
    readonly state: 'interrupted' | 'recovery-required';
    readonly paths: readonly string[];
    readonly startedAt: number;
    readonly error?: string;
    readonly rollbackError?: string;
}
