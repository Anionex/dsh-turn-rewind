import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { ChangeLedgerError, errorMessage } from './errors.js'
import { isNodeError, pathExists, processExists, readJson, syncDirectory, writeJsonAtomic } from './path-utils.js'
import type { ResolvedChangeLedgerConfig, RestoreOperation, RestorePointManifest, RestorePointManifestV2 } from './types.js'
import { parseManifest, parseOperation, validateBlobHash, validateOperationId, validateRestorePointId } from './validate.js'

interface LockRecord {
  readonly pid: number
  readonly hostId?: string
  readonly createdAt: number
  readonly nonce: string
}

interface LockLease {
  relocate(path: string): void
  release(): Promise<void>
}

interface LockReclaimJournal {
  readonly version: 1
  readonly staleNonce: string
  readonly createdAt: number
}

interface LockReclaimOwner {
  readonly version: 1
  readonly pid: number
  readonly hostId: string
  readonly createdAt: number
  readonly nonce: string
}

let hostIdValue: string | undefined

export interface GitCheckpointJournal {
  readonly version: 1
  readonly action: 'publish' | 'delete'
  readonly storeId: string
  readonly workspace: string
  readonly commonDir: string
  readonly worktreeId: string
  readonly restorePointId: string
  readonly ref: string
  readonly commit: string
  readonly createdAt: number
}

interface WorkspaceBinding {
  readonly version: 1
  readonly workspace: string
  readonly commonDir: string
  readonly gitDir: string
  readonly worktreeId: string
}

interface WorkspaceRebindJournal {
  readonly version: 1
  readonly previousWorkspace: string
  readonly currentWorkspace: string
  readonly commonDir: string
  readonly worktreeId: string
}

interface WorkspaceMigrationJournal {
  readonly version: 1
  readonly workspace: string
  readonly legacyKey: string
  readonly targetKey: string
  readonly commonDir: string
  readonly gitDir: string
  readonly worktreeId: string
}

interface WorktreeClaim {
  readonly version: 1
  readonly worktreeId: string
  readonly workspaceKey: string
  readonly commonDir: string
  readonly gitDir: string
}

export interface TurnCheckpointSkip {
  readonly version: 1
  readonly sessionId: string
  readonly turn: number
  readonly turnStartSeq: number
  readonly reason: string
  readonly createdAt: number
}

interface SnapshotCleanupJournal {
  readonly version: 1
  readonly workspace: string
}

/** Durable content-addressed storage and per-workspace locking. */
export class LedgerStore {
  private readonly workspaceKeys = new Map<string, string>()
  private storeIdValue: string | undefined

  constructor(readonly config: ResolvedChangeLedgerConfig) {}

