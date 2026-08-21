import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { ChangeLedgerError } from './errors.js';
import { discoverRepository, sameRepositoryFence } from './git.js';
import { isNodeError, resolveWorkspacePath } from './path-utils.js';
const COMPARISON_READ_BUDGET_BYTES = 128 * 1024 * 1024;
/** Capture the current tracked and non-ignored Git working tree. */
export async function captureTree(options) {
    throwIfAborted(options.signal);
    const source = await discoverRepository(options.cwd, options.signal);
    if (source.paths.length > options.config.maxFiles) {
        throw new ChangeLedgerError('TOO_MANY_FILES', `workspace has ${source.paths.length} eligible paths; configured maximum is ${options.config.maxFiles}`);
    }
    const entries = Object.create(null);
    const gitObjectFormat = options.gitObjectFormat;
    const gitCapture = gitObjectFormat === undefined
        ? undefined
        : {
            objectFormat: gitObjectFormat,
            entries: Object.create(null),
        };
    let totalBytes = 0;
    const capturePath = async (path) => {
        throwIfAborted(options.signal);
        const entry = await captureEntry(source.state.root, path, options.config.maxFileBytes, options.signal);
        if (entry === undefined)
            return;
        if (entry.kind === 'file') {
            totalBytes += entry.content.length;
            if (totalBytes > options.config.maxSnapshotBytes) {
                throw new ChangeLedgerError('SNAPSHOT_TOO_LARGE', `eligible files exceed configured aggregate limit of ${options.config.maxSnapshotBytes} bytes`);
            }
            if (options.store !== undefined) {
                await options.store.putBlob(source.state.root, entry.snapshot.blob, entry.content);
            }
            entries[path] = entry.snapshot;
            if (gitCapture !== undefined) {
                gitCapture.entries[path] = gitFileSnapshot(entry.snapshot, entry.content, gitCapture.objectFormat);
            }
            return;
        }
        entries[path] = entry.snapshot;
        if (gitCapture !== undefined)
            gitCapture.entries[path] = entry.snapshot;
    };
    if (gitCapture === undefined) {
        for (const path of source.paths)
            await capturePath(path);
    }
    else {
        let next = 0;
        let failed = false;
        let firstError = new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'parallel comparison capture failed');
        const concurrency = Math.min(32, source.paths.length, Math.max(1, Math.floor(COMPARISON_READ_BUDGET_BYTES / options.config.maxFileBytes)));
        const workers = Array.from({ length: concurrency }, async () => {
            while (!failed && next < source.paths.length) {
                const index = next;
                next += 1;
                const path = source.paths[index];
                if (path === undefined)
                    continue;
                try {
                    await capturePath(path);
                }
                catch (error) {
                    if (!failed) {
                        failed = true;
                        firstError = error;
                    }
                }
            }
        });
        await Promise.all(workers);
        if (failed)
            throw firstError;
    }
    return {
        source,
        entries,
        ...(gitCapture === undefined ? {} : { gitEntries: gitCapture.entries }),
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
            ...(options.gitObjectFormat === undefined ? {} : { gitObjectFormat: options.gitObjectFormat }),
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
export function diffTrees(before, after, comparisonBefore = before, comparisonAfter = after) {
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(comparePaths);
    const changes = [];
    for (const path of paths) {
        const left = before[path];
        const right = after[path];
        const comparisonLeft = comparisonBefore[path];
        const comparisonRight = comparisonAfter[path];
        if (left === undefined && right !== undefined) {
            changes.push({ path, kind: 'added', after: right });
            continue;
        }
        if (left !== undefined && right === undefined) {
            changes.push({ path, kind: 'deleted', before: left });
            continue;
        }
        if (left === undefined || right === undefined || entriesEqual(comparisonLeft, comparisonRight))
            continue;
        if (left.kind !== right.kind) {
            changes.push({ path, kind: 'type-changed', before: left, after: right });
            continue;
        }
        if (left.kind === 'file'
            && right.kind === 'file'
            && comparisonLeft?.kind === 'file'
            && comparisonRight?.kind === 'file'
            && comparisonLeft.blob === comparisonRight.blob
            && left.mode !== right.mode) {
            changes.push({ path, kind: 'mode-changed', before: left, after: right });
            continue;
        }
        if (left.kind === 'symlink'
            && right.kind === 'symlink'
            && comparisonLeft?.kind === 'symlink'
            && comparisonRight?.kind === 'symlink'
            && comparisonLeft.target === comparisonRight.target
            && left.mode !== right.mode) {
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
/** Byte-verify one workspace-relative path without following a final symlink. */
export async function captureSnapshotEntry(root, path, maxFileBytes, signal, gitObjectFormat) {
    const entry = await captureEntry(root, path, maxFileBytes, signal);
    if (entry === undefined || entry.kind === 'symlink' || gitObjectFormat === undefined)
        return entry?.snapshot;
    return gitFileSnapshot(entry.snapshot, entry.content, gitObjectFormat);
}
function gitFileSnapshot(snapshot, content, objectFormat) {
    const header = Buffer.from(`blob ${String(content.length)}\0`);
    const blob = createHash(objectFormat).update(header).update(content).digest('hex');
    return { ...snapshot, blob, provider: 'git' };
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
        let handle;
        try {
            handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if (isNodeError(error, 'ELOOP'))
                continue;
            throw error;
        }
        let content;
        try {
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile() || !sameStat(before, opened))
                continue;
            content = await readBoundedFile(handle, Number(opened.size));
            throwIfAborted(signal);
            const after = await handle.stat({ bigint: true });
            if (!sameStat(opened, after) || BigInt(content.length) !== after.size)
                continue;
        }
        finally {
            await handle.close();
        }
        const blob = createHash('sha256').update(content).digest('hex');
        return {
            kind: 'file',
            snapshot: { kind: 'file', blob, size: content.length, mode },
            content,
        };
    }
    throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `path changed repeatedly while being captured: ${JSON.stringify(path)}`);
}
async function readBoundedFile(handle, expectedSize) {
    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0)
            break;
        offset += bytesRead;
    }
    return buffer.subarray(0, offset);
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
