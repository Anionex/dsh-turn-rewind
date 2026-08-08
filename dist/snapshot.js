import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { ChangeLedgerError } from './errors.js';
import { discoverRepository, sameRepositoryFence } from './git.js';
import { isNodeError, resolveWorkspacePath } from './path-utils.js';
/** Capture the current tracked and non-ignored Git working tree. */
export async function captureTree(options) {
    throwIfAborted(options.signal);
    const source = await discoverRepository(options.cwd, options.signal);
    if (source.paths.length > options.config.maxFiles) {
        throw new ChangeLedgerError('TOO_MANY_FILES', `workspace has ${source.paths.length} eligible paths; configured maximum is ${options.config.maxFiles}`);
    }
    const entries = Object.create(null);
    let totalBytes = 0;
    for (const path of source.paths) {
        throwIfAborted(options.signal);
        const entry = await captureEntry(source.state.root, path, options.config.maxFileBytes, options.signal);
        if (entry === undefined)
            continue;
        if (entry.kind === 'file') {
            totalBytes += entry.content.length;
            if (totalBytes > options.config.maxSnapshotBytes) {
                throw new ChangeLedgerError('SNAPSHOT_TOO_LARGE', `eligible files exceed configured aggregate limit of ${options.config.maxSnapshotBytes} bytes`);
            }
            if (options.store !== undefined) {
                await options.store.putBlob(source.state.root, entry.snapshot.blob, entry.content);
            }
            entries[path] = entry.snapshot;
            continue;
        }
        entries[path] = entry.snapshot;
    }
    return {
        source,
        entries,
        treeHash: hashTree(entries),
        fileCount: Object.keys(entries).length,
        totalBytes,
    };
}
/**
 * Capture the complete tree twice and accept it only when both path/content and
 * repository fences agree. This prevents a point from silently mixing files
 * observed at incompatible moments while another process is editing the tree.
 */
export async function captureStableTree(options) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const first = await captureTree({
            cwd: options.cwd,
            config: options.config,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const second = await captureTree(options);
        if (first.treeHash === second.treeHash
            && sameRepositoryFence(first.source.state, second.source.state)
            && arraysEqual(first.source.state.stagedPaths, second.source.state.stagedPaths)
            && arraysEqual(first.source.paths, second.source.paths)) {
            return second;
        }
    }
    throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'workspace did not remain stable across repeated full-tree captures');
}
/** Compute stable path-level differences between two captured trees. */
export function diffTrees(before, after) {
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(comparePaths);
    const changes = [];
    for (const path of paths) {
        const left = before[path];
        const right = after[path];
        if (left === undefined && right !== undefined) {
            changes.push({ path, kind: 'added', after: right });
            continue;
        }
        if (left !== undefined && right === undefined) {
            changes.push({ path, kind: 'deleted', before: left });
            continue;
        }
        if (left === undefined || right === undefined || entriesEqual(left, right))
            continue;
        if (left.kind !== right.kind) {
            changes.push({ path, kind: 'type-changed', before: left, after: right });
            continue;
        }
        if (left.kind === 'file' && right.kind === 'file' && left.blob === right.blob && left.mode !== right.mode) {
            changes.push({ path, kind: 'mode-changed', before: left, after: right });
            continue;
        }
        if (left.kind === 'symlink' && right.kind === 'symlink' && left.target === right.target && left.mode !== right.mode) {
            changes.push({ path, kind: 'mode-changed', before: left, after: right });
            continue;
        }
        changes.push({ path, kind: 'modified', before: left, after: right });
    }
    return changes;
}
/** Return whether two snapshot entries are byte/type/mode equivalent. */
export function entriesEqual(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    if (left.kind !== right.kind || left.mode !== right.mode)
        return false;
    if (left.kind === 'file' && right.kind === 'file') {
        return left.blob === right.blob && left.size === right.size;
    }
    return left.kind === 'symlink' && right.kind === 'symlink' && left.target === right.target;
}
/** Hash a complete path map into a deterministic tree identity. */
export function hashTree(entries) {
    const hash = createHash('sha256');
    for (const path of Object.keys(entries).sort(comparePaths)) {
        const entry = entries[path];
        if (entry === undefined)
            continue;
        hash.update(path);
        hash.update('\0');
        if (entry.kind === 'file') {
            hash.update(`file\0${entry.blob}\0${entry.size}\0${entry.mode}\0`);
        }
        else {
            hash.update(`symlink\0${entry.target}\0${entry.mode}\0`);
        }
    }
    return hash.digest('hex');
}
async function captureEntry(root, path, maxFileBytes, signal) {
    const target = resolveWorkspacePath(root, path);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        throwIfAborted(signal);
        let before;
        try {
            before = await lstat(target, { bigint: true });
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                return undefined;
            throw error;
        }
        const mode = Number(before.mode & 511n);
        if (before.isSymbolicLink()) {
            const linkTarget = await readlink(target);
            const after = await lstat(target, { bigint: true });
            if (!sameStat(before, after))
                continue;
            return { kind: 'symlink', snapshot: { kind: 'symlink', target: linkTarget, mode } };
        }
        if (!before.isFile()) {
            throw new ChangeLedgerError('UNSUPPORTED_FILE_TYPE', `eligible path is not a regular file or symlink: ${JSON.stringify(path)}`);
        }
        if (before.size > BigInt(maxFileBytes)) {
            throw new ChangeLedgerError('FILE_TOO_LARGE', `${JSON.stringify(path)} is ${before.size.toString()} bytes; configured per-file maximum is ${maxFileBytes}`);
        }
        const content = await readFile(target);
        throwIfAborted(signal);
        const after = await lstat(target, { bigint: true });
        if (!sameStat(before, after) || BigInt(content.length) !== after.size)
            continue;
        const blob = createHash('sha256').update(content).digest('hex');
        return {
            kind: 'file',
            snapshot: { kind: 'file', blob, size: content.length, mode },
            content,
        };
    }
    throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `path changed repeatedly while being captured: ${JSON.stringify(path)}`);
}
function sameStat(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function throwIfAborted(signal) {
    if (signal?.aborted === true)
        throw signal.reason;
}
function comparePaths(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
//# sourceMappingURL=snapshot.js.map