  /** Create the state root and reconcile crash-interrupted operations. */
  async initialize(): Promise<number> {
    this.storeIdValue = await ensureStoreId(this.config.storageDir)
    const workspacesDir = join(this.config.storageDir, 'workspaces')
    await mkdir(workspacesDir, { recursive: true, mode: 0o700 })
    let reconciled = await this.reconcileWorkspaceMigrations(workspacesDir)
    const workspaceKeys = await safeDirectoryNames(workspacesDir)
    for (const workspaceKey of workspaceKeys) {
      const workspaceDir = join(this.config.storageDir, 'workspaces', workspaceKey)
      let lease: LockLease
      try {
        lease = await this.acquireOne(join(workspaceDir, 'lock.json'), workspaceKey, false, true)
      } catch (error) {
        if (error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED') continue
        throw error
      }
      try {
        await this.completeWorkspaceRebind(workspaceDir, workspaceKey)
        const binding = await readWorkspaceBinding(workspaceDir, workspaceKey)
        if (binding !== undefined) this.workspaceKeys.set(binding.workspace, workspaceKey)
        const operationDir = join(workspaceDir, 'operations')
        for (const filename of await safeJsonNames(operationDir)) {
          const path = join(operationDir, filename)
          const operation = parseOperation(await readJson(path))
          if (filename !== `${operation.id}.json`) {
            throw new ChangeLedgerError('STATE_CORRUPT', `operation ${filename} does not match its persisted id ${operation.id}`)
          }
          if (this.workspaceDir(operation.workspace) !== workspaceDir) {
            throw new ChangeLedgerError('STATE_CORRUPT', `operation ${filename} is stored under the wrong workspace key`)
          }
          if (operation.state !== 'running' && operation.state !== 'rollback-running') continue
          await this.writeOperation({
            ...operation,
            state: 'interrupted',
            error: operation.error ?? 'DSH stopped before the restore operation reached a terminal state',
          })
          reconciled += 1
        }
        const cleanup = await readSnapshotCleanupJournal(workspaceDir)
        if (cleanup !== undefined) {
          if (this.workspaceDir(cleanup.workspace) !== workspaceDir) {
            throw new ChangeLedgerError('STATE_CORRUPT', 'snapshot cleanup journal is stored under the wrong workspace key')
          }
          await this.reconcileSnapshotCleanup(cleanup.workspace)
          reconciled += 1
        }
      } finally {
        await lease.release()
      }
    }
    return reconciled
  }

  /** Durable owner of this storage root's private Git namespace. */
  get storeId(): string {
    if (this.storeIdValue === undefined) throw new ChangeLedgerError('STATE_READ_FAILED', 'store is not initialized')
    return this.storeIdValue
  }

  /** Acquire the exclusive lock for one canonical workspace. */
  async acquire(
    workspace: string,
    sharedLockPath?: string,
    binding?: { readonly commonDir: string; readonly gitDir: string; readonly worktreeId: string },
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    throwIfAborted(signal)
    const sharedLease = sharedLockPath === undefined
      ? undefined
      : await this.acquireOne(sharedLockPath, workspace, true, true, signal)
    let localLease: LockLease | undefined
    try {
      throwIfAborted(signal)
      localLease = binding === undefined
        ? await this.acquireOne(join(this.workspaceDir(workspace), 'lock.json'), workspace, false, true, signal)
        : await this.bindGitWorkspace(workspace, binding.commonDir, binding.gitDir, binding.worktreeId, signal)
      const acquiredLocalLease = localLease
      return async () => {
        let releaseError: unknown
        try {
          await acquiredLocalLease.release()
        } catch (error) {
          releaseError = error
        }
        try {
          await sharedLease?.release()
        } catch (error) {
          if (releaseError === undefined) releaseError = error
        }
        if (releaseError !== undefined) throw releaseError
      }
    } catch (error) {
      await localLease?.release()
      await sharedLease?.release()
      throw error
    }
  }

  private async acquireOne(
    initialLockPath: string,
    workspace: string,
    shared: boolean,
    reclaim = true,
    signal?: AbortSignal,
  ): Promise<LockLease> {
    throwIfAborted(signal)
    const ownerHostId = hostIdentity()
    let lockPath = initialLockPath
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    const record: LockRecord = { pid: process.pid, hostId: ownerHostId, createdAt: Date.now(), nonce }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfAborted(signal)
      const reclaimResult = await this.completeLockReclaims(lockPath, record, shared, reclaim)
      let acquired = reclaimResult === 'acquired'
      if (reclaimResult === 'busy') {
        throw new ChangeLedgerError('WORKSPACE_LOCKED', `another change-ledger operation owns ${JSON.stringify(workspace)}`)
      }
      if (!acquired) acquired = await publishExclusiveFile(lockPath, `${JSON.stringify(record)}\n`)
      if (!acquired) {
        if (!reclaim) throw new ChangeLedgerError('WORKSPACE_LOCKED', `another change-ledger operation owns ${JSON.stringify(workspace)}`)
        if (await this.prepareLockReclaim(lockPath, shared)) continue
        throw new ChangeLedgerError('WORKSPACE_LOCKED', `another change-ledger operation owns ${JSON.stringify(workspace)}`)
      }
      let released = false
      return {
        relocate(path: string) {
          if (released) throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'cannot relocate a released workspace lock')
          lockPath = path
        },
        async release() {
          if (released) return
          released = true
          try {
            const current = parseLock(await readJson(lockPath))
            if (current.nonce !== nonce) return
            await unlink(lockPath)
            await syncDirectory(dirname(lockPath))
          } catch (error) {
            if (!isNodeError(error, 'ENOENT') && !isMissingStateRead(error)) throw error
          }
        },
      }
    }
    throw new ChangeLedgerError('WORKSPACE_LOCKED', `could not acquire change-ledger lock for ${JSON.stringify(workspace)}`)
  }

  /** Persist a blob if it is not already present, and verify existing content. */
  async putBlob(workspace: string, hash: string, content: Buffer): Promise<void> {
    validateBlobHash(hash)
    const contentHash = createHash('sha256').update(content).digest('hex')
    if (contentHash !== hash) {
      throw new ChangeLedgerError('BLOB_HASH_MISMATCH', `refusing to store content whose SHA-256 does not match ${hash}`)
    }
    const path = this.blobPath(workspace, hash)
    const directory = join(this.workspaceDir(workspace), 'blobs', hash.slice(0, 2))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(content)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await link(temporary, path)
        await syncDirectory(directory)
        return
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
      }
    } finally {
      try {
        await unlink(temporary)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
    const existing = await readFile(path)
    const existingHash = createHash('sha256').update(existing).digest('hex')
    if (existingHash !== hash || !existing.equals(content)) {
      throw new ChangeLedgerError('BLOB_COLLISION', `stored blob ${hash} does not match its content hash`)
    }
  }

  /** Read and verify one content-addressed blob. */
  async readBlob(workspace: string, hash: string): Promise<Buffer> {
    validateBlobHash(hash)
    const content = await readFile(this.blobPath(workspace, hash))
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== hash) throw new ChangeLedgerError('BLOB_CORRUPT', `blob ${hash} failed SHA-256 verification`)
    return content
  }

  /** Write one restore-point manifest atomically. */
  async writeManifest(manifest: RestorePointManifest): Promise<void> {
    const parsed = parseManifest(manifest)
    this.assertManifestOwned(parsed)
    await this.assertManifestWorkspaceIdentity(parsed, this.workspaceDir(manifest.workspace))
    await writeJsonAtomic(this.manifestPath(manifest.workspace, manifest.id), manifest)
  }

  /** Load and validate one restore-point manifest. */
  async readManifest(workspace: string, id: string): Promise<RestorePointManifest> {
    validateRestorePointId(id)
    let raw: unknown
    try {
      raw = await readJson(this.manifestPath(workspace, id))
    } catch (error) {
      if (isMissingStateRead(error)) {
        throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `restore point ${id} does not exist`, { cause: error })
      }
      throw error
    }
    const manifest = parseManifest(raw)
    this.assertManifestOwned(manifest)
    await this.assertManifestWorkspaceIdentity(manifest, this.workspaceDir(workspace))
    if (manifest.id !== id) {
      throw new ChangeLedgerError('STATE_CORRUPT', `restore point file ${id}.json contains id ${manifest.id}`)
    }
    if (manifest.workspace !== workspace) {
      throw new ChangeLedgerError('STATE_CORRUPT', `restore point ${id} belongs to a different workspace`)
    }
    return manifest
  }

  /** List all validated restore points for one workspace, newest first. */
  async listManifests(workspace: string, signal?: AbortSignal): Promise<RestorePointManifest[]> {
    const manifests = await this.listManifestsInDir(this.workspaceDir(workspace), signal)
    for (const manifest of manifests) {
      if (manifest.workspace !== workspace) {
        throw new ChangeLedgerError('STATE_CORRUPT', `manifest ${manifest.id} belongs to a different workspace`)
      }
    }
    return manifests
  }

  /** List validated manifests directly from one storage directory, newest first. */
  async listManifestsInDir(workspaceDir: string, signal?: AbortSignal): Promise<RestorePointManifest[]> {
    const manifests: RestorePointManifest[] = []
    for (const filename of await safeJsonNames(join(workspaceDir, 'manifests'))) {
      throwIfAborted(signal)
      const manifest = parseManifest(await readJson(join(workspaceDir, 'manifests', filename)))
      this.assertManifestOwned(manifest)
      await this.assertManifestWorkspaceIdentity(manifest, workspaceDir)
      if (filename !== `${manifest.id}.json`) {
        throw new ChangeLedgerError('STATE_CORRUPT', `manifest ${filename} does not match its persisted id ${manifest.id}`)
      }
      manifests.push(manifest)
    }
    return manifests.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  /** Delete one restore-point manifest. Blobs remain until garbage collection succeeds. */
  async deleteManifest(workspace: string, id: string): Promise<void> {
    await this.deleteManifestInDir(this.workspaceDir(workspace), id)
  }

  /** Delete one restore-point manifest directly from its storage directory. */
  async deleteManifestInDir(workspaceDir: string, id: string): Promise<void> {
    validateRestorePointId(id)
    const directory = join(workspaceDir, 'manifests')
    try {
      await unlink(join(directory, `${id}.json`))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `restore point ${id} does not exist`)
      }
      throw error
    }
    await syncDirectory(directory)
  }

  /** Persist the intent needed to finish or roll back a Git ref/manifest transition after a crash. */
  async writeGitCheckpointJournal(action: GitCheckpointJournal['action'], manifest: RestorePointManifestV2): Promise<void> {
    this.assertManifestOwned(manifest)
    await this.assertManifestWorkspaceIdentity(manifest, this.workspaceDir(manifest.workspace))
    const journal: GitCheckpointJournal = {
      version: 1,
      action,
      storeId: manifest.git.storeId,
      workspace: manifest.workspace,
      commonDir: manifest.repository.commonDir,
      worktreeId: manifest.git.worktreeId,
      restorePointId: manifest.id,
      ref: manifest.git.ref,
      commit: manifest.git.commit,
      createdAt: Date.now(),
    }
    this.assertGitCheckpointJournalOwned(parseGitCheckpointJournal(journal))
    await writeJsonAtomic(this.gitCheckpointJournalPath(manifest.workspace, manifest.id), journal)
  }

  /** List every persisted workspace directory under this storage root. */
  async listWorkspaceDirs(signal?: AbortSignal): Promise<string[]> {
    const root = join(this.config.storageDir, 'workspaces')
    const dirs: string[] = []
    for (const key of await safeDirectoryNames(root)) {
      throwIfAborted(signal)
      dirs.push(join(root, key))
    }
    return dirs
  }

  /** List every pending Git checkpoint transition across this storage root. */
  async listGitCheckpointJournals(): Promise<GitCheckpointJournal[]> {
    const journals: GitCheckpointJournal[] = []
    for (const workspaceKey of await safeDirectoryNames(join(this.config.storageDir, 'workspaces'))) {
      const workspaceDir = join(this.config.storageDir, 'workspaces', workspaceKey)
      for (const journal of await this.listGitCheckpointJournalsInDir(workspaceDir)) {
        if (this.workspaceDir(journal.workspace) !== workspaceDir) {
          throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint journal ${journal.restorePointId}.json is stored under the wrong workspace key`)
        }
        journals.push(journal)
      }
    }
    return journals.sort((left, right) => left.createdAt - right.createdAt || left.restorePointId.localeCompare(right.restorePointId))
  }

  /** List pending Git checkpoint transitions directly from one storage directory. */
  async listGitCheckpointJournalsInDir(workspaceDir: string, signal?: AbortSignal): Promise<GitCheckpointJournal[]> {
    const journals: GitCheckpointJournal[] = []
    for (const filename of await safeJsonNames(join(workspaceDir, 'git-journals'))) {
      throwIfAborted(signal)
      const journal = parseGitCheckpointJournal(await readJson(join(workspaceDir, 'git-journals', filename)))
      this.assertGitCheckpointJournalOwned(journal)
      await this.assertGitCheckpointJournalWorkspaceIdentity(journal, workspaceDir)
      if (filename !== `${journal.restorePointId}.json`) {
        throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint journal ${filename} does not match its restore-point id`)
      }
      journals.push(journal)
    }
    return journals
  }

  /** Remove one completed Git checkpoint transition journal. */
  async deleteGitCheckpointJournal(workspace: string, id: string): Promise<void> {
    validateRestorePointId(id)
    const path = this.gitCheckpointJournalPath(workspace, id)
    try {
      await unlink(path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    await syncDirectory(dirname(path))
  }

  /** Persist one explicit automatic-checkpoint skip so the UI survives restarts. */
  async writeTurnCheckpointSkip(workspace: string, skip: TurnCheckpointSkip): Promise<void> {
    parseTurnCheckpointSkip(skip)
    await writeJsonAtomic(this.turnCheckpointSkipPath(workspace, skip.sessionId, skip.turn, skip.turnStartSeq), skip)
  }

  /** Read one durable automatic-checkpoint skip. */
  async readTurnCheckpointSkip(
    workspace: string,
    sessionId: string,
    turn: number,
    turnStartSeq: number,
  ): Promise<TurnCheckpointSkip | undefined> {
    const path = this.turnCheckpointSkipPath(workspace, sessionId, turn, turnStartSeq)
    try {
      const skip = parseTurnCheckpointSkip(await readJson(path))
      if (skip.sessionId !== sessionId || skip.turn !== turn || skip.turnStartSeq !== turnStartSeq) {
        throw new ChangeLedgerError('STATE_CORRUPT', 'turn checkpoint skip is stored under the wrong key')
      }
      return skip
    } catch (error) {
      if (isMissingStateRead(error)) return undefined
      throw error
    }
  }

  /** Remove a stale skip after the same turn obtains a ready checkpoint. */
  async deleteTurnCheckpointSkip(workspace: string, sessionId: string, turn: number, turnStartSeq: number): Promise<void> {
    const path = this.turnCheckpointSkipPath(workspace, sessionId, turn, turnStartSeq)
    try {
      await unlink(path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    await syncDirectory(dirname(path))
  }

  /** Mark a legacy capture whose unreferenced blobs need crash recovery. */
  async writeSnapshotCleanup(workspace: string): Promise<void> {
    await writeJsonAtomic(join(this.workspaceDir(workspace), 'snapshot-cleanup.json'), { version: 1, workspace })
  }

  /** Clear a completed legacy-capture cleanup marker. */
  async deleteSnapshotCleanup(workspace: string): Promise<void> {
    const path = join(this.workspaceDir(workspace), 'snapshot-cleanup.json')
    try {
      await unlink(path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    await syncDirectory(dirname(path))
  }

  /** Persist one restore-operation journal. */
  async writeOperation(operation: RestoreOperation): Promise<void> {
    parseOperation(operation)
    await writeJsonAtomic(this.operationPath(operation.workspace, operation.id), operation)
  }

  /** List validated restore operations for one workspace. */
  async listOperations(workspace: string): Promise<RestoreOperation[]> {
    const operations = await this.listOperationsInDir(this.workspaceDir(workspace))
    for (const operation of operations) {
      if (operation.workspace !== workspace) {
        throw new ChangeLedgerError('STATE_CORRUPT', `operation ${operation.id} belongs to a different workspace`)
      }
    }
    return operations
  }

  /** List validated restore operations directly from one storage directory. */
  async listOperationsInDir(workspaceDir: string, signal?: AbortSignal): Promise<RestoreOperation[]> {
    const operations: RestoreOperation[] = []
    for (const filename of await safeJsonNames(join(workspaceDir, 'operations'))) {
      throwIfAborted(signal)
      const operation = parseOperation(await readJson(join(workspaceDir, 'operations', filename)))
      if (filename !== `${operation.id}.json`) {
        throw new ChangeLedgerError('STATE_CORRUPT', `operation ${filename} does not match its persisted id ${operation.id}`)
      }
      operations.push(operation)
    }
    return operations.sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id))
  }

  /** Return whether an incomplete operation still references a restore point. */
  async isReferencedByRecovery(workspace: string, restorePointId: string): Promise<boolean> {
    return (await this.listOperations(workspace)).some((operation) =>
      (operation.state === 'interrupted' || operation.state === 'recovery-required')
      && (operation.restorePointId === restorePointId || operation.rescuePointId === restorePointId))
  }

  /** Delete blobs not referenced by any remaining manifest. */
  async collectGarbage(
    workspace: string,
    additionalReferenced: Iterable<string> = [],
    signal?: AbortSignal,
  ): Promise<{ deletedBlobs: number; retainedBlobs: number }> {
    const referenced = new Set<string>(additionalReferenced)
    for (const hash of referenced) validateBlobHash(hash)
    for (const manifest of await this.listManifestsInDir(this.workspaceDir(workspace), signal)) {
      throwIfAborted(signal)
      for (const entry of Object.values(manifest.entries)) {
        if (entry.kind === 'file' && entry.provider !== 'git') referenced.add(entry.blob)
      }
    }
    return this.sweepBlobs(this.workspaceDir(workspace), referenced, signal)
  }

  /** Delete blobs under one storage directory that no manifest in it references. */
  async collectGarbageInDir(
    workspaceDir: string,
    signal?: AbortSignal,
  ): Promise<{ deletedBlobs: number; retainedBlobs: number }> {
    const referenced = new Set<string>()
    for (const manifest of await this.listManifestsInDir(workspaceDir, signal)) {
      throwIfAborted(signal)
      for (const entry of Object.values(manifest.entries)) {
        if (entry.kind === 'file' && entry.provider !== 'git') referenced.add(entry.blob)
      }
    }
    return this.sweepBlobs(workspaceDir, referenced, signal)
  }

  /** Remove every persisted automatic-checkpoint skip marker under one storage directory. */
  async clearTurnOutcomesInDir(workspaceDir: string): Promise<number> {
    let removed = 0
    for (const filename of await safeJsonNames(join(workspaceDir, 'turn-outcomes'))) {
      await unlink(join(workspaceDir, 'turn-outcomes', filename))
      removed += 1
    }
    return removed
  }

  private async sweepBlobs(
    workspaceDir: string,
    referenced: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<{ deletedBlobs: number; retainedBlobs: number }> {
    let deletedBlobs = 0
    let retainedBlobs = 0
    const blobsRoot = join(workspaceDir, 'blobs')
    for (const prefix of await safeDirectoryNames(blobsRoot)) {
      throwIfAborted(signal)
      const prefixPath = join(blobsRoot, prefix)
      for (const filename of await safeFileNames(prefixPath)) {
        throwIfAborted(signal)
        if (filename.startsWith('.') && filename.endsWith('.tmp')) {
          await unlink(join(prefixPath, filename))
          deletedBlobs += 1
          continue
        }
        validateBlobHash(filename)
        if (filename.slice(0, 2) !== prefix) {
          throw new ChangeLedgerError('STATE_CORRUPT', `blob ${filename} is stored under the wrong prefix directory ${prefix}`)
        }
        if (referenced.has(filename)) {
          retainedBlobs += 1
          continue
        }
        await unlink(join(prefixPath, filename))
        deletedBlobs += 1
      }
      try {
        await rmdir(prefixPath)
      } catch (error) {
        if (!isNodeError(error, 'ENOTEMPTY') && !isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOENT')) throw error
      }
    }
    return { deletedBlobs, retainedBlobs }
  }

  /** Finish a prior bounded legacy capture's orphan cleanup, if one is pending. */
  async reconcileSnapshotCleanup(workspace: string, signal?: AbortSignal): Promise<boolean> {
    const cleanup = await readSnapshotCleanupJournal(this.workspaceDir(workspace))
    if (cleanup === undefined) return false
    if (cleanup.workspace !== workspace) {
      throw new ChangeLedgerError('STATE_CORRUPT', 'snapshot cleanup journal belongs to a different workspace')
    }
    await this.collectGarbage(workspace, [], signal)
    throwIfAborted(signal)
    await this.deleteSnapshotCleanup(workspace)
    return true
  }

  private workspaceDir(workspace: string): string {
    const key = this.workspaceKeys.get(workspace) ?? createHash('sha256').update(workspace).digest('hex')
    return join(this.config.storageDir, 'workspaces', key)
  }

  private assertManifestOwned(manifest: RestorePointManifest): void {
    if (manifest.version === 2 && manifest.git.storeId !== this.storeId) {
      throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint ${manifest.id} belongs to a different storage root`)
    }
  }

  private assertGitCheckpointJournalOwned(journal: GitCheckpointJournal): void {
    if (journal.storeId !== this.storeId) {
      throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint journal ${journal.restorePointId} belongs to a different storage root`)
    }
  }

  private async assertManifestWorkspaceIdentity(
    manifest: RestorePointManifest,
    workspaceDir: string,
    allowMovedWorkspace = false,
  ): Promise<void> {
    if (manifest.version !== 2) return
    const binding = await readWorkspaceBinding(workspaceDir, basename(workspaceDir))
    if (binding === undefined
      || binding.commonDir !== manifest.repository.commonDir
      || binding.worktreeId !== manifest.git.worktreeId
      || (!allowMovedWorkspace && binding.workspace !== manifest.workspace)) {
      throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint ${manifest.id} does not match its workspace binding`)
    }
  }

  private async assertGitCheckpointJournalWorkspaceIdentity(
    journal: GitCheckpointJournal,
    workspaceDir: string,
    allowMovedWorkspace = false,
  ): Promise<void> {
    const binding = await readWorkspaceBinding(workspaceDir, basename(workspaceDir))
    if (binding === undefined
      || binding.commonDir !== journal.commonDir
      || binding.worktreeId !== journal.worktreeId
      || (!allowMovedWorkspace && binding.workspace !== journal.workspace)) {
      throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint journal ${journal.restorePointId} does not match its workspace binding`)
    }
  }

  private manifestPath(workspace: string, id: string): string {
    return join(this.workspaceDir(workspace), 'manifests', `${validateRestorePointId(id)}.json`)
  }

  private operationPath(workspace: string, id: string): string {
    return join(this.workspaceDir(workspace), 'operations', `${validateOperationId(id)}.json`)
  }

  private gitCheckpointJournalPath(workspace: string, id: string): string {
    return join(this.workspaceDir(workspace), 'git-journals', `${validateRestorePointId(id)}.json`)
  }

  private turnCheckpointSkipPath(workspace: string, sessionId: string, turn: number, turnStartSeq: number): string {
    const key = createHash('sha256').update(`${sessionId}\0${turn}\0${turnStartSeq}`).digest('hex')
    return join(this.workspaceDir(workspace), 'turn-outcomes', `${key}.json`)
  }

  private blobPath(workspace: string, hash: string): string {
    validateBlobHash(hash)
    return join(this.workspaceDir(workspace), 'blobs', hash.slice(0, 2), hash)
  }

  private async bindGitWorkspace(
    workspace: string,
    commonDir: string,
    gitDir: string,
    worktreeId: string,
    signal?: AbortSignal,
  ): Promise<LockLease> {
    throwIfAborted(signal)
    const workspaceKey = gitWorkspaceKey(commonDir, worktreeId)
    const workspacesDir = join(this.config.storageDir, 'workspaces')
    const knownWorkspaceKey = this.workspaceKeys.get(workspace)
    if (knownWorkspaceKey !== undefined && knownWorkspaceKey !== workspaceKey) {
      throw new ChangeLedgerError('STATE_CORRUPT', `Git worktree identity changed for ${JSON.stringify(workspace)}`)
    }
    await this.assertNoUnresolvedWorkspaceOwnership(workspacesDir, commonDir, gitDir, worktreeId, workspaceKey)
    await this.completeWorkspaceMigration(workspacesDir, workspaceKey, signal)
    const targetDir = join(workspacesDir, workspaceKey)
    const legacyKey = createHash('sha256').update(workspace).digest('hex')
    const legacyDir = join(workspacesDir, legacyKey)
    const targetExists = await pathExists(targetDir)
    const legacyExists = legacyDir !== targetDir && await pathExists(legacyDir)
    if (targetExists && legacyExists) {
      throw new ChangeLedgerError('STATE_CORRUPT', `both legacy and durable state directories exist for ${JSON.stringify(workspace)}`)
    }
    let localLease: LockLease
    let migratedLegacy = false
    if (legacyExists) {
      localLease = await this.acquireOne(join(legacyDir, 'lock.json'), workspace, false, false, signal)
      try {
        throwIfAborted(signal)
        await this.ensureWorktreeClaim(commonDir, gitDir, worktreeId, workspaceKey)
        const migration: WorkspaceMigrationJournal = {
          version: 1,
          workspace,
          legacyKey,
          targetKey: workspaceKey,
          commonDir,
          gitDir,
          worktreeId,
        }
        await writeJsonAtomic(workspaceMigrationPath(workspacesDir, workspaceKey), migration)
        await rename(legacyDir, targetDir)
        localLease.relocate(join(targetDir, 'lock.json'))
        await syncDirectory(workspacesDir)
        migratedLegacy = true
      } catch (error) {
        await localLease.release()
        throw error
      }
    } else if (targetExists) {
      localLease = await this.acquireOne(join(targetDir, 'lock.json'), workspace, false, true, signal)
      try {
        await this.ensureWorktreeClaim(commonDir, gitDir, worktreeId, workspaceKey)
      } catch (error) {
        await localLease.release()
        throw error
      }
    } else {
      await this.ensureWorktreeClaim(commonDir, gitDir, worktreeId, workspaceKey)
      await mkdir(targetDir, { recursive: true, mode: 0o700 })
      localLease = await this.acquireOne(join(targetDir, 'lock.json'), workspace, false, true, signal)
    }
    try {
      throwIfAborted(signal)
      await this.completeWorkspaceRebind(targetDir, workspaceKey, signal)
      const existing = await readWorkspaceBinding(targetDir, workspaceKey)
      if (existing !== undefined
        && (existing.commonDir !== commonDir || existing.gitDir !== gitDir || existing.worktreeId !== worktreeId)) {
        throw new ChangeLedgerError('STATE_CORRUPT', `workspace binding identity changed for ${JSON.stringify(workspace)}`)
      }
      const previousWorkspace = existing?.workspace
      if (previousWorkspace !== undefined && previousWorkspace !== workspace) {
        const journal: WorkspaceRebindJournal = {
          version: 1,
          previousWorkspace,
          currentWorkspace: workspace,
          commonDir,
          worktreeId,
        }
        await writeJsonAtomic(join(targetDir, 'workspace-rebind.json'), journal)
        await this.completeWorkspaceRebind(targetDir, workspaceKey, signal)
        this.workspaceKeys.delete(previousWorkspace)
      } else if (existing === undefined) {
        const binding: WorkspaceBinding = { version: 1, workspace, commonDir, gitDir, worktreeId }
        await writeJsonAtomic(join(targetDir, 'workspace-binding.json'), binding)
      }
      this.workspaceKeys.set(workspace, workspaceKey)
      if (migratedLegacy) await deleteWorkspaceMigration(workspacesDir, workspaceKey)
      return localLease
    } catch (error) {
      await localLease.release()
      throw error
    }
  }

  private async reconcileWorkspaceMigrations(workspacesDir: string): Promise<number> {
    let reconciled = 0
    for (const workspaceKey of await workspaceMigrationKeys(workspacesDir)) {
      if (await this.completeWorkspaceMigration(workspacesDir, workspaceKey, undefined, true)) reconciled += 1
    }
    return reconciled
  }

  private async completeWorkspaceMigration(
    workspacesDir: string,
    workspaceKey: string,
    signal?: AbortSignal,
    skipLocked = false,
  ): Promise<boolean> {
    const journal = await readWorkspaceMigrationJournal(workspacesDir, workspaceKey)
    if (journal === undefined) return false
    const legacyDir = join(workspacesDir, journal.legacyKey)
    const targetDir = join(workspacesDir, journal.targetKey)
    const legacyExists = await pathExists(legacyDir)
    const targetExists = await pathExists(targetDir)
    if (legacyExists && targetExists) {
      throw new ChangeLedgerError('STATE_CORRUPT', `both source and target exist for workspace migration ${workspaceKey}`)
    }
    if (!legacyExists && !targetExists) {
      throw new ChangeLedgerError('STATE_CORRUPT', `workspace migration ${workspaceKey} has no source or target directory`)
    }
    const activeDir = legacyExists ? legacyDir : targetDir
    let lease: LockLease
    try {
      lease = await this.acquireOne(join(activeDir, 'lock.json'), journal.workspace, false, true, signal)
    } catch (error) {
      if (error instanceof ChangeLedgerError && error.code === 'WORKSPACE_LOCKED' && skipLocked) return false
      throw error
    }
    try {
      throwIfAborted(signal)
      await this.assertNoUnresolvedWorkspaceOwnership(
        workspacesDir,
        journal.commonDir,
        journal.gitDir,
        journal.worktreeId,
        journal.targetKey,
      )
      await this.ensureWorktreeClaim(journal.commonDir, journal.gitDir, journal.worktreeId, journal.targetKey)
      if (legacyExists) {
        await rename(legacyDir, targetDir)
        lease.relocate(join(targetDir, 'lock.json'))
        await syncDirectory(workspacesDir)
      }
      await writeJsonAtomic(join(targetDir, 'workspace-binding.json'), {
        version: 1,
        workspace: journal.workspace,
        commonDir: journal.commonDir,
        gitDir: journal.gitDir,
        worktreeId: journal.worktreeId,
      } satisfies WorkspaceBinding)
      await deleteWorkspaceMigration(workspacesDir, workspaceKey)
      return true
    } finally {
      await lease.release()
    }
  }

  private async assertNoUnresolvedWorkspaceOwnership(
    workspacesDir: string,
    commonDir: string,
    gitDir: string,
    worktreeId: string,
    currentWorkspaceKey: string,
  ): Promise<void> {
    const claimsDir = join(this.config.storageDir, 'worktree-claims')
    for (const claimedWorktreeId of await worktreeClaimIds(claimsDir)) {
      const claim = await readWorktreeClaim(claimsDir, claimedWorktreeId)
      if (claim === undefined) continue
      if (claimedWorktreeId === worktreeId) {
        if (claim.workspaceKey !== currentWorkspaceKey || claim.commonDir !== commonDir || claim.gitDir !== gitDir) {
          throw new ChangeLedgerError(
            'STATE_CORRUPT',
            `worktree identity ${JSON.stringify(worktreeId)} is already claimed by another repository namespace`,
          )
        }
        continue
      }
      if (claim.commonDir === commonDir && claim.gitDir === gitDir) {
        throw new ChangeLedgerError(
          'STATE_CORRUPT',
          `cannot create a new worktree identity while a durable claim still owns Git directory ${JSON.stringify(gitDir)}`,
        )
      }
    }
    for (const workspaceKey of await safeDirectoryNames(workspacesDir)) {
      const binding = await readWorkspaceBinding(join(workspacesDir, workspaceKey), workspaceKey)
      if (binding === undefined || workspaceKey === currentWorkspaceKey) continue
      if (binding.worktreeId === worktreeId) {
        throw new ChangeLedgerError(
          'STATE_CORRUPT',
          `cannot open a new workspace namespace while historical state still owns worktree identity ${JSON.stringify(worktreeId)}`,
        )
      }
      if (binding.commonDir === commonDir && binding.gitDir === gitDir) {
        throw new ChangeLedgerError(
          'STATE_CORRUPT',
          `cannot create a new worktree identity while historical state still owns Git directory ${JSON.stringify(gitDir)}`,
        )
      }
    }
    for (const workspaceKey of await workspaceMigrationKeys(workspacesDir)) {
      if (workspaceKey === currentWorkspaceKey) continue
      const journal = await readWorkspaceMigrationJournal(workspacesDir, workspaceKey)
      if (journal === undefined) continue
      if (journal.worktreeId === worktreeId) {
        throw new ChangeLedgerError(
          'STATE_CORRUPT',
          `cannot open a new workspace namespace while a migration still owns worktree identity ${JSON.stringify(worktreeId)}`,
        )
      }
      if (journal.commonDir === commonDir && journal.gitDir === gitDir) {
        throw new ChangeLedgerError(
          'STATE_CORRUPT',
          `cannot create a new worktree identity while a migration still owns Git directory ${JSON.stringify(gitDir)}`,
        )
      }
    }
  }

  private async ensureWorktreeClaim(
    commonDir: string,
    gitDir: string,
    worktreeId: string,
    workspaceKey: string,
  ): Promise<void> {
    const claimsDir = join(this.config.storageDir, 'worktree-claims')
    const claimPath = worktreeClaimPath(claimsDir, worktreeId)
    const claim: WorktreeClaim = { version: 1, worktreeId, workspaceKey, commonDir, gitDir }
    if (await publishExclusiveFile(claimPath, `${JSON.stringify(claim, null, 2)}\n`)) return
    const existing = await readWorktreeClaim(claimsDir, worktreeId)
    if (existing === undefined
      || existing.workspaceKey !== workspaceKey
      || existing.commonDir !== commonDir
      || existing.gitDir !== gitDir) {
      throw new ChangeLedgerError(
        'STATE_CORRUPT',
        `worktree identity ${JSON.stringify(worktreeId)} is already claimed by another repository namespace`,
      )
    }
  }

  private async completeWorkspaceRebind(directory: string, workspaceKey: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const journal = await readWorkspaceRebindJournal(directory, workspaceKey)
    if (journal === undefined) return
    const binding = await readWorkspaceBinding(directory, workspaceKey)
    if (binding === undefined
      || binding.commonDir !== journal.commonDir
      || binding.worktreeId !== journal.worktreeId
      || (binding.workspace !== journal.previousWorkspace && binding.workspace !== journal.currentWorkspace)) {
      throw new ChangeLedgerError('STATE_CORRUPT', 'workspace rebind journal does not match its durable binding')
    }
    await this.rewriteWorkspaceRoot(directory, journal.previousWorkspace, journal.currentWorkspace, signal)
    throwIfAborted(signal)
    await writeJsonAtomic(join(directory, 'workspace-binding.json'), {
      version: 1,
      workspace: journal.currentWorkspace,
      commonDir: journal.commonDir,
      gitDir: binding.gitDir,
      worktreeId: journal.worktreeId,
    } satisfies WorkspaceBinding)
    try {
      await unlink(join(directory, 'workspace-rebind.json'))
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    await syncDirectory(directory)
  }

  private async rewriteWorkspaceRoot(directory: string, previous: string, current: string, signal?: AbortSignal): Promise<void> {
    for (const filename of await safeJsonNames(join(directory, 'manifests'))) {
      throwIfAborted(signal)
      const path = join(directory, 'manifests', filename)
      const manifest = parseManifest(await readJson(path))
      this.assertManifestOwned(manifest)
      await this.assertManifestWorkspaceIdentity(manifest, directory, true)
      const isPrevious = manifest.workspace === previous && manifest.repository.root === previous
      const isCurrent = manifest.workspace === current && manifest.repository.root === current
      if (!isPrevious && !isCurrent) {
        throw new ChangeLedgerError('STATE_CORRUPT', `manifest ${filename} cannot be rebound from ${JSON.stringify(previous)}`)
      }
      if (isPrevious) {
        await writeJsonAtomic(path, {
          ...manifest,
          workspace: current,
          repository: { ...manifest.repository, root: current },
        })
      }
    }
    for (const filename of await safeJsonNames(join(directory, 'operations'))) {
      throwIfAborted(signal)
      const path = join(directory, 'operations', filename)
      const operation = parseOperation(await readJson(path))
      if (operation.workspace !== previous && operation.workspace !== current) {
        throw new ChangeLedgerError('STATE_CORRUPT', `operation ${filename} cannot be rebound from ${JSON.stringify(previous)}`)
      }
      if (operation.workspace === previous) await writeJsonAtomic(path, { ...operation, workspace: current })
    }
    for (const filename of await safeJsonNames(join(directory, 'git-journals'))) {
      throwIfAborted(signal)
      const path = join(directory, 'git-journals', filename)
      const journal = parseGitCheckpointJournal(await readJson(path))
      this.assertGitCheckpointJournalOwned(journal)
      await this.assertGitCheckpointJournalWorkspaceIdentity(journal, directory, true)
      if (journal.workspace !== previous && journal.workspace !== current) {
        throw new ChangeLedgerError('STATE_CORRUPT', `Git checkpoint journal ${filename} cannot be rebound from ${JSON.stringify(previous)}`)
      }
      if (journal.workspace === previous) await writeJsonAtomic(path, { ...journal, workspace: current })
    }
    const cleanup = await readSnapshotCleanupJournal(directory)
    if (cleanup !== undefined) {
      if (cleanup.workspace !== previous && cleanup.workspace !== current) {
        throw new ChangeLedgerError('STATE_CORRUPT', `snapshot cleanup journal cannot be rebound from ${JSON.stringify(previous)}`)
      }
      if (cleanup.workspace === previous) {
        await writeJsonAtomic(join(directory, 'snapshot-cleanup.json'), { ...cleanup, workspace: current })
      }
    }
  }

  private async prepareLockReclaim(lockPath: string, shared: boolean): Promise<boolean> {
    let lock: LockRecord
    try {
      lock = parseLock(await readJson(lockPath), !shared)
    } catch (error) {
      if (isMissingStateRead(error)) return true
      throw new ChangeLedgerError(
        'WORKSPACE_LOCK_CORRUPT',
        `${shared ? 'shared workspace' : 'workspace'} lock is unreadable and cannot be safely reclaimed: ${errorMessage(error)}`,
      )
    }
    if (!this.lockIsReclaimable(lock)) return false
    const journal: LockReclaimJournal = { version: 1, staleNonce: lock.nonce, createdAt: Date.now() }
    await publishExclusiveFile(lockReclaimPath(lockPath, lock.nonce), `${JSON.stringify(journal)}\n`)
    return true
  }

  private async completeLockReclaims(
    lockPath: string,
    candidate: LockRecord,
    shared: boolean,
    reclaim: boolean,
  ): Promise<'none' | 'busy' | 'acquired'> {
    const journals = await lockReclaimJournalPaths(lockPath)
    if (journals.length === 0) return 'none'
    if (!reclaim) return 'busy'
    for (const journalPath of journals) {
      let journal: LockReclaimJournal
      try {
        journal = parseLockReclaimJournal(await readJson(journalPath))
      } catch (error) {
        if (isMissingStateRead(error)) continue
        throw error
      }
      let current: LockRecord | undefined
      try {
        current = parseLock(await readJson(lockPath), !shared)
      } catch (error) {
        if (!isMissingStateRead(error)) throw error
      }
      if (current !== undefined && current.nonce !== journal.staleNonce) {
        await deleteLockReclaimState(journalPath, lockPath, journal.staleNonce)
        continue
      }
      if (current !== undefined && !this.lockIsReclaimable(current)) return 'busy'
      if (!await this.acquireLockReclaimOwnership(journalPath, candidate)) return 'busy'
      try {
        current = parseLock(await readJson(lockPath), !shared)
      } catch (error) {
        if (isMissingStateRead(error)) current = undefined
        else throw error
      }
      if (current !== undefined && current.nonce !== journal.staleNonce) {
        await deleteLockReclaimState(journalPath, lockPath, journal.staleNonce)
        continue
      }
      if (current !== undefined && !this.lockIsReclaimable(current)) return 'busy'
      if (current !== undefined) {
        const quarantine = lockQuarantinePath(lockPath, journal.staleNonce)
        try {
          await rename(lockPath, quarantine)
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error
        }
        let moved: LockRecord | undefined
        try {
          moved = parseLock(await readJson(quarantine), !shared)
        } catch (error) {
          if (!isMissingStateRead(error)) throw error
        }
        if (moved !== undefined && moved.nonce !== journal.staleNonce) {
          throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'reclaim ownership changed before stale-lock quarantine')
        }
        try {
          await unlink(quarantine)
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error
        }
        await syncDirectory(dirname(lockPath))
      }
      if (await publishExclusiveFile(lockPath, `${JSON.stringify(candidate)}\n`)) {
        await deleteLockReclaimState(journalPath, lockPath, journal.staleNonce)
        return 'acquired'
      }
    }
    return (await lockReclaimJournalPaths(lockPath)).length === 0 ? 'none' : 'busy'
  }

  private async acquireLockReclaimOwnership(journalPath: string, candidate: LockRecord): Promise<boolean> {
    let parentNonce = 'root'
    for (let depth = 0; depth < 32; depth += 1) {
      const ownerPath = lockReclaimOwnerPath(journalPath, parentNonce)
      let owner: LockReclaimOwner | undefined
      try {
        owner = parseLockReclaimOwner(await readJson(ownerPath))
      } catch (error) {
        if (!isMissingStateRead(error)) throw error
      }
      if (owner === undefined) {
        const next: LockReclaimOwner = {
          version: 1,
          pid: process.pid,
          hostId: hostIdentity(),
          createdAt: Date.now(),
          nonce: candidate.nonce,
        }
        if (await publishExclusiveFile(ownerPath, `${JSON.stringify(next)}\n`)) return true
        continue
      }
      const successorPath = lockReclaimOwnerPath(journalPath, owner.nonce)
      if (await pathExists(successorPath)) {
        parentNonce = owner.nonce
        continue
      }
      if (owner.nonce === candidate.nonce && owner.pid === process.pid && owner.hostId === hostIdentity()) return true
      if (owner.hostId !== hostIdentity()
        || processExists(owner.pid)
        || Date.now() - owner.createdAt < this.config.staleLockMs) return false
      parentNonce = owner.nonce
    }
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'lock reclaim owner chain is too deep')
  }

  private lockIsReclaimable(lock: LockRecord): boolean {
    return lock.hostId !== undefined
      && lock.hostId === hostIdentity()
      && !processExists(lock.pid)
      && Date.now() - lock.createdAt >= this.config.staleLockMs
  }

}

function parseLock(value: unknown, allowLegacy = false): LockRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock must be an object')
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock pid is invalid')
  }
  if (record.hostId !== undefined && (typeof record.hostId !== 'string' || !/^[0-9a-f]{64}$/.test(record.hostId))) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock hostId is invalid')
  }
  if (!allowLegacy && record.hostId === undefined) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock hostId is missing')
  }
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock createdAt is invalid')
  }
  if (typeof record.nonce !== 'string' || record.nonce === '') {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock nonce is invalid')
  }
  return {
    pid: record.pid as number,
    ...(record.hostId === undefined ? {} : { hostId: record.hostId }),
    createdAt: record.createdAt as number,
    nonce: record.nonce,
  }
}

