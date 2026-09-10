import type { BigIntStats } from 'node:fs';
import type { SnapshotEntry } from './types.js';
/**
 * One observed path, keyed by the filesystem identity that proves it is unchanged.
 *
 * `ctimeNs` changes on every write even when size and mtime are restored, so a
 * matching key means the stored content is still exactly what the path holds.
 */
export interface PathCacheEntry {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
    readonly mode: number;
    readonly entry: SnapshotEntry;
}
/** Stable identity string for one observed filesystem object. */
export declare function pathCacheKey(info: BigIntStats): string;
/** Remember what one unknown does not already describe. */
export declare function toPathCacheEntry(info: BigIntStats, entry: SnapshotEntry): PathCacheEntry;
/** Whether a cached record still describes the object the filesystem reports now. */
export declare function matchesPathCache(record: PathCacheEntry, info: BigIntStats): boolean;
/**
 * Read the per-workspace path cache.
 *
 * The cache is a pure optimization: any malformed or unreadable record is
 * discarded instead of trusted, and a discarded cache only costs a cold capture.
 * @param workspaceDir - durable directory of one workspace.
 * @returns the cached records, newest read wins.
 */
export declare function readPathCache(workspaceDir: string): Promise<Map<string, PathCacheEntry>>;
/** Persist the path cache atomically, replacing any previous generation. */
export declare function writePathCache(workspaceDir: string, cache: ReadonlyMap<string, PathCacheEntry>): Promise<void>;
/** Drop the cache when its file is unreadable or was never written. */
export declare function pathCacheExists(workspaceDir: string): Promise<boolean>;
