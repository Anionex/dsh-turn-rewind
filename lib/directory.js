import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ignore, {} from 'ignore';
import { ChangeLedgerError } from './errors.js';
import { canonicalDirectory, isNodeError, isWithin } from './path-utils.js';
const IGNORE_FILE = '.dsh-rewindignore';
const MAX_RECORDED_SKIPS = 50;
const DEFAULT_IGNORE_PATTERNS = ['.git', 'node_modules'];
/** Resolve the canonical ordinary directory used as a non-Git workspace root. */
export async function discoverDirectoryRoot(cwd) {
    return canonicalDirectory(cwd);
}
/** Enumerate regular files and symlinks in an ordinary directory using rewind ignore rules. */
export async function discoverDirectory(cwd, config, signal) {
    const root = await discoverDirectoryRoot(cwd);
    const matcher = await loadIgnoreMatcher(root, config.maxFileBytes, signal);
    const walk = { paths: [], skipped: [], skippedCount: 0 };
    await walkDirectory(root, root, '', matcher, walk, config.maxFiles, signal);
    walk.paths.sort(comparePaths);
    return {
        state: { type: 'directory', root },
        paths: walk.paths,
        skipped: walk.skipped,
        skippedCount: walk.skippedCount,
        ...(walk.truncated === undefined ? {} : { truncated: walk.truncated }),
    };
}
/**
 * Read `.dsh-rewindignore` when present and combine it with the built-in
 * exclusions. The built-in patterns are added last so user negation rules can
 * never re-include the plugin's own metadata or dependency trees.
 */
async function loadIgnoreMatcher(root, maxFileBytes, signal) {
    const matcher = ignore();
    const ignorePath = join(root, IGNORE_FILE);
    throwIfAborted(signal);
    let before;
    try {
        before = await lstat(ignorePath, { bigint: true });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            matcher.add(DEFAULT_IGNORE_PATTERNS);
            return matcher;
        }
        throw error;
    }
    if (!before.isFile()) {
        throw new ChangeLedgerError('IGNORE_FILE_INVALID', `${IGNORE_FILE} must be a regular file when present`);
    }
    if (before.size > BigInt(maxFileBytes)) {
        throw new ChangeLedgerError('FILE_TOO_LARGE', `${JSON.stringify(IGNORE_FILE)} is ${before.size.toString()} bytes; configured per-file maximum is ${maxFileBytes}`);
    }
    const content = await readFile(ignorePath, 'utf8');
    let after;
    try {
        after = await lstat(ignorePath, { bigint: true });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `${IGNORE_FILE} disappeared while its rules were being read`);
        }
        throw error;
    }
    if (!sameStat(before, after)) {
        throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `${IGNORE_FILE} changed while its rules were being read`);
    }
    try {
        matcher.add(content);
    }
    catch (error) {
        throw new ChangeLedgerError('IGNORE_FILE_INVALID', `${IGNORE_FILE} contains invalid ignore rules`, { cause: error });
    }
    matcher.add(DEFAULT_IGNORE_PATTERNS);
    return matcher;
}
/** Walk one ordinary directory without following symlinks, rejecting unstable trees. */
async function walkDirectory(root, directory, directoryPath, matcher, walk, maxFiles, signal) {
    throwIfAborted(signal);
    const before = await lstat(directory, { bigint: true });
    await assertSafeDirectory(root, directory, before);
    const entries = await readdir(directory, { withFileTypes: true });
    const after = await lstat(directory, { bigint: true });
    if (!sameStat(before, after)) {
        throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `directory changed while being enumerated: ${JSON.stringify(directoryPath || '.')}`);
    }
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
        if (walk.truncated !== undefined)
            return;
        throwIfAborted(signal);
        await assertSafeDirectory(root, directory, after);
        const path = directoryPath === '' ? entry.name : `${directoryPath}/${entry.name}`;
        const target = join(directory, entry.name);
        let info;
        try {
            info = await lstat(target, { bigint: true });
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                continue;
            throw error;
        }
        if (info.isDirectory() && !info.isSymbolicLink()) {
            if (matcher.ignores(`${path}/`))
                continue;
            await walkDirectory(root, target, path, matcher, walk, maxFiles, signal);
            continue;
        }
        if (path !== IGNORE_FILE && matcher.ignores(path))
            continue;
        if (!info.isFile() && !info.isSymbolicLink()) {
            recordSkip(walk, path, 'unsupported-file-type');
            continue;
        }
        if (walk.paths.length >= maxFiles) {
            walk.truncated = 'file-limit';
            return;
        }
        walk.paths.push(path);
    }
}
/** Record one skipped path, bounding the durable list while counting every entry. */
function recordSkip(walk, path, reason) {
    walk.skippedCount += 1;
    if (walk.skipped.length < MAX_RECORDED_SKIPS)
        walk.skipped.push({ path, reason });
}
/**
 * Re-prove that one traversed directory is still the same real directory inside
 * the workspace root, so a swapped symlink or moved ancestor cannot redirect
 * the inventory outside it.
 */
async function assertSafeDirectory(root, directory, expected) {
    if (!expected.isDirectory() || expected.isSymbolicLink()) {
        throw new ChangeLedgerError('SYMLINK_PARENT', `directory traversal reached a symbolic link: ${JSON.stringify(directory)}`);
    }
    let canonical;
    try {
        canonical = await realpath(directory);
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ELOOP')) {
            throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `directory changed during traversal: ${JSON.stringify(directory)}`);
        }
        throw error;
    }
    if (canonical !== resolve(directory) || !isWithin(root, canonical)) {
        throw new ChangeLedgerError('UNSAFE_TARGET', `directory traversal escaped the workspace: ${JSON.stringify(directory)}`);
    }
    let current;
    try {
        current = await lstat(directory, { bigint: true });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `directory disappeared during traversal: ${JSON.stringify(directory)}`);
        }
        throw error;
    }
    if (!sameStat(expected, current)) {
        throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `directory changed during traversal: ${JSON.stringify(directory)}`);
    }
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