function parseLockReclaimJournal(value: unknown): LockReclaimJournal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'lock reclaim journal must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || typeof record.staleNonce !== 'string'
    || record.staleNonce === ''
    || !Number.isSafeInteger(record.createdAt)
    || (record.createdAt as number) < 0) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'lock reclaim journal is invalid')
  }
  return { version: 1, staleNonce: record.staleNonce, createdAt: record.createdAt as number }
}

function parseLockReclaimOwner(value: unknown): LockReclaimOwner {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'lock reclaim owner must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.hostId !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.hostId)
    || !Number.isSafeInteger(record.createdAt)
    || (record.createdAt as number) < 0
    || typeof record.nonce !== 'string'
    || record.nonce === '') {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'lock reclaim owner is invalid')
  }
  return {
    version: 1,
    pid: record.pid as number,
    hostId: record.hostId,
    createdAt: record.createdAt as number,
    nonce: record.nonce,
  }
}

function lockReclaimPath(lockPath: string, staleNonce: string): string {
  const key = createHash('sha256').update(staleNonce).digest('hex')
  return join(dirname(lockPath), `${basename(lockPath)}.reclaim-${key}.json`)
}

function lockReclaimOwnerPath(journalPath: string, parentNonce: string): string {
  const key = createHash('sha256').update(parentNonce).digest('hex')
  return `${journalPath}.owner-${key}.json`
}

