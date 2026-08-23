import { type ResolvedChangeLedgerConfig, type RestorePointManifestV2 } from './types.js';
interface CacheRecord {
    readonly kind: 'file' | 'symlink';
    readonly mode: number;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
    readonly dev: string;
    readonly ino: string;
    readonly indexOid?: string;
    readonly attributes: string;
    readonly oid: string;
    readonly target?: string;
}
interface GitCache {
    readonly version: 2;
    readonly storeId: string;
    readonly worktreeId: string;
    readonly paths: Readonly<Record<string, CacheRecord>>;
    readonly checksum: string;
}
export interface GitCheckpointCapture {
    readonly manifest: RestorePointManifestV2;
    readonly cache: GitCache;
}
/** Create a complete Git-native turn checkpoint without writing the real index. */
export declare function captureGitTurnCheckpoint(options: {
    readonly cwd: string;
    readonly id: string;
    readonly sessionId: string;
    readonly turn: number;
    readonly turnStartSeq: number;
    readonly config: ResolvedChangeLedgerConfig;
    readonly signal?: AbortSignal;
}): Promise<GitCheckpointCapture>;
/** Publish a prepared checkpoint under its exact private ref. */
export declare function publishGitCheckpoint(manifest: RestorePointManifestV2, storageDir: string, signal?: AbortSignal): Promise<void>;
/** Verify persisted Git metadata before exposing or restoring a v2 point. */
export declare function verifyGitCheckpoint(manifest: RestorePointManifestV2, signal?: AbortSignal): Promise<void>;
/** Compare-and-swap delete a v2 private ref. */
export declare function deleteGitCheckpoint(manifest: RestorePointManifestV2, storageDir: string, signal?: AbortSignal): Promise<void>;
/** Delete an exact private ref target, including during startup journal reconciliation. */
export declare function deleteGitCheckpointRef(workspace: string, ref: string, commit: string, storageDir: string, signal?: AbortSignal): Promise<void>;
/** Read one v2 Git blob for selective restore. */
export declare function readGitBlob(workspace: string, oid: string, expectedSize: number, signal?: AbortSignal): Promise<Buffer>;
export {};
