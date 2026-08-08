import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChangeLedgerError } from './errors.js';
/** Return whether `candidate` is equal to or below `root`. */
export function isWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
/** Validate and normalize one repository-relative path without filesystem access. */
export function validateRelativePath(path) {
    if (path === '' || path.includes('\0')) {
        throw new ChangeLedgerError('INVALID_PATH', 'snapshot paths must be non-empty and contain no NUL bytes');
    }
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
        throw new ChangeLedgerError('INVALID_PATH', `path escapes the workspace: ${JSON.stringify(path)}`);
    }
    if (sep === '\\' && path.includes('\\')) {
        throw new ChangeLedgerError('INVALID_PATH', `Git paths must use forward slashes: ${JSON.stringify(path)}`);
    }
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new ChangeLedgerError('INVALID_PATH', `path is not canonical: ${JSON.stringify(path)}`);
    }
    return path;
}
/** Resolve a validated relative path below `root`. */
export function resolveWorkspacePath(root, path) {
    const normalized = validateRelativePath(path);
    const target = resolve(root, ...normalized.split('/'));
    if (!isWithin(root, target)) {
        throw new ChangeLedgerError('INVALID_PATH', `path escapes the workspace: ${JSON.stringify(path)}`);
    }
    return target;
}
/** Expand a leading `~/` against the provided home directory. */
export function expandHome(path, home) {
    if (path === '~')
        return home;
    if (path.startsWith(`~${sep}`) || path.startsWith('~/'))
        return join(home, path.slice(2));
    return path;
}
/** Canonicalize an existing directory and reject non-directories. */
export async function canonicalDirectory(path) {
    let canonical;
    try {
        canonical = await realpath(path);
    }
    catch (error) {
        throw new ChangeLedgerError('WORKSPACE_NOT_FOUND', `cannot resolve directory ${JSON.stringify(path)}`, { cause: error });
    }
    const info = await stat(canonical);
    if (!info.isDirectory()) {
        throw new ChangeLedgerError('WORKSPACE_NOT_DIRECTORY', `${JSON.stringify(path)} is not a directory`);
    }
    return canonical;
}
/** Atomically replace one JSON file with owner-only permissions. */
export async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    const body = `${JSON.stringify(value, null, 2)}\n`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(body, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await renameReplacing(temporary, path);
        await syncDirectory(dirname(path));
    }
    finally {
        await rm(temporary, { force: true });
    }
}
/** Read and parse one JSON file. */
export async function readJson(path) {
    let body;
    try {
        body = await readFile(path, 'utf8');
    }
    catch (error) {
        throw new ChangeLedgerError('STATE_READ_FAILED', `cannot read ${JSON.stringify(path)}`, { cause: error });
    }
    try {
        return JSON.parse(body);
    }
    catch (error) {
        throw new ChangeLedgerError('STATE_CORRUPT', `invalid JSON in ${JSON.stringify(path)}`, { cause: error });
    }
}
/** Return whether a filesystem path exists without following its final symlink. */
export async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return false;
        throw error;
    }
}
/** Ensure every existing parent below `root` is a real directory, never a symlink. */
export async function ensureSafeParents(root, target) {
    if (!isWithin(root, target) || target === root) {
        throw new ChangeLedgerError('UNSAFE_TARGET', `restore target is outside the workspace: ${JSON.stringify(target)}`);
    }
    const rel = relative(root, dirname(target));
    let current = root;
    if (rel === '')
        return;
    for (const segment of rel.split(sep)) {
        current = join(current, segment);
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink()) {
                throw new ChangeLedgerError('SYMLINK_PARENT', `restore path traverses symlink parent ${JSON.stringify(current)}`);
            }
            if (!info.isDirectory()) {
                throw new ChangeLedgerError('PARENT_NOT_DIRECTORY', `restore parent is not a directory: ${JSON.stringify(current)}`);
            }
        }
        catch (error) {
            if (!isNodeError(error, 'ENOENT'))
                throw error;
            await mkdir(current, { mode: 0o755 });
        }
    }
}
/** Replace a path with a regular file using a sibling temporary file. */
export async function replaceRegularFile(path, content, mode) {
    const temporary = join(dirname(path), `.${randomUUID()}.change-ledger.tmp`);
    try {
        const handle = await open(temporary, 'wx', mode & 0o777);
        try {
            await handle.writeFile(content);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await chmod(temporary, mode & 0o777);
        await renameReplacing(temporary, path);
        await syncDirectory(dirname(path));
    }
    finally {
        await rm(temporary, { force: true });
    }
}
/** Replace a path with a symbolic link using a sibling temporary name. */
export async function replaceSymbolicLink(path, target) {
    const temporary = join(dirname(path), `.${randomUUID()}.change-ledger.tmp`);
    try {
        await symlink(target, temporary);
        await renameReplacing(temporary, path);
        await syncDirectory(dirname(path));
    }
    finally {
        await rm(temporary, { force: true });
    }
}
/** Remove one file/symlink or one empty directory, never a non-empty tree. */
export async function removeRestoreTarget(path) {
    let info;
    try {
        info = await lstat(path);
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return;
        throw error;
    }
    if (info.isDirectory() && !info.isSymbolicLink()) {
        try {
            await rmdir(path);
        }
        catch (error) {
            if (isNodeError(error, 'ENOTEMPTY') || isNodeError(error, 'EEXIST')) {
                throw new ChangeLedgerError('DIRECTORY_NOT_EMPTY', `refusing to remove non-empty directory ${JSON.stringify(path)}`);
            }
            throw error;
        }
        return;
    }
    await unlink(path);
}
/** Best-effort removal of empty parent directories up to but excluding `root`. */
export async function pruneEmptyParents(root, start) {
    let current = dirname(start);
    while (current !== root && isWithin(root, current)) {
        try {
            await rmdir(current);
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT')) {
                current = dirname(current);
                continue;
            }
            if (isNodeError(error, 'ENOTEMPTY') || isNodeError(error, 'EEXIST'))
                return;
            throw error;
        }
        current = dirname(current);
    }
}
/** Test whether a process id currently exists. */
export function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return isNodeError(error, 'EPERM');
    }
}
/** Type guard for Node.js errors with a selected `code`. */
export function isNodeError(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
async function renameReplacing(source, destination) {
    try {
        await rename(source, destination);
        return;
    }
    catch (error) {
        if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'EPERM') && !isNodeError(error, 'ENOTEMPTY')) {
            throw error;
        }
    }
    await removeRestoreTarget(destination);
    await rename(source, destination);
}
/** Create one owner-only file exclusively and return its handle. */
export async function openExclusive(path) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return open(path, 'wx', 0o600);
}
/** Flush directory-entry changes where the platform supports directory fsync. */
export async function syncDirectory(path) {
    let handle;
    try {
        handle = await open(path, 'r');
        await handle.sync();
    }
    catch (error) {
        if (isNodeError(error, 'EINVAL')
            || isNodeError(error, 'ENOTSUP')
            || isNodeError(error, 'EISDIR')
            || isNodeError(error, 'EPERM')
            || isNodeError(error, 'EACCES'))
            return;
        throw error;
    }
    finally {
        await handle?.close();
    }
}
//# sourceMappingURL=path-utils.js.map