function lockQuarantinePath(lockPath: string, staleNonce: string): string {
  const key = createHash('sha256').update(staleNonce).digest('hex')
  return `${lockPath}.stale-${key}`
}

async function lockReclaimJournalPaths(lockPath: string): Promise<string[]> {
  const directory = dirname(lockPath)
  const prefix = `${basename(lockPath)}.reclaim-`
  const paths: string[] = []
  for (const filename of await safeFileNames(directory)) {
    if (!filename.startsWith(prefix)) continue
    if (filename.includes('.json.owner-')) continue
    const suffix = filename.slice(prefix.length)
    if (!/^[0-9a-f]{64}\.json$/.test(suffix)) {
      throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', `lock reclaim journal filename is invalid: ${filename}`)
    }
    paths.push(join(directory, filename))
  }
  return paths.sort()
}

async function deleteLockReclaimState(journalPath: string, lockPath: string, staleNonce: string): Promise<void> {
  const ownerPrefix = `${basename(journalPath)}.owner-`
  for (const filename of await safeFileNames(dirname(journalPath))) {
    if (!filename.startsWith(ownerPrefix)) continue
    try {
      await unlink(join(dirname(journalPath), filename))
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
  for (const path of [lockQuarantinePath(lockPath, staleNonce), journalPath]) {
    try {
      await unlink(path)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
  await syncDirectory(dirname(journalPath))
}

function hostIdentity(): string {
  if (hostIdValue !== undefined) return hostIdValue
  const configured = process.env.DSH_TURN_REWIND_HOST_ID
  if (configured !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(configured)) {
      throw new ChangeLedgerError('HOST_ID_UNAVAILABLE', 'DSH_TURN_REWIND_HOST_ID must be 64 lowercase hexadecimal characters')
    }
    hostIdValue = configured
    return configured
  }
  let machine = ''
  try {
    if (platform() === 'darwin') {
      const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024,
      })
      machine = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? ''
    } else if (platform() === 'win32') {
      const output = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024,
      })
      machine = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? ''
    } else {
      for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          machine = readFileSync(path, 'utf8').trim()
          if (machine !== '') break
        } catch {
          // Try the next machine-id location.
        }
      }
    }
  } catch {
    // Fall through to the fail-closed check below.
  }
  if (machine === '') {
    throw new ChangeLedgerError(
      'HOST_ID_UNAVAILABLE',
      'a stable operating-system machine identity is unavailable; configure DSH_TURN_REWIND_HOST_ID explicitly',
    )
  }
  hostIdValue = createHash('sha256').update(JSON.stringify({ machine, platform: platform(), arch: arch() })).digest('hex')
  return hostIdValue
}

