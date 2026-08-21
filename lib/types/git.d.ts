import type { RepositoryState } from './types.js';
/** Repository discovery result plus the eligible path inventory. */
export interface RepositorySnapshotSource {
    readonly state: RepositoryState;
    readonly paths: readonly string[];
}
/** Durable identity and shared lock location for one concrete Git worktree. */
export interface GitWorktreeIdentity {
    readonly root: string;
    readonly gitDir: string;
    readonly commonDir: string;
    readonly worktreeId: string;
    readonly lockPath: string;
}
/** Discover the Git worktree owning `cwd` and enumerate tracked/non-ignored paths. */
export declare function discoverRepository(cwd: string, signal?: AbortSignal): Promise<RepositorySnapshotSource>;
/** Resolve the canonical Git worktree root owning `cwd` without inventorying its files. */
export declare function discoverRepositoryRoot(cwd: string, signal?: AbortSignal): Promise<string>;
/** Create or read the per-worktree identity used by refs and cross-store locking. */
export declare function ensureGitWorktreeIdentity(cwd: string, signal?: AbortSignal): Promise<GitWorktreeIdentity>;
/** Resolve a moved linked worktree from its common directory and durable identity. */
export declare function resolveGitWorktreeRoot(commonDir: string, worktreeId: string, fallback: string, signal?: AbortSignal): Promise<string>;
/** Return true when two repository fences refer to the same checkout state. */
export declare function sameRepositoryFence(left: RepositoryState, right: RepositoryState): boolean;
/** Run Git with stable non-interactive defaults and return UTF-8 output. */
export declare function runGit(cwd: string, args: readonly string[], signal?: AbortSignal, options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly maxBuffer?: number;
}): Promise<string>;
/** Run Git and return undefined for its ordinary "not found" exit status. */
export declare function runGitOptional(cwd: string, args: readonly string[], signal?: AbortSignal, options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly maxBuffer?: number;
}): Promise<string | undefined>;
/** Run Git with binary stdin and return UTF-8 stdout. */
export declare function runGitInput(cwd: string, args: readonly string[], input: Buffer | string, signal?: AbortSignal, options?: {
    readonly env?: NodeJS.ProcessEnv;
}): Promise<string>;
/** Run Git and return raw stdout bytes. */
export declare function runGitBuffer(cwd: string, args: readonly string[], signal?: AbortSignal, options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly maxBuffer?: number;
}): Promise<Buffer>;
/** Return the Git metadata directory for diagnostics. */
export declare function gitMetadataParent(state: RepositoryState): string;
