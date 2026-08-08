/** Return whether `candidate` is equal to or below `root`. */
export declare function isWithin(root: string, candidate: string): boolean;
/** Validate and normalize one repository-relative path without filesystem access. */
export declare function validateRelativePath(path: string): string;
/** Resolve a validated relative path below `root`. */
export declare function resolveWorkspacePath(root: string, path: string): string;
/** Expand a leading `~/` against the provided home directory. */
export declare function expandHome(path: string, home: string): string;
/** Canonicalize an existing directory and reject non-directories. */
export declare function canonicalDirectory(path: string): Promise<string>;
/** Atomically replace one JSON file with owner-only permissions. */
export declare function writeJsonAtomic(path: string, value: unknown): Promise<void>;
/** Read and parse one JSON file. */
export declare function readJson(path: string): Promise<unknown>;
/** Return whether a filesystem path exists without following its final symlink. */
export declare function pathExists(path: string): Promise<boolean>;
/** Ensure every existing parent below `root` is a real directory, never a symlink. */
export declare function ensureSafeParents(root: string, target: string): Promise<void>;
/** Replace a path with a regular file using a sibling temporary file. */
export declare function replaceRegularFile(path: string, content: Buffer, mode: number): Promise<void>;
/** Replace a path with a symbolic link using a sibling temporary name. */
export declare function replaceSymbolicLink(path: string, target: string): Promise<void>;
/** Remove one file/symlink or one empty directory, never a non-empty tree. */
export declare function removeRestoreTarget(path: string): Promise<void>;
/** Best-effort removal of empty parent directories up to but excluding `root`. */
export declare function pruneEmptyParents(root: string, start: string): Promise<void>;
/** Test whether a process id currently exists. */
export declare function processExists(pid: number): boolean;
/** Type guard for Node.js errors with a selected `code`. */
export declare function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException;
/** Create one owner-only file exclusively and return its handle. */
export declare function openExclusive(path: string): Promise<import("fs/promises").FileHandle>;
/** Flush directory-entry changes where the platform supports directory fsync. */
export declare function syncDirectory(path: string): Promise<void>;
//# sourceMappingURL=path-utils.d.ts.map