function parseGitCheckpointJournal(value: unknown): GitCheckpointJournal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || (record.action !== 'publish' && record.action !== 'delete')) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal version or action is invalid')
  }
  if (typeof record.storeId !== 'string' || !/^[0-9a-f]{32}$/.test(record.storeId)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal storeId is invalid')
  }
  if (typeof record.workspace !== 'string' || !isAbsolute(record.workspace)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal workspace is invalid')
  }
  if (typeof record.commonDir !== 'string' || !isAbsolute(record.commonDir)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal commonDir is invalid')
  }
  if (typeof record.worktreeId !== 'string' || !/^[0-9a-f]{32}$/.test(record.worktreeId)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal worktreeId is invalid')
  }
  if (typeof record.restorePointId !== 'string') {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal restore-point id is invalid')
  }
  validateRestorePointId(record.restorePointId)
  if (record.ref !== `refs/dsh-turn-rewind/v2/${record.storeId}/${record.worktreeId}/${record.restorePointId}`) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal ref is invalid')
  }
  if (typeof record.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.commit)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal commit is invalid')
  }
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git checkpoint journal createdAt is invalid')
  }
  return {
    version: 1,
    action: record.action,
    storeId: record.storeId,
    workspace: record.workspace,
    commonDir: record.commonDir,
    worktreeId: record.worktreeId,
    restorePointId: record.restorePointId,
    ref: record.ref,
    commit: record.commit,
    createdAt: record.createdAt as number,
  }
}

