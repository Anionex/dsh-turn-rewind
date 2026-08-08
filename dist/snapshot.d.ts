import { type RepositorySnapshotSource } from './git.js';
import type { LedgerStore } from './store.js';
import type { ResolvedChangeLedgerConfig, SnapshotEntry, WorkspaceChange } from './types.js';
/** One captured tree, optionally persisted into the blob store. */
export interface CapturedTree {
    readonly source: RepositorySnapshotSource;
    readonly entries: Readonly<Record<string, SnapshotEntry>>;
    readonly treeHash: string;
    readonly fileCount: number;
    readonly totalBytes: number;
}
/** Capture the current tracked and non-ignored Git working tree. */
export declare function captureTree(options: {
    readonly cwd: string;
    readonly config: ResolvedChangeLedgerConfig;
    readonly store?: LedgerStore;
    readonly signal?: AbortSignal;
}): Promise<CapturedTree>;
/**
 * Capture the complete tree twice and accept it only when both path/content and
 * repository fences agree. This prevents a point from silently mixing files
 * observed at incompatible moments while another process is editing the tree.
 */
export declare function captureStableTree(options: {
    readonly cwd: string;
    readonly config: ResolvedChangeLedgerConfig;
    readonly store?: LedgerStore;
    readonly signal?: AbortSignal;
}): Promise<CapturedTree>;
/** Compute stable path-level differences between two captured trees. */
export declare function diffTrees(before: Readonly<Record<string, SnapshotEntry>>, after: Readonly<Record<string, SnapshotEntry>>): WorkspaceChange[];
/** Return whether two snapshot entries are byte/type/mode equivalent. */
export declare function entriesEqual(left: SnapshotEntry | undefined, right: SnapshotEntry | undefined): boolean;
/** Hash a complete path map into a deterministic tree identity. */
export declare function hashTree(entries: Readonly<Record<string, SnapshotEntry>>): string;
//# sourceMappingURL=snapshot.d.ts.map