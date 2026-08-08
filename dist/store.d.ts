import type { ResolvedChangeLedgerConfig, RestoreOperation, RestorePointManifest } from './types.js';
/** Durable content-addressed storage and per-workspace locking. */
export declare class LedgerStore {
    readonly config: ResolvedChangeLedgerConfig;
    constructor(config: ResolvedChangeLedgerConfig);
    /** Create the state root and reconcile crash-interrupted operations. */
    initialize(): Promise<number>;
    /** Acquire the exclusive lock for one canonical workspace. */
    acquire(workspace: string): Promise<() => Promise<void>>;
    /** Persist a blob if it is not already present, and verify existing content. */
    putBlob(workspace: string, hash: string, content: Buffer): Promise<void>;
    /** Read and verify one content-addressed blob. */
    readBlob(workspace: string, hash: string): Promise<Buffer>;
    /** Write one restore-point manifest atomically. */
    writeManifest(manifest: RestorePointManifest): Promise<void>;
    /** Load and validate one restore-point manifest. */
    readManifest(workspace: string, id: string): Promise<RestorePointManifest>;
    /** List all validated restore points for one workspace, newest first. */
    listManifests(workspace: string): Promise<RestorePointManifest[]>;
    /** Delete one restore-point manifest. Blobs remain until garbage collection succeeds. */
    deleteManifest(workspace: string, id: string): Promise<void>;
    /** Persist one restore-operation journal. */
    writeOperation(operation: RestoreOperation): Promise<void>;
    /** List validated restore operations for one workspace. */
    listOperations(workspace: string): Promise<RestoreOperation[]>;
    /** Return whether an incomplete operation still references a restore point. */
    isReferencedByRecovery(workspace: string, restorePointId: string): Promise<boolean>;
    /** Delete blobs not referenced by any remaining manifest. */
    collectGarbage(workspace: string, additionalReferenced?: Iterable<string>): Promise<{
        deletedBlobs: number;
        retainedBlobs: number;
    }>;
    private workspaceDir;
    private manifestPath;
    private operationPath;
    private blobPath;
    private reclaimStaleLock;
    private workspaceAppearsActive;
}
//# sourceMappingURL=store.d.ts.map