function parseTurnCheckpointSkip(value: unknown): TurnCheckpointSkip {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'turn checkpoint skip must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.sessionId !== 'string' || record.sessionId === '') {
    throw new ChangeLedgerError('STATE_CORRUPT', 'turn checkpoint skip identity is invalid')
  }
  if (!Number.isSafeInteger(record.turn) || (record.turn as number) < 0
    || !Number.isSafeInteger(record.turnStartSeq) || (record.turnStartSeq as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'turn checkpoint skip timing metadata is invalid')
  }
  if (typeof record.reason !== 'string' || record.reason === '' || record.reason.length > 2_000) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'turn checkpoint skip reason is invalid')
  }
  return {
    version: 1,
    sessionId: record.sessionId,
    turn: record.turn as number,
    turnStartSeq: record.turnStartSeq as number,
    reason: record.reason,
    createdAt: record.createdAt as number,
  }
}

async function readSnapshotCleanupJournal(directory: string): Promise<SnapshotCleanupJournal | undefined> {
  let value: unknown
  try {
    value = await readJson(join(directory, 'snapshot-cleanup.json'))
  } catch (error) {
    if (isMissingStateRead(error)) return undefined
    throw error
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'snapshot cleanup journal must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.workspace !== 'string' || !isAbsolute(record.workspace)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'snapshot cleanup journal is invalid')
  }
  return { version: 1, workspace: record.workspace }
}

