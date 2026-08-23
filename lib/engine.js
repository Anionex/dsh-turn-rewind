import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { createDeadline } from './deadline.js';
import { ChangeLedgerError, errorMessage } from './errors.js';
import { discoverRepository, discoverRepositoryRoot, ensureGitWorktreeIdentity, resolveGitWorktreeRoot, sameRepositoryFence, } from './git.js';
import { captureGitTurnCheckpoint, deleteGitCheckpoint, deleteGitCheckpointRef, publishGitCheckpoint, readGitBlob, verifyGitCheckpoint, } from './git-checkpoint.js';
import { assertSafeParents, ensureSafeParents, expandHome, isNodeError, isWithin, pruneEmptyParents, removeRestoreTarget, replaceRegularFile, replaceSymbolicLink, resolveWorkspacePath, validateRelativePath, } from './path-utils.js';
import { captureSnapshotEntry, captureStableTree, diffTrees, entriesEqual } from './snapshot.js';
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
    turnCheckpointMode: 'legacy',
    turnCheckpointTimeoutMs: 5_000,
    turnCheckpointMaxNewBytes: 32 * 1024 * 1024,
    turnCheckpointTrust: 'fast',
};
/** Persistent workspace change-set engine, independent of the DSH tool adapter. */
export class ChangeLedgerEngine {
    config;
    store;
    plans = new Map();
    activePlans = new Set();
    ready;
    /** Build an engine and start crash-journal reconciliation. */
    constructor(config = {}) {
        this.config = resolveConfig(config);
        this.store = new LedgerStore(this.config);
        this.ready = this.initializeStore();
    }
    /** Wait for startup reconciliation and return the number of interrupted journals found. */
    async initialize() {
        return this.ready;
    }
    async initializeStore() {
        const restoredOperations = await this.store.initialize();
        return restoredOperations + await this.reconcileGitCheckpointJournals();
    }
    async acquireWorkspace(workspace, signal) {
        const identity = await ensureGitWorktreeIdentity(workspace, signal);
        if (identity.root !== workspace) {
            throw new ChangeLedgerError('GIT_ROOT_INVALID', `workspace moved while acquiring its lock: ${JSON.stringify(workspace)}`);
        }
        return this.store.acquire(workspace, identity.lockPath, {
            commonDir: identity.commonDir,
            gitDir: identity.gitDir,
            worktreeId: identity.worktreeId,
        }, signal);
    }
    async reconcileGitCheckpointJournals() {
        let reconciled = 0;
        for (const journal of await this.store.listGitCheckpointJournals()) {
            const workspace = await resolveGitWorktreeRoot(journal.commonDir, journal.worktreeId, journal.workspace);
            const activeJournal = workspace === journal.workspace ? journal : { ...journal, workspace };
            const release = await this.acquireWorkspace(workspace);
            try {
                const manifest = await this.tryReadManifest(workspace, journal.restorePointId);
                if (journal.action === 'publish') {
                    if (manifest === undefined) {
                        await deleteGitCheckpointRef(workspace, journal.ref, journal.commit, this.config.storageDir);
                    }
                    else {
                        assertJournalMatchesManifest(activeJournal, manifest);
                        await verifyGitCheckpoint(manifest);
                    }
                }
                else {
                    if (manifest !== undefined) {
                        assertJournalMatchesManifest(activeJournal, manifest);
                        await this.store.deleteManifest(workspace, journal.restorePointId);
                    }
                    await deleteGitCheckpointRef(workspace, journal.ref, journal.commit, this.config.storageDir);
                }
                await this.store.deleteGitCheckpointJournal(workspace, journal.restorePointId);
                reconciled += 1;
            }
            finally {
                await release();
            }
        }
        return reconciled;
    }
    async publishGitManifest(manifest, signal) {
        let journalWritten = false;
        try {
            await this.store.writeGitCheckpointJournal('publish', manifest);
            journalWritten = true;
            await publishGitCheckpoint(manifest, this.config.storageDir, signal);
            await verifyGitCheckpoint(manifest, signal);
            await this.store.writeManifest(manifest);
        }
        catch (error) {
            if (!journalWritten)
                throw error;
            const persisted = await this.tryReadManifest(manifest.workspace, manifest.id);
            if (persisted !== undefined) {
                assertJournalMatchesManifest({
                    version: 1,
                    action: 'publish',
                    storeId: manifest.git.storeId,
                    workspace: manifest.workspace,
                    commonDir: manifest.repository.commonDir,
                    worktreeId: manifest.git.worktreeId,
                    restorePointId: manifest.id,
                    ref: manifest.git.ref,
                    commit: manifest.git.commit,
                    createdAt: manifest.createdAt,
                }, persisted);
                await verifyGitCheckpoint(persisted, signal);
                await this.store.deleteGitCheckpointJournal(manifest.workspace, manifest.id).catch(() => undefined);
                return;
            }
            try {
                await deleteGitCheckpoint(manifest, this.config.storageDir);
                await this.store.deleteGitCheckpointJournal(manifest.workspace, manifest.id);
            }
            catch (cleanupError) {
                throw new ChangeLedgerError('SNAPSHOT_CLEANUP_FAILED', `Git checkpoint publication failed (${errorMessage(error)}) and journaled ref cleanup also failed (${errorMessage(cleanupError)})`, { cause: error });
            }
            throw error;
        }
        await this.store.deleteGitCheckpointJournal(manifest.workspace, manifest.id).catch(() => undefined);
    }
    async deleteManifestWithGit(manifest, signal) {
        if (manifest.version === LEDGER_FORMAT_VERSION) {
            await this.store.deleteManifest(manifest.workspace, manifest.id);
            return;
        }
        await this.store.writeGitCheckpointJournal('delete', manifest);
        await this.store.deleteManifest(manifest.workspace, manifest.id);
        await deleteGitCheckpoint(manifest, this.config.storageDir, signal);
        await this.store.deleteGitCheckpointJournal(manifest.workspace, manifest.id);
    }
    async tryReadManifest(workspace, id) {
        try {
            return await this.store.readManifest(workspace, id);
        }
        catch (error) {
            if (error instanceof ChangeLedgerError && error.code === 'RESTORE_POINT_NOT_FOUND')
                return undefined;
            throw error;
        }
    }
    /** Create a durable restore point for the current Git worktree. */
    async create(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.acquireWorkspace(source.state.root, options.signal);
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
    /** Capture project files before one DSH turn begins its first step. */
    async createTurnCheckpoint(options) {
        const deadline = createDeadline(this.config.turnCheckpointTimeoutMs);
        const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
        try {
            try {
                await waitWithSignal(this.ready, signal);
            }
            catch (error) {
                throw checkpointDeadlineError(error, this.config.turnCheckpointTimeoutMs, deadline.signal, options.signal);
            }
            if (this.config.turnCheckpointMode === 'off') {
                throw new ChangeLedgerError('TURN_CHECKPOINT_DISABLED', 'automatic turn checkpoints are disabled');
            }
            if (!Number.isSafeInteger(options.turn) || options.turn < 0) {
                throw new ChangeLedgerError('INVALID_ARGUMENTS', 'turn must be a non-negative safe integer');
            }
            if (!Number.isSafeInteger(options.turnStartSeq) || options.turnStartSeq < 0) {
                throw new ChangeLedgerError('INVALID_ARGUMENTS', 'turnStartSeq must be a non-negative safe integer');
            }
            try {
                const source = await discoverRepository(options.cwd, signal);
                await this.assertStorageSeparated(source.state.root);
                const release = await this.acquireWorkspace(source.state.root, signal);
                try {
                    const existing = await waitWithSignal(this.store.listManifests(source.state.root, signal), signal);
                    const duplicate = existing.find(manifest => manifest.kind === 'turn'
                        && manifest.sessionId === options.sessionId
                        && manifest.turn === options.turn
                        && manifest.turnStartSeq === options.turnStartSeq);
                    if (duplicate !== undefined) {
                        if (duplicate.version === 2)
                            await verifyGitCheckpoint(duplicate, signal);
                        await this.store.deleteTurnCheckpointSkip(source.state.root, options.sessionId, options.turn, options.turnStartSeq).catch(() => undefined);
                        return summarize(duplicate);
                    }
                    throwIfAborted(signal);
                    let manifest;
                    if (this.config.turnCheckpointMode === 'legacy') {
                        manifest = await this.createLocked({
                            cwd: source.state.root,
                            kind: 'turn',
                            sessionId: options.sessionId,
                            label: `Before turn ${String(options.turn)} checkpoint`,
                            turn: options.turn,
                            turnStartSeq: options.turnStartSeq,
                            signal,
                            deferGarbageCollection: true,
                        });
                    }
                    else {
                        const id = makeId('rp');
                        const captured = (await captureGitTurnCheckpoint({
                            cwd: source.state.root,
                            id,
                            sessionId: options.sessionId,
                            turn: options.turn,
                            turnStartSeq: options.turnStartSeq,
                            config: this.config,
                            signal,
                        })).manifest;
                        await this.publishGitManifest(captured, signal);
                        manifest = captured;
                    }
                    await this.store.deleteTurnCheckpointSkip(source.state.root, options.sessionId, options.turn, options.turnStartSeq).catch(() => undefined);
                    if (!signal.aborted) {
                        const checkpoints = [...existing.filter(point => point.kind === 'turn' && point.sessionId === options.sessionId), manifest]
                            .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
                        for (const stale of checkpoints.slice(this.config.maxTurnCheckpointsPerSession)) {
                            if (signal.aborted)
                                break;
                            if (await this.store.isReferencedByRecovery(source.state.root, stale.id))
                                continue;
                            await this.deleteManifestWithGit(stale, signal).catch(() => undefined);
                        }
                    }
                    return summarize(manifest);
                }
                finally {
                    await release();
                }
            }
            catch (error) {
                throw checkpointDeadlineError(error, this.config.turnCheckpointTimeoutMs, deadline.signal, options.signal);
            }
        }
        finally {
            deadline.cancel();
        }
    }
    /** Persist one bounded automatic-checkpoint skip without blocking a later turn retry. */
    async recordTurnCheckpointSkip(options) {
        await waitWithSignal(this.ready, options.signal);
        const workspace = await discoverRepositoryRoot(options.cwd, options.signal);
        await this.assertStorageSeparated(workspace);
        const release = await this.acquireWorkspace(workspace, options.signal);
        try {
            throwIfAborted(options.signal);
            const existing = (await this.store.listManifests(workspace, options.signal)).some(manifest => manifest.kind === 'turn'
                && manifest.sessionId === options.sessionId
                && manifest.turn === options.turn
                && manifest.turnStartSeq === options.turnStartSeq);
            if (existing) {
                await this.store.deleteTurnCheckpointSkip(workspace, options.sessionId, options.turn, options.turnStartSeq);
                return;
            }
            await this.store.writeTurnCheckpointSkip(workspace, {
                version: 1,
                sessionId: options.sessionId,
                turn: options.turn,
                turnStartSeq: options.turnStartSeq,
                reason: options.reason.slice(0, 2_000),
                createdAt: Date.now(),
            });
        }
        finally {
            await release();
        }
    }
    /** Read a durable skip marker for one exact prompt boundary. */
    async findTurnCheckpointSkip(options) {
        await this.ready;
        const workspace = await discoverRepositoryRoot(options.cwd, options.signal);
        await this.assertStorageSeparated(workspace);
        const release = await this.acquireWorkspace(workspace, options.signal);
        try {
            const skip = await this.store.readTurnCheckpointSkip(workspace, options.sessionId, options.turn, options.turnStartSeq);
            return skip === undefined ? undefined : { reason: skip.reason };
        }
        finally {
            await release();
        }
    }
    /** Find the prompt-anchored checkpoint captured before one session turn. */
    async findTurnCheckpoint(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.acquireWorkspace(source.state.root, options.signal);
        try {
            const manifest = (await this.store.listManifests(source.state.root)).find(point => point.kind === 'turn'
                && point.sessionId === options.sessionId
                && point.turn === options.turn
                && point.turnStartSeq !== undefined);
            if (manifest?.version === 2)
                await verifyGitCheckpoint(manifest, options.signal);
            return manifest === undefined ? undefined : summarize(manifest);
        }
        finally {
            await release();
        }
    }
    /** List restore points for the current worktree. */
    async list(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.acquireWorkspace(source.state.root, options.signal);
        try {
            const manifests = await this.store.listManifests(source.state.root);
            return manifests
                .filter((manifest) => manifest.kind === 'user'
                || (manifest.kind === 'rescue' && options.includeRescue === true)
                || (manifest.kind === 'turn' && options.includeTurnCheckpoints === true))
                .map(summarize);
        }
        finally {
            await release();
        }
    }
    /** Compare one restore point with the current worktree. */
    async inspect(options) {
        await this.ready;
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.acquireWorkspace(source.state.root, options.signal);
        try {
            const manifest = await this.store.readManifest(source.state.root, options.restorePointId);
            if (manifest.version === 2)
                await verifyGitCheckpoint(manifest, options.signal);
            const current = await captureStableTree({
                cwd: source.state.root,
                config: this.config,
                ...(manifest.version === 2 ? { gitObjectFormat: manifest.git.objectFormat } : {}),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            const currentEntries = manifest.version === 2 ? current.gitEntries : current.entries;
            if (currentEntries === undefined)
                throw new ChangeLedgerError('STATE_CORRUPT', 'Git comparison entries are unavailable');
            return {
                restorePoint: summarize(manifest),
                currentTreeHash: current.treeHash,
                currentRepository: current.source.state,
                ...(current.source.state.head === undefined ? {} : { currentHead: current.source.state.head }),
                ...(current.source.state.branch === undefined ? {} : { currentBranch: current.source.state.branch }),
                ...(current.source.state.operation === undefined ? {} : { currentOperation: current.source.state.operation }),
                headChanged: repositoryHeadChanged(manifest.repository, current.source.state),
                operationChanged: manifest.repository.operation !== current.source.state.operation,
                changes: diffTrees(manifest.entries, current.entries, manifest.entries, currentEntries),
            };
        }
        finally {
            await release();
        }
    }
    /** Produce an expiring, exact confirmation plan for a restore. */
    async planRestore(options) {
        await this.ready;
        this.expirePlans();
        const source = await discoverRepository(options.cwd, options.signal);
        await this.assertStorageSeparated(source.state.root);
        const release = await this.acquireWorkspace(source.state.root, options.signal);
        try {
            const manifest = await this.store.readManifest(source.state.root, options.restorePointId);
            if (manifest.version === 2)
                await verifyGitCheckpoint(manifest, options.signal);
            const current = await captureStableTree({
                cwd: source.state.root,
                config: this.config,
                ...(manifest.version === 2 ? { gitObjectFormat: manifest.git.objectFormat } : {}),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            const currentEntries = manifest.version === 2 ? current.gitEntries : current.entries;
            if (currentEntries === undefined)
                throw new ChangeLedgerError('STATE_CORRUPT', 'Git comparison entries are unavailable');
            if (options.expectedCurrentTreeHash !== undefined && options.expectedCurrentTreeHash !== current.treeHash) {
                throw new ChangeLedgerError('PLAN_STALE', 'workspace changed after inspection; inspect and plan again');
            }
            if (options.expectedRepository !== undefined && !sameRepositoryFence(options.expectedRepository, current.source.state)) {
                throw new ChangeLedgerError('PLAN_STALE_REPOSITORY', 'Git repository state changed after inspection; inspect and plan again');
            }
            assertRepositoryCompatible(manifest, current.source.state, options.allowHeadChange === true);
            const changes = diffTrees(manifest.entries, current.entries, manifest.entries, currentEntries);
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
        finally {
            await release();
        }
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
        if (this.activePlans.has(plan.id)) {
            throw new ChangeLedgerError('PLAN_IN_PROGRESS', `restore plan ${plan.id} is already being applied`);
        }
        this.activePlans.add(plan.id);
        try {
            await this.assertStorageSeparated(plan.workspace);
            const release = await this.acquireWorkspace(plan.workspace, options.signal);
            try {
                const manifest = await this.store.readManifest(plan.workspace, plan.restorePointId);
                if (manifest.version === 2)
                    await verifyGitCheckpoint(manifest, options.signal);
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
                    await this.restorePaths(plan.workspace, manifest.entries, plan.paths, options.signal, plan.expected);
                    await this.verifyPaths(plan.workspace, manifest.entries, plan.paths, options.signal, manifest.version === 2 ? manifest.git.objectFormat : undefined);
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
        finally {
            this.activePlans.delete(plan.id);
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
        const release = await this.acquireWorkspace(source.state.root, options.signal);
        try {
            const manifest = await this.store.readManifest(source.state.root, options.restorePointId);
            if (await this.store.isReferencedByRecovery(source.state.root, options.restorePointId)) {
                throw new ChangeLedgerError('RECOVERY_REFERENCE', 'restore point is required by an incomplete recovery journal');
            }
            await this.deleteManifestWithGit(manifest, options.signal);
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
        const release = await this.acquireWorkspace(source.state.root, options.signal);
        try {
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
        finally {
            await release();
        }
    }
    async createLocked(options) {
        const existing = await this.store.listManifests(options.cwd);
        const durableUserPoints = existing.filter(point => point.kind !== 'turn');
        if (options.kind !== 'turn' && durableUserPoints.length >= this.config.maxRestorePoints) {
            throw new ChangeLedgerError('RESTORE_POINT_LIMIT', `workspace already has ${durableUserPoints.length} user/rescue restore points; configured maximum is ${this.config.maxRestorePoints}`);
        }
        if (options.deferGarbageCollection === true) {
            await this.store.reconcileSnapshotCleanup(options.cwd, options.signal);
            throwIfAborted(options.signal);
            await this.store.writeSnapshotCleanup(options.cwd);
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
                ...(options.turnStartSeq === undefined ? {} : { turnStartSeq: options.turnStartSeq }),
                ...(options.turnEndSeq === undefined ? {} : { turnEndSeq: options.turnEndSeq }),
                createdAt: Date.now(),
                treeHash: tree.treeHash,
                fileCount: tree.fileCount,
                totalBytes: tree.totalBytes,
                entries: tree.entries,
                restoreCount: 0,
            };
            if (options.deferGarbageCollection !== true) {
                await this.store.collectGarbage(options.cwd, Object.values(manifest.entries)
                    .filter((entry) => entry.kind === 'file' && entry.provider !== 'git')
                    .map((entry) => entry.blob));
            }
            await this.store.writeManifest(manifest);
            if (options.deferGarbageCollection === true) {
                await this.store.deleteSnapshotCleanup(options.cwd).catch(() => undefined);
            }
            return manifest;
        }
        catch (error) {
            if (options.deferGarbageCollection === true)
                throw error;
            try {
                await this.store.collectGarbage(options.cwd);
            }
            catch (cleanupError) {
                throw new ChangeLedgerError('SNAPSHOT_CLEANUP_FAILED', `snapshot failed (${errorMessage(error)}) and unreferenced-blob cleanup also failed (${errorMessage(cleanupError)})`, { cause: error });
            }
            throw error;
        }
    }
    async restorePaths(workspace, desiredEntries, paths, signal, expectedEntries) {
        const deletions = paths.filter((path) => desiredEntries[path] === undefined).sort(compareDeepestFirst);
        for (const path of deletions) {
            throwIfAborted(signal);
            const target = resolveWorkspacePath(workspace, path);
            if (expectedEntries !== undefined)
                await this.assertPathFresh(workspace, path, expectedEntries[path], signal);
            await assertSafeParents(workspace, target);
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
            if (expectedEntries !== undefined)
                await this.assertPathFresh(workspace, path, expectedEntries[path], signal);
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
                const content = entry.provider === 'git'
                    ? await readGitBlob(workspace, entry.blob, entry.size, signal)
                    : await this.store.readBlob(workspace, entry.blob);
                if (content.length !== entry.size) {
                    throw new ChangeLedgerError('BLOB_CORRUPT', `blob ${entry.blob} has unexpected size for ${JSON.stringify(path)}`);
                }
                if (expectedEntries !== undefined)
                    await this.assertPathFresh(workspace, path, expectedEntries[path], signal);
                else
                    await assertSafeParents(workspace, target);
                await replaceRegularFile(target, content, entry.mode);
            }
            else {
                await replaceSymbolicLink(target, entry.target);
            }
        }
    }
    async assertPathFresh(workspace, path, expected, signal) {
        const target = resolveWorkspacePath(workspace, path);
        await assertSafeParents(workspace, target);
        let current;
        try {
            current = await captureSnapshotEntry(workspace, path, this.config.maxFileBytes, signal);
        }
        catch (error) {
            if (error instanceof ChangeLedgerError && error.code === 'UNSUPPORTED_FILE_TYPE') {
                throw new ChangeLedgerError('PLAN_STALE', `workspace path changed type after planning: ${JSON.stringify(path)}`, { cause: error });
            }
            throw error;
        }
        if (!entriesEqual(expected === null ? undefined : expected, current)) {
            throw new ChangeLedgerError('PLAN_STALE', `workspace changed immediately before restore at ${JSON.stringify(path)}; inspect and plan again`);
        }
    }
    async verifyPaths(workspace, desiredEntries, paths, signal, gitObjectFormat) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const first = await this.captureSelectedEntries(workspace, paths, signal, gitObjectFormat);
            const second = await this.captureSelectedEntries(workspace, paths, signal, gitObjectFormat);
            if (!paths.every(path => entriesEqual(first.get(path), second.get(path))))
                continue;
            for (const path of paths) {
                if (!entriesEqual(desiredEntries[path], second.get(path))) {
                    throw new ChangeLedgerError('RESTORE_VERIFY_FAILED', `restored path did not match its expected snapshot: ${JSON.stringify(path)}`);
                }
            }
            return;
        }
        throw new ChangeLedgerError('RESTORE_VERIFY_FAILED', 'restored paths did not remain stable during post-verification');
    }
    async captureSelectedEntries(workspace, paths, signal, gitObjectFormat) {
        const entries = new Map();
        for (const path of paths) {
            entries.set(path, await captureSnapshotEntry(workspace, path, this.config.maxFileBytes, signal, gitObjectFormat));
        }
        return entries;
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
        turnCheckpointMode: checkpointMode(config.turnCheckpointMode ?? DEFAULTS.turnCheckpointMode),
        turnCheckpointTimeoutMs: positiveInteger(config.turnCheckpointTimeoutMs ?? DEFAULTS.turnCheckpointTimeoutMs, 'turnCheckpointTimeoutMs'),
        turnCheckpointMaxNewBytes: positiveInteger(config.turnCheckpointMaxNewBytes ?? DEFAULTS.turnCheckpointMaxNewBytes, 'turnCheckpointMaxNewBytes'),
        turnCheckpointTrust: checkpointTrust(config.turnCheckpointTrust ?? DEFAULTS.turnCheckpointTrust),
    };
}
function summarize(manifest) {
    return {
        format: manifest.version,
        id: manifest.id,
        kind: manifest.kind,
        workspace: manifest.workspace,
        ...(manifest.sessionId === undefined ? {} : { sessionId: manifest.sessionId }),
        ...(manifest.label === undefined ? {} : { label: manifest.label }),
        ...(manifest.parentRestorePoint === undefined ? {} : { parentRestorePoint: manifest.parentRestorePoint }),
        ...(manifest.turn === undefined ? {} : { turn: manifest.turn }),
        ...(manifest.turnStartSeq === undefined ? {} : { turnStartSeq: manifest.turnStartSeq }),
        ...(manifest.turnEndSeq === undefined ? {} : { turnEndSeq: manifest.turnEndSeq }),
        createdAt: manifest.createdAt,
        treeHash: manifest.treeHash,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        restoreCount: manifest.restoreCount,
        ...(manifest.lastRestoredAt === undefined ? {} : { lastRestoredAt: manifest.lastRestoredAt }),
        ...(manifest.repository.head === undefined ? {} : { head: manifest.repository.head }),
        ...(manifest.repository.branch === undefined ? {} : { branch: manifest.repository.branch }),
        ...(manifest.repository.operation === undefined ? {} : { operation: manifest.repository.operation }),
        stagedPathCount: manifest.repository.stagedPaths.length,
        ...(manifest.version === 2 ? { trust: manifest.git.trust } : {}),
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
function assertJournalMatchesManifest(journal, manifest) {
    if (manifest.version !== 2
        || manifest.workspace !== journal.workspace
        || manifest.id !== journal.restorePointId
        || manifest.repository.commonDir !== journal.commonDir
        || manifest.git.storeId !== journal.storeId
        || manifest.git.worktreeId !== journal.worktreeId
        || manifest.git.ref !== journal.ref
        || manifest.git.commit !== journal.commit) {
        throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint journal does not match restore point ${journal.restorePointId}`);
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
function checkpointMode(value) {
    if (value !== 'off' && value !== 'git-native' && value !== 'legacy') {
        throw new ChangeLedgerError('INVALID_CONFIG', 'turnCheckpointMode must be off, git-native, or legacy');
    }
    return value;
}
function checkpointTrust(value) {
    if (value !== 'fast' && value !== 'strict') {
        throw new ChangeLedgerError('INVALID_CONFIG', 'turnCheckpointTrust must be fast or strict');
    }
    return value;
}
function throwIfAborted(signal) {
    if (signal?.aborted === true)
        throw signal.reason;
}
async function waitWithSignal(promise, signal) {
    if (signal === undefined)
        return promise;
    signal.throwIfAborted();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort?.(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await Promise.race([promise, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function checkpointDeadlineError(error, timeoutMs, deadline, callerSignal) {
    if (callerSignal?.aborted !== true && deadline.aborted) {
        return new ChangeLedgerError('TURN_CHECKPOINT_TIMEOUT', `automatic checkpoint exceeded ${timeoutMs} ms`, { cause: error });
    }
    return error;
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
