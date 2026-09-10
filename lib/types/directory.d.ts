import type { CaptureSkip, CaptureTruncation, DirectoryWorkspaceState, ResolvedChangeLedgerConfig } from './types.js';
/** Ordinary-directory discovery result plus its eligible path inventory. */
export interface DirectorySnapshotSource {
    readonly state: DirectoryWorkspaceState;
    readonly paths: readonly string[];
    /** Eligible paths that cannot be stored at all, such as sockets. */
    readonly skipped: readonly CaptureSkip[];
    readonly skippedCount: number;
    /** Set when the file-count limit stopped the walk early. */
    readonly truncated?: CaptureTruncation;
}
/** Resolve the canonical ordinary directory used as a non-Git workspace root. */
export declare function discoverDirectoryRoot(cwd: string): Promise<string>;
/** Enumerate regular files and symlinks in an ordinary directory using rewind ignore rules. */
export declare function discoverDirectory(cwd: string, config: Pick<ResolvedChangeLedgerConfig, 'maxFiles' | 'maxFileBytes'>, signal?: AbortSignal): Promise<DirectorySnapshotSource>;