async function readWorkspaceBinding(directory: string, workspaceKey: string): Promise<WorkspaceBinding | undefined> {
  let value: unknown
  try {
    value = await readJson(join(directory, 'workspace-binding.json'))
  } catch (error) {
    if (isMissingStateRead(error)) return undefined
    throw error
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'workspace binding must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || typeof record.workspace !== 'string'
    || !isAbsolute(record.workspace)
    || typeof record.commonDir !== 'string'
    || !isAbsolute(record.commonDir)
    || typeof record.gitDir !== 'string'
    || !isAbsolute(record.gitDir)
    || typeof record.worktreeId !== 'string'
    || !/^[0-9a-f]{32}$/.test(record.worktreeId)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'workspace binding is invalid')
  }
  if (gitWorkspaceKey(record.commonDir, record.worktreeId) !== workspaceKey) {
    throw new ChangeLedgerError('STATE_CORRUPT', `workspace binding is stored under the wrong key ${workspaceKey}`)
  }
  return {
    version: 1,
    workspace: record.workspace,
    commonDir: record.commonDir,
    gitDir: record.gitDir,
    worktreeId: record.worktreeId,
  }
}

async function readWorkspaceRebindJournal(
  directory: string,
  workspaceKey: string,
): Promise<WorkspaceRebindJournal | undefined> {
  let value: unknown
  try {
    value = await readJson(join(directory, 'workspace-rebind.json'))
  } catch (error) {
    if (isMissingStateRead(error)) return undefined
    throw error
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'workspace rebind journal must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || typeof record.previousWorkspace !== 'string'
    || !isAbsolute(record.previousWorkspace)
    || typeof record.currentWorkspace !== 'string'
    || !isAbsolute(record.currentWorkspace)
    || record.previousWorkspace === record.currentWorkspace
    || typeof record.commonDir !== 'string'
    || !isAbsolute(record.commonDir)
    || typeof record.worktreeId !== 'string'
    || !/^[0-9a-f]{32}$/.test(record.worktreeId)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'workspace rebind journal is invalid')
  }
  if (gitWorkspaceKey(record.commonDir, record.worktreeId) !== workspaceKey) {
    throw new ChangeLedgerError('STATE_CORRUPT', `workspace rebind journal is stored under the wrong key ${workspaceKey}`)
  }
  return {
    version: 1,
    previousWorkspace: record.previousWorkspace,
    currentWorkspace: record.currentWorkspace,
    commonDir: record.commonDir,
    worktreeId: record.worktreeId,
  }
}

async function readWorkspaceMigrationJournal(
  workspacesDir: string,
  workspaceKey: string,
): Promise<WorkspaceMigrationJournal | undefined> {
  let value: unknown
  try {
    value = await readJson(workspaceMigrationPath(workspacesDir, workspaceKey))
  } catch (error) {
    if (isMissingStateRead(error)) return undefined
    throw error
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'workspace migration journal must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || typeof record.workspace !== 'string'
    || !isAbsolute(record.workspace)
    || typeof record.legacyKey !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.legacyKey)
    || typeof record.targetKey !== 'string'
    || !/^git-[0-9a-f]{64}$/.test(record.targetKey)
    || record.targetKey !== workspaceKey
    || typeof record.commonDir !== 'string'
    || !isAbsolute(record.commonDir)
    || typeof record.gitDir !== 'string'
    || !isAbsolute(record.gitDir)
    || typeof record.worktreeId !== 'string'
    || !/^[0-9a-f]{32}$/.test(record.worktreeId)
    || gitWorkspaceKey(record.commonDir, record.worktreeId) !== workspaceKey
    || createHash('sha256').update(record.workspace).digest('hex') !== record.legacyKey) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'workspace migration journal is invalid')
  }
  return {
    version: 1,
    workspace: record.workspace,
    legacyKey: record.legacyKey,
    targetKey: record.targetKey,
    commonDir: record.commonDir,
    gitDir: record.gitDir,
    worktreeId: record.worktreeId,
  }
}

