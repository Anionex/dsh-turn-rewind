import { discoverDirectory, discoverDirectoryRoot, type DirectorySnapshotSource } from './directory.js'
import {
  discoverRepositoryOptional,
  discoverRepositoryRootOptional,
  sameRepositoryFence,
  type RepositorySnapshotSource,
} from './git.js'
import type { ResolvedChangeLedgerConfig, WorkspaceState } from './types.js'

/** Eligible snapshot source for either supported workspace mode. */
export type WorkspaceSnapshotSource = RepositorySnapshotSource | DirectorySnapshotSource

/**
 * Discover the owning Git worktree, or treat `cwd` itself as an ordinary
 * directory when it is not inside any repository.
 * @param cwd - working directory the Session runs in.
 * @param config - capture limits applied to ordinary-directory enumeration.
 * @param signal - optional caller cancellation.
 * @returns the snapshot source for the owning workspace.
 */
export async function discoverWorkspace(
  cwd: string,
  config: Pick<ResolvedChangeLedgerConfig, 'maxFiles' | 'maxFileBytes'>,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshotSource> {
  const repository = await discoverRepositoryOptional(cwd, signal)
  return repository ?? discoverDirectory(cwd, config, signal)
}

/** Workspace mode and root resolved without inventorying any files. */
export interface WorkspaceIdentity {
  readonly type: WorkspaceState['type']
  readonly root: string
}

/**
 * Resolve the workspace mode and root without inventorying files, for callers
 * that only need to address the workspace (locks, skip markers, storage purge).
 * @param cwd - working directory the Session runs in.
 * @param signal - optional caller cancellation.
 * @returns the workspace mode and canonical root.
 */
export async function discoverWorkspaceIdentity(cwd: string, signal?: AbortSignal): Promise<WorkspaceIdentity> {
  const root = await discoverRepositoryRootOptional(cwd, signal)
  return root === undefined
    ? { type: 'directory', root: await discoverDirectoryRoot(cwd) }
    : { type: 'git', root }
}

/** Resolve the workspace root without inventorying its files. */
export async function discoverWorkspaceRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  return (await discoverWorkspaceIdentity(cwd, signal)).root
}

/**
 * Whether two fences still describe the same workspace.
 *
 * Git workspaces keep the full repository fence (HEAD, branch, operation);
 * ordinary directories only own their canonical root, so a moved or recreated
 * root is the only thing that can invalidate them.
 */
export function sameWorkspaceFence(left: WorkspaceState, right: WorkspaceState): boolean {
  if (left.type !== right.type || left.root !== right.root) return false
  if (left.type === 'directory' || right.type === 'directory') return true
  return sameRepositoryFence(left, right)
}
