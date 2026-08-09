import type { RepositoryState } from './types.js';
/** Repository discovery result plus the eligible path inventory. */
export interface RepositorySnapshotSource {
    readonly state: RepositoryState;
    readonly paths: readonly string[];
}
/** Discover the Git worktree owning `cwd` and enumerate tracked/non-ignored paths. */
export declare function discoverRepository(cwd: string, signal?: AbortSignal): Promise<RepositorySnapshotSource>;
/** Resolve the canonical Git worktree root owning `cwd` without inventorying its files. */
export declare function discoverRepositoryRoot(cwd: string, signal?: AbortSignal): Promise<string>;
/** Return true when two repository fences refer to the same checkout state. */
export declare function sameRepositoryFence(left: RepositoryState, right: RepositoryState): boolean;
/** Return the Git metadata directory for diagnostics. */
export declare function gitMetadataParent(state: RepositoryState): string;
