import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { ChangeLedgerError, errorMessage } from './errors.js';
import { discoverRepository } from './git.js';
import { ensureSafeParents, expandHome, isNodeError, isWithin, pruneEmptyParents, removeRestoreTarget, replaceRegularFile, replaceSymbolicLink, resolveWorkspacePath, validateRelativePath, } from './path-utils.js';
import { captureStableTree, diffTrees, entriesEqual } from './snapshot.js';
import { LedgerStore } from './store.js';
import { LEDGER_FORMAT_VERSION, } from './types.js';
const DEFAULTS = {
    maxRestorePoints: 50,
    maxTurnCheckpointsPerSession: 30,
    maxFiles: 20_000,
    maxFileBytes: 16 * 1024 * 1024,
    maxSnapshotBytes: 512 * 1024 * 1024,
    planTtlMs: 15 * 60 * 1_000,
    staleLockMs: 30_000,
};
/** Persistent workspace change-set engine, independent of the DSH tool adapter. */
export class ChangeLedgerEngine {
    config;
    store;
    plans = new Map();
    ready;
    /** Build an engine and start crash-journal reconciliation. */
    constructor(config = {}) {
        this.config = resolveConfig(config);
        this.store = new LedgerStore(this.config);
        this.ready = this.store.initialize();
    }
    /** Wait for startup reconciliation and return the number of interrupted journals found. */
    async initialize() {
        return this.ready;
    }
    /** Create a durable restore point for the current Git worktree. */
    async create(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.store.acquire(source.state.root);
        try {
            const label = normalizeLabel(options.label);
            const manifest = await this.createLocked({
                cwd: source.state.root,
                kind: 'user',
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                ...(label === undefined ? {} : { label }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            return summarize(manifest);
        }
        finally {
            await release();
        }
    }
    /** Capture one completed DSH turn for user-triggered Web rewind. */
    async createTurnCheckpoint(options) {
        await this.ready;
        if (!Number.isSafeInteger(options.turn) || options.turn < 0) {
            throw new ChangeLedgerError('INVALID_ARGUMENTS', 'turn must be a non-negative safe integer');
        }
        if (!Number.isSafeInteger(options.turnEndSeq) || options.turnEndSeq < 0) {
            throw new ChangeLedgerError('INVALID_ARGUMENTS', 'turnEndSeq must be a non-negative safe integer');
        }
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.store.acquire(source.state.root);
        try {
            const existing = await this.store.listManifests(source.state.root);
            const duplicate = existing.find(manifest => manifest.kind === 'turn'
                && manifest.sessionId === options.sessionId
                && manifest.turn === options.turn
                && manifest.turnEndSeq === options.turnEndSeq);
            if (duplicate !== undefined)
                return summarize(duplicate);
            const manifest = await this.createLocked({
                cwd: source.state.root,
                kind: 'turn',
                sessionId: options.sessionId,
                label: `Turn ${String(options.turn)} checkpoint`,
                turn: options.turn,
                turnEndSeq: options.turnEndSeq,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            const checkpoints = [...existing.filter(point => point.kind === 'turn' && point.sessionId === options.sessionId), manifest]
                .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
            for (const stale of checkpoints.slice(this.config.maxTurnCheckpointsPerSession)) {
                if (await this.store.isReferencedByRecovery(source.state.root, stale.id))
                    continue;
                await this.store.deleteManifest(source.state.root, stale.id);
            }
            await this.store.collectGarbage(source.state.root);
            return summarize(manifest);
        }
        finally {
            await release();
        }
    }
    /** Find the newest checkpoint for one completed session turn. */
    async findTurnCheckpoint(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const manifest = (await this.store.listManifests(source.state.root)).find(point => point.kind === 'turn' && point.sessionId === options.sessionId && point.turn === options.turn);
        return manifest === undefined ? undefined : summarize(manifest);
    }
    /** List restore points for the current worktree. */
    async list(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const manifests = await this.store.listManifests(source.state.root);
        return manifests
            .filter((manifest) => manifest.kind === 'user'
            || (manifest.kind === 'rescue' && options.includeRescue === true)
            || (manifest.kind === 'turn' && options.includeTurnCheckpoints === true))
            .map(summarize);
    }
    /** Compare one restore point with the current worktree. */
    async inspect(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const manifest = await this.store.readManifest(source.state.root, options.restorePointId);
        const current = await captureStableTree({ cwd: source.state.root, config: this.config, ...(options.signal === undefined ? {} : { signal: options.signal }) });
        return {
            restorePoint: summarize(manifest),
            currentTreeHash: current.treeHash,
            headChanged: repositoryHeadChanged(manifest.repository, current.source.state),
            operationChanged: manifest.repository.operation !== current.source.state.operation,
            changes: diffTrees(manifest.entries, current.entries),
        };
    }
    /** Produce an expiring, exact confirmation plan for a restore. */
    async planRestore(options) {
        await this.ready;
        this.expirePlans();
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const manifest = await this.store.readManifest(source.state.root, options.restorePointId);
        const current = await captureStableTree({ cwd: source.state.root, config: this.config, ...(options.signal === undefined ? {} : { signal: options.signal }) });
        assertRepositoryCompatible(manifest, current.source.state, options.allowHeadChange === true);
        const changes = diffTrees(manifest.entries, current.entries);
        if (changes.length === 0) {
            throw new ChangeLedgerError('NO_CHANGES', `workspace already matches restore point ${manifest.id}`);
        }
        const selected = selectChanges(changes, options.paths);
        await assertNoUnmanagedRestoreConflicts(source.state.root, manifest.entries, current.entries, selected.map((change) => change.path));
        const expected = Object.create(null);
        for (const change of selected)
            expected[change.path] = current.entries[change.path] ?? null;
        const now = Date.now();
        const plan = {
            id: makeId('plan'),
            restorePointId: manifest.id,
            workspace: manifest.workspace,
            repository: current.source.state,
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            createdAt: now,
            expiresAt: now + this.config.planTtlMs,
            confirmation: `RESTORE-${randomBytes(4).toString('hex').toUpperCase()}`,
            allowHeadChange: options.allowHeadChange === true,
            paths: selected.map((change) => change.path),
            changes: selected,
            expected,
        };
        this.plans.set(plan.id, plan);
        return clonePlan(plan);
    }
    /** Apply one approved restore plan, creating a durable rescue point first. */
    async applyRestore(options) {
        await this.ready;
        this.expirePlans();
        const plan = this.plans.get(options.planId);
        if (plan === undefined)
            throw new ChangeLedgerError('PLAN_NOT_FOUND', `restore plan ${options.planId} is absent or expired`);
        if (plan.confirmation !== options.confirmation) {
            throw new ChangeLedgerError('CONFIRMATION_MISMATCH', 'confirmation does not exactly match the restore plan');
        }
        if (plan.sessionId !== undefined && plan.sessionId !== options.sessionId) {
            throw new ChangeLedgerError('SESSION_MISMATCH', 'restore plan belongs to a different DSH session');
        }
        await this.assertStorageSeparated(plan.workspace);
        const release = await this.store.acquire(plan.workspace);
        try {
            const manifest = await this.store.readManifest(plan.workspace, plan.restorePointId);
            const current = await captureStableTree({ cwd: plan.workspace, config: this.config, ...(options.signal === undefined ? {} : { signal: options.signal }) });
            assertRepositoryCompatible(manifest, current.source.state, plan.allowHeadChange);
            assertPlanRepositoryFresh(plan.repository, current.source.state);
            assertPlanFresh(plan, current.entries);
            await assertNoUnmanagedRestoreConflicts(plan.workspace, manifest.entries, current.entries, plan.paths);
            const rescue = await this.createLocked({
                cwd: plan.workspace,
                kind: 'rescue',
                label: `Before restoring ${manifest.id}`,
                parentRestorePoint: manifest.id,
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            try {
                assertPlanFresh(plan, rescue.entries);
                await assertNoUnmanagedRestoreConflicts(plan.workspace, manifest.entries, rescue.entries, plan.paths);
            }
            catch (error) {
                await this.store.deleteManifest(plan.workspace, rescue.id);
                await this.store.collectGarbage(plan.workspace);
                throw error;
            }
            const operation = {
                version: LEDGER_FORMAT_VERSION,
                id: makeId('op'),
                workspace: plan.workspace,
                restorePointId: manifest.id,
                rescuePointId: rescue.id,
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                paths: plan.paths,
                startedAt: Date.now(),
                state: 'running',
            };
            await this.store.writeOperation(operation);
            try {
                await this.restorePaths(plan.workspace, manifest.entries, plan.paths, options.signal);
                await this.verifyPaths(plan.workspace, manifest.entries, plan.paths, options.signal);
            }
            catch (error) {
                const primaryError = errorMessage(error);
                let journalWarning;
                try {
                    await this.store.writeOperation({ ...operation, state: 'rollback-running', error: primaryError });
                }
                catch (journalError) {
                    journalWarning = `could not persist rollback-running state: ${errorMessage(journalError)}`;
                }
                let rollbackFailure;
                try {
                    await this.restorePaths(plan.workspace, rescue.entries, plan.paths);
                    await this.verifyPaths(plan.workspace, rescue.entries, plan.paths);
                }
                catch (rollbackError) {
                    rollbackFailure = rollbackError;
                }
                if (rollbackFailure === undefined) {
                    let terminalJournalWarning;
                    try {
                        await this.store.writeOperation({
                            ...operation,
                            state: 'rolled-back',
                            error: primaryError,
                            finishedAt: Date.now(),
                        });
                    }
                    catch (journalError) {
                        terminalJournalWarning = `could not persist rolled-back state: ${errorMessage(journalError)}`;
                    }
                    const warnings = [journalWarning, terminalJournalWarning].filter((value) => value !== undefined);
                    const warningText = warnings.length === 0 ? '' : `; journal warning: ${warnings.join('; ')}`;
                    throw new ChangeLedgerError('RESTORE_FAILED_ROLLED_BACK', `restore failed and the pre-restore state was recovered from ${rescue.id}: ${primaryError}${warningText}`, { cause: error });
                }
                const rollbackMessage = errorMessage(rollbackFailure);
                let recoveryJournalWarning;
                try {
                    await this.store.writeOperation({
                        ...operation,
                        state: 'recovery-required',
                        error: primaryError,
                        rollbackError: rollbackMessage,
                    });
                }
                catch (journalError) {
                    recoveryJournalWarning = `could not persist recovery-required state: ${errorMessage(journalError)}`;
                }
                const warnings = [journalWarning, recoveryJournalWarning].filter((value) => value !== undefined);
                const warningText = warnings.length === 0 ? '' : `; journal warning: ${warnings.join('; ')}`;
                throw new ChangeLedgerError('RECOVERY_REQUIRED', `restore and automatic rollback both failed; operation ${operation.id} can be recovered from rescue point ${rescue.id}: ${primaryError}; rollback: ${rollbackMessage}${warningText}`, { cause: error });
            }
            const finishedAt = Date.now();
            await this.store.writeOperation({ ...operation, state: 'completed', finishedAt });
            await this.store.writeManifest({
                ...manifest,
                restoreCount: manifest.restoreCount + 1,
                lastRestoredAt: finishedAt,
            });
            this.plans.delete(plan.id);
            return {
                operationId: operation.id,
                restorePointId: manifest.id,
                rescuePointId: rescue.id,
                restoredPaths: plan.paths,
            };
        }
        finally {
            await release();
        }
    }
    /** Delete one restore point and collect unreferenced blobs. */
    async delete(options) {
        await this.ready;
        if (options.confirmation !== `DELETE ${options.restorePointId}`) {
            throw new ChangeLedgerError('CONFIRMATION_MISMATCH', `confirmation must exactly equal "DELETE ${options.restorePointId}"`);
        }
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.store.acquire(source.state.root);
        try {
            await this.store.readManifest(source.state.root, options.restorePointId);
            if (await this.store.isReferencedByRecovery(source.state.root, options.restorePointId)) {
                throw new ChangeLedgerError('RECOVERY_REFERENCE', 'restore point is required by an incomplete recovery journal');
            }
            await this.store.deleteManifest(source.state.root, options.restorePointId);
            const gc = await this.store.collectGarbage(source.state.root);
            return { restorePointId: options.restorePointId, ...gc };
        }
        finally {
            await release();
        }
    }
    /** List restore operations that were interrupted or require manual recovery. */
    async listRecovery(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        return (await this.store.listOperations(source.state.root))
            .filter((operation) => operation.state === 'interrupted' || operation.state === 'recovery-required')
            .map((operation) => ({
            operationId: operation.id,
            restorePointId: operation.restorePointId,
            rescuePointId: operation.rescuePointId,
            state: operation.state,
            paths: operation.paths,
            startedAt: operation.startedAt,
            ...(operation.error === undefined ? {} : { error: operation.error }),
            ...(operation.rollbackError === undefined ? {} : { rollbackError: operation.rollbackError }),
        }));
    }
    async createLocked(options) {
        const existing = await this.store.listManifests(options.cwd);
        const durableUserPoints = existing.filter(point => point.kind !== 'turn');
        if (options.kind !== 'turn' && durableUserPoints.length >= this.config.maxRestorePoints) {
            throw new ChangeLedgerError('RESTORE_POINT_LIMIT', `workspace already has ${durableUserPoints.length} user/rescue restore points; configured maximum is ${this.config.maxRestorePoints}`);
        }
        try {
            const tree = await captureStableTree({
                cwd: options.cwd,
                config: this.config,
                store: this.store,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            const manifest = {
                version: LEDGER_FORMAT_VERSION,
                id: makeId('rp'),
                kind: options.kind,
                workspace: tree.source.state.root,
                repository: tree.source.state,
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                ...(options.label === undefined ? {} : { label: options.label }),
                ...(options.parentRestorePoint === undefined ? {} : { parentRestorePoint: options.parentRestorePoint }),
                ...(options.turn === undefined ? {} : { turn: options.turn }),
                ...(options.turnEndSeq === undefined ? {} : { turnEndSeq: options.turnEndSeq }),
                createdAt: Date.now(),
                treeHash: tree.treeHash,
                fileCount: tree.fileCount,
                totalBytes: tree.totalBytes,
                entries: tree.entries,
                restoreCount: 0,
            };
            await this.store.collectGarbage(options.cwd, Object.values(manifest.entries)
                .filter((entry) => entry.kind === 'file')
                .map((entry) => entry.blob));
            await this.store.writeManifest(manifest);
            return manifest;
        }
        catch (error) {
            try {
                await this.store.collectGarbage(options.cwd);
            }
            catch (cleanupError) {
                throw new ChangeLedgerError('SNAPSHOT_CLEANUP_FAILED', `snapshot failed (${errorMessage(error)}) and unreferenced-blob cleanup also failed (${errorMessage(cleanupError)})`, { cause: error });
            }
            throw error;
        }
    }
    async restorePaths(workspace, desiredEntries, paths, signal) {
        const deletions = paths.filter((path) => desiredEntries[path] === undefined).sort(compareDeepestFirst);
        for (const path of deletions) {
            throwIfAborted(signal);
            const target = resolveWorkspacePath(workspace, path);
            await removeRestoreTarget(target);
            await pruneEmptyParents(workspace, target);
        }
        const restorations = paths.filter((path) => desiredEntries[path] !== undefined).sort(compareShallowestFirst);
        for (const path of restorations) {
            throwIfAborted(signal);
            const entry = desiredEntries[path];
            if (entry === undefined)
                continue;
            const target = resolveWorkspacePath(workspace, path);
            await ensureSafeParents(workspace, target);
            try {
                const info = await lstat(target);
                if (info.isDirectory() && !info.isSymbolicLink())
                    await removeRestoreTarget(target);
            }
            catch (error) {
                if (!isNodeError(error, 'ENOENT'))
                    throw error;
            }
            if (entry.kind === 'file') {
                const content = await this.store.readBlob(workspace, entry.blob);
                if (content.length !== entry.size) {
                    throw new ChangeLedgerError('BLOB_CORRUPT', `blob ${entry.blob} has unexpected size for ${JSON.stringify(path)}`);
                }
                await replaceRegularFile(target, content, entry.mode);
            }
            else {
                await replaceSymbolicLink(target, entry.target);
            }
        }
    }
    async verifyPaths(workspace, desiredEntries, paths, signal) {
        const current = await captureStableTree({ cwd: workspace, config: this.config, ...(signal === undefined ? {} : { signal }) });
        for (const path of paths) {
            if (!entriesEqual(desiredEntries[path], current.entries[path])) {
                throw new ChangeLedgerError('RESTORE_VERIFY_FAILED', `restored path did not match its expected snapshot: ${JSON.stringify(path)}`);
            }
        }
    }
    async assertStorageSeparated(workspace) {
        const storage = await realpath(resolve(this.config.storageDir));
        if (isWithin(workspace, storage) || isWithin(storage, workspace)) {
            throw new ChangeLedgerError('STATE_WORKSPACE_OVERLAP', `storageDir ${JSON.stringify(storage)} must not overlap workspace ${JSON.stringify(workspace)}`);
        }
    }
    expirePlans() {
        const now = Date.now();
        for (const [id, plan] of this.plans) {
            if (plan.expiresAt <= now)
                this.plans.delete(id);
        }
    }
}
/** Resolve and validate every deployment-varying configuration value. */
export function resolveConfig(config) {
    const home = homedir();
    const configuredDshHome = process.env.DSH_HOME?.trim();
    const dshHome = configuredDshHome === undefined || configuredDshHome === ''
        ? join(home, '.dsh')
        : resolve(expandHome(configuredDshHome, home));
    const storageInput = config.storageDir ?? join(dshHome, 'change-ledger', 'v1');
    const storageDir = resolve(expandHome(requireNonEmptyString(storageInput, 'storageDir'), home));
    return {
        storageDir,
        maxRestorePoints: positiveInteger(config.maxRestorePoints ?? DEFAULTS.maxRestorePoints, 'maxRestorePoints'),
        maxTurnCheckpointsPerSession: positiveInteger(config.maxTurnCheckpointsPerSession ?? DEFAULTS.maxTurnCheckpointsPerSession, 'maxTurnCheckpointsPerSession'),
        maxFiles: positiveInteger(config.maxFiles ?? DEFAULTS.maxFiles, 'maxFiles'),
        maxFileBytes: positiveInteger(config.maxFileBytes ?? DEFAULTS.maxFileBytes, 'maxFileBytes'),
        maxSnapshotBytes: positiveInteger(config.maxSnapshotBytes ?? DEFAULTS.maxSnapshotBytes, 'maxSnapshotBytes'),
        planTtlMs: positiveInteger(config.planTtlMs ?? DEFAULTS.planTtlMs, 'planTtlMs'),
        staleLockMs: positiveInteger(config.staleLockMs ?? DEFAULTS.staleLockMs, 'staleLockMs'),
    };
}
function summarize(manifest) {
    return {
        id: manifest.id,
        kind: manifest.kind,
        workspace: manifest.workspace,
        ...(manifest.sessionId === undefined ? {} : { sessionId: manifest.sessionId }),
        ...(manifest.label === undefined ? {} : { label: manifest.label }),
        ...(manifest.parentRestorePoint === undefined ? {} : { parentRestorePoint: manifest.parentRestorePoint }),
        ...(manifest.turn === undefined ? {} : { turn: manifest.turn }),
        ...(manifest.turnEndSeq === undefined ? {} : { turnEndSeq: manifest.turnEndSeq }),
        createdAt: manifest.createdAt,
        treeHash: manifest.treeHash,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        restoreCount: manifest.restoreCount,
        ...(manifest.lastRestoredAt === undefined ? {} : { lastRestoredAt: manifest.lastRestoredAt }),
        ...(manifest.repository.head === undefined ? {} : { head: manifest.repository.head }),
        ...(manifest.repository.branch === undefined ? {} : { branch: manifest.repository.branch }),
        stagedPathCount: manifest.repository.stagedPaths.length,
    };
}
function assertRepositoryCompatible(manifest, current, allowHeadChange) {
    if (manifest.repository.root !== current.root || manifest.repository.commonDir !== current.commonDir) {
        throw new ChangeLedgerError('REPOSITORY_CHANGED', 'restore point no longer belongs to this Git worktree');
    }
    if (manifest.repository.operation !== current.operation) {
        throw new ChangeLedgerError('GIT_OPERATION_CHANGED', `Git operation changed from ${manifest.repository.operation ?? 'none'} to ${current.operation ?? 'none'}`);
    }
    if (!allowHeadChange && repositoryHeadChanged(manifest.repository, current)) {
        throw new ChangeLedgerError('HEAD_CHANGED', 'HEAD or branch changed since the restore point; re-plan with allowHeadChange only after reviewing the diff');
    }
}
function repositoryHeadChanged(before, after) {
    return before.head !== after.head || before.branch !== after.branch;
}
function assertPlanRepositoryFresh(planned, current) {
    if (planned.root !== current.root
        || planned.commonDir !== current.commonDir
        || planned.head !== current.head
        || planned.branch !== current.branch
        || planned.operation !== current.operation) {
        throw new ChangeLedgerError('PLAN_STALE_REPOSITORY', 'Git repository state changed after restore planning; inspect and plan again');
    }
}
function selectChanges(changes, requested) {
    if (requested === undefined || requested.length === 0)
        return [...changes];
    const normalized = requested.map(validateRelativePath);
    if (new Set(normalized).size !== normalized.length) {
        throw new ChangeLedgerError('DUPLICATE_PATH', 'restore path selection contains duplicates');
    }
    const byPath = new Map(changes.map((change) => [change.path, change]));
    return normalized.map((path) => {
        const change = byPath.get(path);
        if (change === undefined)
            throw new ChangeLedgerError('PATH_NOT_CHANGED', `${JSON.stringify(path)} is not changed from the restore point`);
        return change;
    });
}
function assertPlanFresh(plan, current) {
    for (const path of plan.paths) {
        const expected = plan.expected[path];
        if (expected === undefined)
            throw new ChangeLedgerError('PLAN_CORRUPT', `plan lacks expected state for ${JSON.stringify(path)}`);
        const normalizedExpected = expected === null ? undefined : expected;
        if (!entriesEqual(normalizedExpected, current[path])) {
            throw new ChangeLedgerError('PLAN_STALE', `workspace changed after planning at ${JSON.stringify(path)}; inspect and plan again`);
        }
    }
}
async function assertNoUnmanagedRestoreConflicts(workspace, desired, current, paths) {
    for (const path of paths) {
        if (desired[path] === undefined || current[path] !== undefined)
            continue;
        const target = resolveWorkspacePath(workspace, path);
        try {
            const info = await lstat(target);
            if (info.isDirectory() && !info.isSymbolicLink())
                continue;
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT'))
                continue;
            throw error;
        }
        throw new ChangeLedgerError('UNMANAGED_PATH_CONFLICT', `refusing to replace ${JSON.stringify(path)} because it exists on disk but is excluded from the current Git snapshot`);
    }
}
function clonePlan(plan) {
    return structuredClone(plan);
}
function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}
function normalizeLabel(label) {
    if (label === undefined)
        return undefined;
    const normalized = label.trim();
    if (normalized === '')
        throw new ChangeLedgerError('INVALID_LABEL', 'restore-point label must not be blank');
    if (normalized.length > 200)
        throw new ChangeLedgerError('INVALID_LABEL', 'restore-point label must be at most 200 characters');
    return normalized;
}
function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ChangeLedgerError('INVALID_CONFIG', `${name} must be a positive safe integer`);
    }
    return value;
}
function requireNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ChangeLedgerError('INVALID_CONFIG', `${name} must be a non-empty string`);
    }
    return value;
}
function throwIfAborted(signal) {
    if (signal?.aborted === true)
        throw signal.reason;
}
function depth(path) {
    return path.split('/').length;
}
function compareDeepestFirst(left, right) {
    return depth(right) - depth(left) || Buffer.from(left).compare(Buffer.from(right));
}
function compareShallowestFirst(left, right) {
    return depth(left) - depth(right) || Buffer.from(left).compare(Buffer.from(right));
}
//# sourceMappingURL=engine.js.map