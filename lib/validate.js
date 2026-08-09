import { ChangeLedgerError } from './errors.js';
import { isAbsolute } from 'node:path';
import { validateRelativePath } from './path-utils.js';
import { hashTree } from './snapshot.js';
import { LEDGER_FORMAT_VERSION, } from './types.js';
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID_PATTERN = /^(?:rp|op)_[0-9a-z]+_[0-9a-f]{12}$/;
/** Validate a restore-point id before using it in a filesystem path. */
export function validateRestorePointId(value) {
    if (!ID_PATTERN.test(value) || !value.startsWith('rp_')) {
        throw new ChangeLedgerError('INVALID_RESTORE_POINT_ID', `invalid restore-point id ${JSON.stringify(value)}`);
    }
    return value;
}
/** Validate a restore-operation id before using it in a filesystem path. */
export function validateOperationId(value) {
    if (!ID_PATTERN.test(value) || !value.startsWith('op_')) {
        throw new ChangeLedgerError('INVALID_OPERATION_ID', `invalid restore-operation id ${JSON.stringify(value)}`);
    }
    return value;
}
/** Parse an untrusted durable restore-point manifest. */
export function parseManifest(value) {
    const record = objectRecord(value, 'restore-point manifest');
    if (record.version !== LEDGER_FORMAT_VERSION)
        corrupt(`unsupported restore-point version ${String(record.version)}`);
    const id = stringField(record, 'id');
    validateRestorePointId(id);
    const kind = record.kind;
    if (kind !== 'user' && kind !== 'rescue' && kind !== 'turn') {
        corrupt('restore-point kind must be "user", "rescue", or "turn"');
    }
    const workspace = absoluteString(record, 'workspace');
    const repository = parseRepository(record.repository);
    if (repository.root !== workspace)
        corrupt('repository.root must equal workspace');
    const entriesRecord = objectRecord(record.entries, 'restore-point entries');
    const entries = Object.create(null);
    let totalBytes = 0;
    for (const [path, entryValue] of Object.entries(entriesRecord)) {
        validateRelativePath(path);
        const entry = parseEntry(entryValue, path);
        entries[path] = entry;
        if (entry.kind === 'file')
            totalBytes += entry.size;
    }
    const fileCount = nonNegativeInteger(record, 'fileCount');
    if (fileCount !== Object.keys(entries).length)
        corrupt('restore-point fileCount does not match entries');
    const storedTotal = nonNegativeInteger(record, 'totalBytes');
    if (storedTotal !== totalBytes)
        corrupt('restore-point totalBytes does not match entries');
    const treeHash = hashField(record, 'treeHash');
    if (treeHash !== hashTree(entries))
        corrupt('restore-point treeHash does not match entries');
    const createdAt = nonNegativeInteger(record, 'createdAt');
    const restoreCount = nonNegativeInteger(record, 'restoreCount');
    const sessionId = optionalString(record, 'sessionId');
    const label = optionalString(record, 'label');
    const parentRestorePoint = optionalString(record, 'parentRestorePoint');
    if (parentRestorePoint !== undefined)
        validateRestorePointId(parentRestorePoint);
    const turn = optionalNonNegativeInteger(record, 'turn');
    const turnStartSeq = optionalNonNegativeInteger(record, 'turnStartSeq');
    const turnEndSeq = optionalNonNegativeInteger(record, 'turnEndSeq');
    if (kind === 'turn') {
        if (sessionId === undefined || turn === undefined || (turnStartSeq === undefined) === (turnEndSeq === undefined)) {
            corrupt('turn restore points require sessionId, turn, and exactly one turn boundary');
        }
    }
    else if (turn !== undefined || turnStartSeq !== undefined || turnEndSeq !== undefined) {
        corrupt('only turn restore points may carry turn metadata');
    }
    const lastRestoredAt = optionalNonNegativeInteger(record, 'lastRestoredAt');
    return {
        version: LEDGER_FORMAT_VERSION,
        id,
        kind,
        workspace,
        repository,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(label === undefined ? {} : { label }),
        ...(parentRestorePoint === undefined ? {} : { parentRestorePoint }),
        ...(turn === undefined ? {} : { turn }),
        ...(turnStartSeq === undefined ? {} : { turnStartSeq }),
        ...(turnEndSeq === undefined ? {} : { turnEndSeq }),
        createdAt,
        treeHash,
        fileCount,
        totalBytes,
        entries,
        restoreCount,
        ...(lastRestoredAt === undefined ? {} : { lastRestoredAt }),
    };
}
/** Parse an untrusted durable restore-operation journal. */
export function parseOperation(value) {
    const record = objectRecord(value, 'restore operation');
    if (record.version !== LEDGER_FORMAT_VERSION)
        corrupt(`unsupported restore-operation version ${String(record.version)}`);
    const id = stringField(record, 'id');
    validateOperationId(id);
    const restorePointId = stringField(record, 'restorePointId');
    const rescuePointId = stringField(record, 'rescuePointId');
    validateRestorePointId(restorePointId);
    validateRestorePointId(rescuePointId);
    const workspace = absoluteString(record, 'workspace');
    const pathsValue = record.paths;
    if (!Array.isArray(pathsValue))
        corrupt('restore-operation paths must be an array');
    const paths = pathsValue.map((path) => validateRelativePath(requireString(path, 'restore-operation path')));
    if (new Set(paths).size !== paths.length)
        corrupt('restore-operation paths contain duplicates');
    const state = record.state;
    if (state !== 'running'
        && state !== 'rollback-running'
        && state !== 'completed'
        && state !== 'rolled-back'
        && state !== 'interrupted'
        && state !== 'recovery-required') {
        corrupt(`invalid restore-operation state ${JSON.stringify(state)}`);
    }
    const sessionId = optionalString(record, 'sessionId');
    const startedAt = nonNegativeInteger(record, 'startedAt');
    const finishedAt = optionalNonNegativeInteger(record, 'finishedAt');
    const error = optionalString(record, 'error');
    const rollbackError = optionalString(record, 'rollbackError');
    return {
        version: LEDGER_FORMAT_VERSION,
        id,
        workspace,
        restorePointId,
        rescuePointId,
        ...(sessionId === undefined ? {} : { sessionId }),
        paths,
        startedAt,
        ...(finishedAt === undefined ? {} : { finishedAt }),
        state,
        ...(error === undefined ? {} : { error }),
        ...(rollbackError === undefined ? {} : { rollbackError }),
    };
}
/** Validate one SHA-256 blob name. */
export function validateBlobHash(value) {
    if (!HASH_PATTERN.test(value)) {
        throw new ChangeLedgerError('STATE_CORRUPT', `invalid blob hash ${JSON.stringify(value)}`);
    }
    return value;
}
function parseRepository(value) {
    const record = objectRecord(value, 'repository state');
    const root = absoluteString(record, 'root');
    const commonDir = absoluteString(record, 'commonDir');
    const head = optionalHash(record, 'head');
    const branch = optionalString(record, 'branch');
    const operation = optionalString(record, 'operation');
    const stagedValue = record.stagedPaths;
    if (!Array.isArray(stagedValue))
        corrupt('repository stagedPaths must be an array');
    const stagedPaths = stagedValue.map((path) => validateRelativePath(requireString(path, 'staged path')));
    return {
        root,
        commonDir,
        ...(head === undefined ? {} : { head }),
        ...(branch === undefined ? {} : { branch }),
        ...(operation === undefined ? {} : { operation }),
        stagedPaths,
    };
}
function parseEntry(value, path) {
    const record = objectRecord(value, `snapshot entry ${JSON.stringify(path)}`);
    const kind = record.kind;
    const mode = nonNegativeInteger(record, 'mode');
    if (mode > 0o777)
        corrupt(`snapshot mode is out of range for ${JSON.stringify(path)}`);
    if (kind === 'file') {
        return {
            kind,
            blob: validateBlobHash(stringField(record, 'blob')),
            size: nonNegativeInteger(record, 'size'),
            mode,
        };
    }
    if (kind === 'symlink') {
        const target = stringField(record, 'target');
        if (target.includes('\0'))
            corrupt(`snapshot symlink target contains a NUL byte for ${JSON.stringify(path)}`);
        return { kind, target, mode };
    }
    corrupt(`invalid snapshot entry kind for ${JSON.stringify(path)}`);
}
function objectRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        corrupt(`${label} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        corrupt(`${label} must be a plain object`);
    return value;
}
function stringField(record, key) {
    return requireString(record[key], key);
}
function requireString(value, label) {
    if (typeof value !== 'string' || value === '')
        corrupt(`${label} must be a non-empty string`);
    return value;
}
function optionalString(record, key) {
    const value = record[key];
    return value === undefined ? undefined : requireString(value, key);
}
function absoluteString(record, key) {
    const value = stringField(record, key);
    if (!isAbsolute(value))
        corrupt(`${key} must be an absolute path`);
    return value;
}
function hashField(record, key) {
    return validateBlobHash(stringField(record, key));
}
function optionalHash(record, key) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    const hash = requireString(value, key);
    if (!GIT_OBJECT_PATTERN.test(hash))
        corrupt(`${key} must be a Git object id`);
    return hash;
}
function nonNegativeInteger(record, key) {
    const value = record[key];
    if (!Number.isSafeInteger(value) || value < 0)
        corrupt(`${key} must be a non-negative safe integer`);
    return value;
}
function optionalNonNegativeInteger(record, key) {
    return record[key] === undefined ? undefined : nonNegativeInteger(record, key);
}
function corrupt(message) {
    throw new ChangeLedgerError('STATE_CORRUPT', message);
}
