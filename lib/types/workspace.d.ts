import { type DirectorySnapshotSource } from './directory.js';
import { type RepositorySnapshotSource } from './git.js';
import type { ResolvedChangeLedgerConfig, WorkspaceState } from './types.js';
/** Eligible snapshot source for either supported workspace mode. */
export type WorkspaceSnapshotSource = RepositorySnapshotSource | DirectorySnapshotSource;
/**
 * Discover the owning Git worktree, or treat `cwd` itself as an ordinary
 * directory when it is not inside any repository.
 * @param cwd - working directory the Session runs in.
 * @param config - capture limits applied to ordinary-directory enumeration.
 * @param signal - optional caller cancellation.
 * @returns the snapshot source for the owning workspace.
 */
export declare function discoverWorkspace(cwd: string, config: Pick<ResolvedChangeLedgerConfig, 'maxFiles' | 'maxFileBytes'>, signal?: AbortSignal): Promise<WorkspaceSnapshotSource>;
/** Workspace mode and root resolved without inventorying any files. */
export interface WorkspaceIdentity {
    readonly type: WorkspaceState['type'];
    readonly root: string;
}
/**
 * Resolve the workspace mode and root without inventorying files, for callers
 * that only need to address the workspace (locks, skip markers, storage purge).
 * @param cwd - working directory the Session runs in.
 * @param signal - optional caller cancellation.
 * @returns the workspace mode and canonical root.
 */
export declare function discoverWorkspaceIdentity(cwd: string, signal?: AbortSignal): Promise<WorkspaceIdentity>;
/** Resolve the workspace root without inventorying its files. */
export declare function discoverWorkspaceRoot(cwd: string, signal?: AbortSignal): Promise<string>;
/**
 * Whether two fences still describe the same workspace.
 *
 * Git workspaces keep the full repository fence (HEAD, branch, operation);
 * ordinary directories only own their canonical root, so a moved or recreated
 * root is the only thing that can invalidate them.
 */
export declare function sameWorkspaceFence(left: WorkspaceState, right: WorkspaceState): boolean;