async function workspaceMigrationKeys(workspacesDir: string): Promise<string[]> {
  const keys: string[] = []
  for (const filename of await safeFileNames(workspacesDir)) {
    if (!filename.startsWith('.workspace-migration-') || !filename.endsWith('.json')) continue
    const workspaceKey = filename.slice('.workspace-migration-'.length, -'.json'.length)
    if (!/^git-[0-9a-f]{64}$/.test(workspaceKey)) {
      throw new ChangeLedgerError('STATE_CORRUPT', `workspace migration filename is invalid: ${filename}`)
    }
    keys.push(workspaceKey)
  }
  return keys.sort()
}

function workspaceMigrationPath(workspacesDir: string, workspaceKey: string): string {
  if (!/^git-[0-9a-f]{64}$/.test(workspaceKey)) {
    throw new ChangeLedgerError('STATE_CORRUPT', `workspace migration key is invalid: ${workspaceKey}`)
  }
  return join(workspacesDir, `.workspace-migration-${workspaceKey}.json`)
}

function worktreeClaimPath(claimsDir: string, worktreeId: string): string {
  if (!/^[0-9a-f]{32}$/.test(worktreeId)) {
    throw new ChangeLedgerError('STATE_CORRUPT', `worktree claim identity is invalid: ${worktreeId}`)
  }
  return join(claimsDir, `${worktreeId}.json`)
}

async function worktreeClaimIds(claimsDir: string): Promise<string[]> {
  const ids: string[] = []
  for (const filename of await safeFileNames(claimsDir)) {
    if (filename.startsWith('.') && filename.endsWith('.tmp')) continue
    if (!/^[0-9a-f]{32}\.json$/.test(filename)) {
      throw new ChangeLedgerError('STATE_CORRUPT', `worktree claim filename is invalid: ${filename}`)
    }
    ids.push(filename.slice(0, -'.json'.length))
  }
  return ids.sort()
}

async function readWorktreeClaim(claimsDir: string, worktreeId: string): Promise<WorktreeClaim | undefined> {
  let value: unknown
  try {
    value = await readJson(worktreeClaimPath(claimsDir, worktreeId))
  } catch (error) {
    if (isMissingStateRead(error)) return undefined
    throw error
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'worktree claim must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || record.worktreeId !== worktreeId
    || typeof record.workspaceKey !== 'string'
    || !/^git-[0-9a-f]{64}$/.test(record.workspaceKey)
    || typeof record.commonDir !== 'string'
    || !isAbsolute(record.commonDir)
    || typeof record.gitDir !== 'string'
    || !isAbsolute(record.gitDir)
    || gitWorkspaceKey(record.commonDir, worktreeId) !== record.workspaceKey) {
    throw new ChangeLedgerError('STATE_CORRUPT', `worktree claim ${worktreeId} is invalid`)
  }
  return {
    version: 1,
    worktreeId,
    workspaceKey: record.workspaceKey,
    commonDir: record.commonDir,
    gitDir: record.gitDir,
  }
}

async function deleteWorkspaceMigration(workspacesDir: string, workspaceKey: string): Promise<void> {
  try {
    await unlink(workspaceMigrationPath(workspacesDir, workspaceKey))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  await syncDirectory(workspacesDir)
}

/** Create or read the durable owner of one storage root's private Git namespace. */
export async function ensureStoreId(storageDir: string): Promise<string> {
  await mkdir(storageDir, { recursive: true, mode: 0o700 })
  const primaryPath = join(storageDir, 'store-id')
  const repairPath = join(storageDir, 'store-id.repair')
  const [primary, repair] = await Promise.all([readStoreIdCopy(primaryPath), readStoreIdCopy(repairPath)])
  const valid = [primary.value, repair.value].filter((value): value is string => value !== undefined)
  if (new Set(valid).size > 1) throw new ChangeLedgerError('STATE_CORRUPT', 'store-id copies disagree')
  const durable = valid[0]
  if (durable !== undefined) {
    if (await publishStoreIdFile(repairPath, durable, true) !== durable
      || await publishStoreIdFile(primaryPath, durable, true) !== durable) {
      throw new ChangeLedgerError('STATE_CORRUPT', 'store-id copies disagree during repair')
    }
    return durable
  }
  if (repair.malformed) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'store-id repair copy is malformed')
  }
  const containsV2 = await storageContainsV2State(storageDir)
  if (containsV2) {
    throw new ChangeLedgerError(
      'STATE_CORRUPT',
      primary.malformed
        ? 'store-id is malformed in a storage root that already contains Git-native checkpoints'
        : 'store-id is missing from a storage root that already contains Git-native checkpoints',
    )
  }
  const candidate = randomUUID().replaceAll('-', '')
  const chosen = await publishStoreIdFile(repairPath, candidate, false)
  if (await publishStoreIdFile(primaryPath, chosen, true) !== chosen) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'store-id copies disagree during initialization')
  }
  return chosen
}

interface StoreIdCopy {
  readonly value?: string
  readonly malformed: boolean
}

async function readStoreIdCopy(path: string): Promise<StoreIdCopy> {
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return /^[0-9a-f]{32}$/.test(value) ? { value, malformed: false } : { malformed: true }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { malformed: false }
    throw error
  }
}

async function publishStoreIdFile(path: string, value: string, repairMalformed: boolean): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await publishExclusiveFile(path, `${value}\n`)) return value
    const existing = await readStoreIdCopy(path)
    if (existing.value !== undefined) return existing.value
    if (!existing.malformed) continue
    if (!repairMalformed) throw new ChangeLedgerError('STATE_CORRUPT', `store-id copy is malformed at ${JSON.stringify(path)}`)
    try {
      await unlink(path)
      await syncDirectory(dirname(path))
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
  throw new ChangeLedgerError('STATE_CORRUPT', `could not repair store-id copy at ${JSON.stringify(path)}`)
}

async function storageContainsV2State(storageDir: string): Promise<boolean> {
  if ((await worktreeClaimIds(join(storageDir, 'worktree-claims'))).length !== 0) return true
  const workspacesDir = join(storageDir, 'workspaces')
  for (const workspaceKey of await safeDirectoryNames(workspacesDir)) {
    const workspaceDir = join(workspacesDir, workspaceKey)
    if (await pathExists(join(workspaceDir, 'git-cache.json'))) return true
    if ((await safeFileNames(join(workspaceDir, 'git-journals'))).length !== 0) return true
    for (const filename of await safeJsonNames(join(workspaceDir, 'manifests'))) {
      const value = await readJson(join(workspaceDir, 'manifests', filename))
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).version === 2) {
        return true
      }
    }
  }
  return false
}

function gitWorkspaceKey(commonDir: string, worktreeId: string): string {
  return `git-${createHash('sha256').update(`${commonDir}\0${worktreeId}`).digest('hex')}`
}

async function publishExclusiveFile(path: string, body: string | Buffer): Promise<boolean> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(body)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, path)
      await syncDirectory(directory)
      return true
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      return false
    }
  } finally {
    try {
      await unlink(temporary)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
}

async function safeJsonNames(path: string): Promise<string[]> {
  return (await safeFileNames(path)).filter((name) => name.endsWith('.json')).sort()
}

async function safeDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return []
    throw error
  }
}

async function safeFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return []
    throw error
  }
}

function isMissingCause(error: unknown): boolean {
  return error instanceof Error && 'cause' in error && isNodeError(error.cause, 'ENOENT')
}

function isMissingStateRead(error: unknown): boolean {
  return error instanceof ChangeLedgerError && error.code === 'STATE_READ_FAILED' && isMissingCause(error)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason
}
