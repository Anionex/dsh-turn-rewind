import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ChangeLedgerError, errorMessage } from './errors.js'
import { isNodeError, openExclusive, processExists, readJson, syncDirectory, writeJsonAtomic } from './path-utils.js'
import type { ResolvedChangeLedgerConfig, RestoreOperation, RestorePointManifest } from './types.js'
import { parseManifest, parseOperation, validateBlobHash, validateOperationId, validateRestorePointId } from './validate.js'

interface LockRecord {
  readonly pid: number
  readonly createdAt: number
  readonly nonce: string
}

/** Durable content-addressed storage and per-workspace locking. */
export class LedgerStore {
  constructor(readonly config: ResolvedChangeLedgerConfig) {}

  /** Create the state root and reconcile crash-interrupted operations. */
  async initialize(): Promise<number> {
    await mkdir(join(this.config.storageDir, 'workspaces'), { recursive: true, mode: 0o700 })
    let reconciled = 0
    for (const workspaceKey of await safeDirectoryNames(join(this.config.storageDir, 'workspaces'))) {
      const workspaceDir = join(this.config.storageDir, 'workspaces', workspaceKey)
      if (await this.workspaceAppearsActive(workspaceDir)) continue
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
    }
    return reconciled
  }

  /** Acquire the exclusive lock for one canonical workspace. */
  async acquire(workspace: string): Promise<() => Promise<void>> {
    const lockPath = join(this.workspaceDir(workspace), 'lock.json')
    await mkdir(this.workspaceDir(workspace), { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle
      try {
        handle = await openExclusive(lockPath)
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        const reclaimed = await this.reclaimStaleLock(lockPath)
        if (reclaimed) continue
        throw new ChangeLedgerError('WORKSPACE_LOCKED', `another change-ledger operation owns ${JSON.stringify(workspace)}`)
      }
      const record: LockRecord = { pid: process.pid, createdAt: Date.now(), nonce }
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(this.workspaceDir(workspace))
      let released = false
      return async () => {
        if (released) return
        released = true
        try {
          const current = parseLock(await readJson(lockPath))
          if (current.nonce !== nonce) return
          await unlink(lockPath)
          await syncDirectory(this.workspaceDir(workspace))
        } catch (error) {
          if (!isNodeError(error, 'ENOENT') && !isMissingStateRead(error)) throw error
        }
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
    parseManifest(manifest)
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
    if (manifest.id !== id) {
      throw new ChangeLedgerError('STATE_CORRUPT', `restore point file ${id}.json contains id ${manifest.id}`)
    }
    if (manifest.workspace !== workspace) {
      throw new ChangeLedgerError('STATE_CORRUPT', `restore point ${id} belongs to a different workspace`)
    }
    return manifest
  }

  /** List all validated restore points for one workspace, newest first. */
  async listManifests(workspace: string): Promise<RestorePointManifest[]> {
    const manifests: RestorePointManifest[] = []
    for (const filename of await safeJsonNames(join(this.workspaceDir(workspace), 'manifests'))) {
      const manifest = parseManifest(await readJson(join(this.workspaceDir(workspace), 'manifests', filename)))
      if (filename !== `${manifest.id}.json`) {
        throw new ChangeLedgerError('STATE_CORRUPT', `manifest ${filename} does not match its persisted id ${manifest.id}`)
      }
      if (manifest.workspace !== workspace) {
        throw new ChangeLedgerError('STATE_CORRUPT', `manifest ${filename} belongs to a different workspace`)
      }
      manifests.push(manifest)
    }
    return manifests.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  /** Delete one restore-point manifest. Blobs remain until garbage collection succeeds. */
  async deleteManifest(workspace: string, id: string): Promise<void> {
    validateRestorePointId(id)
    const directory = join(this.workspaceDir(workspace), 'manifests')
    try {
      await unlink(this.manifestPath(workspace, id))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `restore point ${id} does not exist`)
      }
      throw error
    }
    await syncDirectory(directory)
  }

  /** Persist one restore-operation journal. */
  async writeOperation(operation: RestoreOperation): Promise<void> {
    parseOperation(operation)
    await writeJsonAtomic(this.operationPath(operation.workspace, operation.id), operation)
  }

  /** List validated restore operations for one workspace. */
  async listOperations(workspace: string): Promise<RestoreOperation[]> {
    const operations: RestoreOperation[] = []
    for (const filename of await safeJsonNames(join(this.workspaceDir(workspace), 'operations'))) {
      const operation = parseOperation(await readJson(join(this.workspaceDir(workspace), 'operations', filename)))
      if (filename !== `${operation.id}.json`) {
        throw new ChangeLedgerError('STATE_CORRUPT', `operation ${filename} does not match its persisted id ${operation.id}`)
      }
      if (operation.workspace !== workspace) {
        throw new ChangeLedgerError('STATE_CORRUPT', `operation ${filename} belongs to a different workspace`)
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
  ): Promise<{ deletedBlobs: number; retainedBlobs: number }> {
    const referenced = new Set<string>(additionalReferenced)
    for (const hash of referenced) validateBlobHash(hash)
    for (const manifest of await this.listManifests(workspace)) {
      for (const entry of Object.values(manifest.entries)) {
        if (entry.kind === 'file') referenced.add(entry.blob)
      }
    }
    let deletedBlobs = 0
    let retainedBlobs = 0
    const blobsRoot = join(this.workspaceDir(workspace), 'blobs')
    for (const prefix of await safeDirectoryNames(blobsRoot)) {
      const prefixPath = join(blobsRoot, prefix)
      for (const filename of await safeFileNames(prefixPath)) {
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

  private workspaceDir(workspace: string): string {
    const key = createHash('sha256').update(workspace).digest('hex')
    return join(this.config.storageDir, 'workspaces', key)
  }

  private manifestPath(workspace: string, id: string): string {
    return join(this.workspaceDir(workspace), 'manifests', `${validateRestorePointId(id)}.json`)
  }

  private operationPath(workspace: string, id: string): string {
    return join(this.workspaceDir(workspace), 'operations', `${validateOperationId(id)}.json`)
  }

  private blobPath(workspace: string, hash: string): string {
    validateBlobHash(hash)
    return join(this.workspaceDir(workspace), 'blobs', hash.slice(0, 2), hash)
  }

  private async reclaimStaleLock(lockPath: string): Promise<boolean> {
    let lock: LockRecord
    try {
      lock = parseLock(await readJson(lockPath))
    } catch (error) {
      let age = 0
      try {
        age = Date.now() - (await stat(lockPath)).mtimeMs
      } catch (statError) {
        if (isNodeError(statError, 'ENOENT')) return true
        throw statError
      }
      if (age < this.config.staleLockMs) {
        throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', `active lock is unreadable: ${errorMessage(error)}`)
      }
      await unlink(lockPath)
      return true
    }
    if (processExists(lock.pid)) return false
    if (Date.now() - lock.createdAt < this.config.staleLockMs) return false
    try {
      const current = parseLock(await readJson(lockPath))
      if (current.nonce !== lock.nonce) return false
      await unlink(lockPath)
      return true
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return true
      throw error
    }
  }

  private async workspaceAppearsActive(workspaceDir: string): Promise<boolean> {
    const lockPath = join(workspaceDir, 'lock.json')
    try {
      const lock = parseLock(await readJson(lockPath))
      if (processExists(lock.pid)) return true
      return Date.now() - lock.createdAt < this.config.staleLockMs
    } catch (error) {
      if (error instanceof ChangeLedgerError && error.code === 'STATE_READ_FAILED' && isMissingCause(error.cause)) return false
      if (isNodeError(error, 'ENOENT')) return false
      try {
        return Date.now() - (await stat(lockPath)).mtimeMs < this.config.staleLockMs
      } catch (statError) {
        if (isNodeError(statError, 'ENOENT')) return false
        throw statError
      }
    }
  }
}

function parseLock(value: unknown): LockRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock must be an object')
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock pid is invalid')
  }
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock createdAt is invalid')
  }
  if (typeof record.nonce !== 'string' || record.nonce === '') {
    throw new ChangeLedgerError('WORKSPACE_LOCK_CORRUPT', 'workspace lock nonce is invalid')
  }
  return { pid: record.pid as number, createdAt: record.createdAt as number, nonce: record.nonce }
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
