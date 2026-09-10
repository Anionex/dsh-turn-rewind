import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'
import { ChangeLedgerError } from './errors.js'
import { isNodeError, resolveWorkspacePath } from './path-utils.js'
import { matchesPathCache, toPathCacheEntry, type PathCacheEntry } from './path-cache.js'
import type { LedgerStore } from './store.js'
import { discoverWorkspace, sameWorkspaceFence, type WorkspaceSnapshotSource } from './workspace.js'
import type {
  CaptureSkip,
  CaptureSkipReason,
  CaptureTruncation,
  ResolvedChangeLedgerConfig,
  SnapshotEntry,
  WorkspaceChange,
} from './types.js'

const COMPARISON_READ_BUDGET_BYTES = 128 * 1024 * 1024

/** One captured tree, optionally persisted into the blob store. */
export interface CapturedTree {
  readonly source: WorkspaceSnapshotSource
  readonly entries: Readonly<Record<string, SnapshotEntry>>
  readonly gitEntries?: Readonly<Record<string, SnapshotEntry>>
  /** Eligible paths this capture could not store; a restore never touches them. */
  readonly skipped: readonly CaptureSkip[]
  readonly skippedCount: number
  /** Set when a limit stopped the capture before every eligible path was read. */
  readonly truncated?: CaptureTruncation
  /** True when the recorded skip list is shorter than `skippedCount`. */
  readonly skippedListTruncated: boolean
  readonly treeHash: string
  readonly fileCount: number
  readonly totalBytes: number
}

const MAX_RECORDED_SKIPS = 50

/** Capture the current tracked and non-ignored Git working tree. */
export async function captureTree(options: {
  readonly cwd: string
  readonly config: ResolvedChangeLedgerConfig
  readonly store?: LedgerStore
  readonly gitObjectFormat?: 'sha1' | 'sha256'
  /** Per-path identity cache: an unchanged path is reused instead of re-read. */
  readonly pathCache?: Map<string, PathCacheEntry>
  readonly signal?: AbortSignal
}): Promise<CapturedTree> {
  throwIfAborted(options.signal)
  const source = await discoverWorkspace(options.cwd, options.config, options.signal)
  // Limits never discard an entire restore point: an over-limit path is left out
  // and reported, and the remaining eligible paths are still captured. A restore
  // only ever rewrites captured paths, so a partial point stays safe to apply.
  const skipped: CaptureSkip[] = [...source.skipped]
  let skippedCount = source.skippedCount
  let truncated: CaptureTruncation | undefined = source.truncated
  const recordSkip = (path: string, reason: CaptureSkipReason): void => {
    skippedCount += 1
    if (skipped.length < MAX_RECORDED_SKIPS) skipped.push({ path, reason })
    else truncated ??= reason === 'snapshot-limit' ? 'snapshot-limit' : 'file-limit'
  }
  const paths = source.paths.length > options.config.maxFiles
    ? source.paths.slice(0, options.config.maxFiles)
    : source.paths
  if (source.paths.length > options.config.maxFiles) truncated ??= 'file-limit'

  const entries: Record<string, SnapshotEntry> = Object.create(null) as Record<string, SnapshotEntry>
  // Git-object capture only applies to a Git worktree; an ordinary directory
  // always stores its own content-addressed blobs.
  const gitObjectFormat = source.state.type === 'git' ? options.gitObjectFormat : undefined
  const gitCapture = gitObjectFormat === undefined
    ? undefined
    : {
        objectFormat: gitObjectFormat,
        entries: Object.create(null) as Record<string, SnapshotEntry>,
      }
  let totalBytes = 0
  let budgetSpent = false
  const capturePath = async (path: string): Promise<void> => {
    throwIfAborted(options.signal)
    // Reuse is only sound when the identity is unchanged and the stored blob is
    // still present; a garbage-collected blob falls back to a fresh read.
    if (options.pathCache !== undefined && options.store !== undefined && gitCapture === undefined) {
      const cached = options.pathCache.get(path)
      if (cached !== undefined) {
        let info: BigIntStats | undefined
        try {
          info = await lstat(resolveWorkspacePath(source.state.root, path), { bigint: true })
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error
        }
        if (info !== undefined && matchesPathCache(cached, info)) {
          const reusable = cached.entry.kind === 'symlink'
            || await options.store.hasBlob(source.state.root, cached.entry.blob)
          if (reusable) {
            entries[path] = cached.entry
            if (cached.entry.kind === 'file') totalBytes += cached.entry.size
            return
          }
        }
      }
    }
    if (budgetSpent) {
      // The aggregate budget is gone, but the path is still recorded so a
      // restore can prove this point never observed it.
      recordSkip(path, 'snapshot-limit')
      return
    }
    let entry: Awaited<ReturnType<typeof captureEntry>>
    try {
      entry = await captureEntry(source.state.root, path, options.config.maxFileBytes, options.signal)
    } catch (error) {
      if (error instanceof ChangeLedgerError && error.code === 'FILE_TOO_LARGE') {
        recordSkip(path, 'file-too-large')
        return
      }
      if (error instanceof ChangeLedgerError && error.code === 'UNSUPPORTED_FILE_TYPE') {
        recordSkip(path, 'unsupported-file-type')
        return
      }
      throw error
    }
    if (entry === undefined) return
    if (entry.kind === 'file') {
      if (budgetSpent || totalBytes + entry.content.length > options.config.maxSnapshotBytes) {
        budgetSpent = true
        truncated ??= 'snapshot-limit'
        recordSkip(path, 'snapshot-limit')
        return
      }
      totalBytes += entry.content.length
      if (options.store !== undefined) {
        await options.store.putBlob(source.state.root, entry.snapshot.blob, entry.content)
      }
      entries[path] = entry.snapshot
      if (gitCapture !== undefined) {
        gitCapture.entries[path] = gitFileSnapshot(entry.snapshot, entry.content, gitCapture.objectFormat)
      }
      return
    }
    entries[path] = entry.snapshot
    if (gitCapture !== undefined) gitCapture.entries[path] = entry.snapshot
    if (options.pathCache !== undefined && gitCapture === undefined) {
      options.pathCache.set(path, toPathCacheEntry(entry.info, entry.snapshot))
    }
  }
  {
    // Reading one file at a time makes a real project directory take minutes, so
    // every capture runs through a bounded worker pool. Per-file stability stats
    // and the synchronous budget check keep the result identical to a serial run.
    let next = 0
    let failed = false
    let firstError: unknown = new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'parallel comparison capture failed')
    const concurrency = Math.min(
      32,
      paths.length,
      Math.max(1, Math.floor(COMPARISON_READ_BUDGET_BYTES / options.config.maxFileBytes)),
    )
    const workers = Array.from({ length: concurrency }, async () => {
      while (!failed && next < paths.length) {
        const index = next
        next += 1
        const path = paths[index]
        if (path === undefined) continue
        try {
          await capturePath(path)
        } catch (error) {
          if (!failed) {
            failed = true
            firstError = error
          }
        }
      }
    })
    await Promise.all(workers)
    if (failed) throw firstError
  }

  return {
    source,
    entries,
    ...(gitCapture === undefined ? {} : { gitEntries: gitCapture.entries }),
    skipped,
    skippedCount,
    skippedListTruncated: skippedCount > skipped.length,
    ...(truncated === undefined ? {} : { truncated }),
    treeHash: hashTree(entries),
    fileCount: Object.keys(entries).length,
    totalBytes,
  }
}

/**
 * Capture the complete tree twice and accept it only when both path/content and
 * repository fences agree. This prevents a point from silently mixing files
 * observed at incompatible moments while another process is editing the tree.
 */
export async function captureStableTree(options: {
  readonly cwd: string
  readonly config: ResolvedChangeLedgerConfig
  readonly store?: LedgerStore
  readonly gitObjectFormat?: 'sha1' | 'sha256'
  /** Per-path identity cache: an unchanged path is reused instead of re-read. */
  readonly pathCache?: Map<string, PathCacheEntry>
  readonly signal?: AbortSignal
}): Promise<CapturedTree> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await captureTree({
      cwd: options.cwd,
      config: options.config,
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.pathCache === undefined ? {} : { pathCache: options.pathCache }),
      ...(options.gitObjectFormat === undefined ? {} : { gitObjectFormat: options.gitObjectFormat }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const second = await captureTree(options)
    if (first.treeHash === second.treeHash
      && sameWorkspaceFence(first.source.state, second.source.state)
      && sameStagedPaths(first.source, second.source)
      && arraysEqual(first.source.paths, second.source.paths)) {
      return second
    }
  }
  throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'workspace did not remain stable across repeated full-tree captures')
}

/** Whether two captures observed the same index state; ordinary directories have none. */
function sameStagedPaths(left: WorkspaceSnapshotSource, right: WorkspaceSnapshotSource): boolean {
  if (left.state.type !== 'git' || right.state.type !== 'git') return true
  return arraysEqual(left.state.stagedPaths, right.state.stagedPaths)
}

/** Compute stable path-level differences between two captured trees. */
export function diffTrees(
  before: Readonly<Record<string, SnapshotEntry>>,
  after: Readonly<Record<string, SnapshotEntry>>,
  comparisonBefore: Readonly<Record<string, SnapshotEntry>> = before,
  comparisonAfter: Readonly<Record<string, SnapshotEntry>> = after,
): WorkspaceChange[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(comparePaths)
  const changes: WorkspaceChange[] = []
  for (const path of paths) {
    const left = before[path]
    const right = after[path]
    const comparisonLeft = comparisonBefore[path]
    const comparisonRight = comparisonAfter[path]
    if (left === undefined && right !== undefined) {
      changes.push({ path, kind: 'added', after: right })
      continue
    }
    if (left !== undefined && right === undefined) {
      changes.push({ path, kind: 'deleted', before: left })
      continue
    }
    if (left === undefined || right === undefined || entriesEqual(comparisonLeft, comparisonRight)) continue
    if (left.kind !== right.kind) {
      changes.push({ path, kind: 'type-changed', before: left, after: right })
      continue
    }
    if (left.kind === 'file'
      && right.kind === 'file'
      && comparisonLeft?.kind === 'file'
      && comparisonRight?.kind === 'file'
      && comparisonLeft.blob === comparisonRight.blob
      && left.mode !== right.mode) {
      changes.push({ path, kind: 'mode-changed', before: left, after: right })
      continue
    }
    if (left.kind === 'symlink'
      && right.kind === 'symlink'
      && comparisonLeft?.kind === 'symlink'
      && comparisonRight?.kind === 'symlink'
      && comparisonLeft.target === comparisonRight.target
      && left.mode !== right.mode) {
      changes.push({ path, kind: 'mode-changed', before: left, after: right })
      continue
    }
    changes.push({ path, kind: 'modified', before: left, after: right })
  }
  return changes
}

/** Return whether two snapshot entries are byte/type/mode equivalent. */
export function entriesEqual(left: SnapshotEntry | undefined, right: SnapshotEntry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.kind !== right.kind || left.mode !== right.mode) return false
  if (left.kind === 'file' && right.kind === 'file') {
    return left.blob === right.blob && left.size === right.size
  }
  return left.kind === 'symlink' && right.kind === 'symlink' && left.target === right.target
}

/** Hash a complete path map into a deterministic tree identity. */
export function hashTree(entries: Readonly<Record<string, SnapshotEntry>>): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(entries).sort(comparePaths)) {
    const entry = entries[path]
    if (entry === undefined) continue
    hash.update(path)
    hash.update('\0')
    if (entry.kind === 'file') {
      hash.update(`file\0${entry.blob}\0${entry.size}\0${entry.mode}\0`)
    } else {
      hash.update(`symlink\0${entry.target}\0${entry.mode}\0`)
    }
  }
  return hash.digest('hex')
}

/** Byte-verify one workspace-relative path without following a final symlink. */
export async function captureSnapshotEntry(
  root: string,
  path: string,
  maxFileBytes: number,
  signal?: AbortSignal,
  gitObjectFormat?: 'sha1' | 'sha256',
): Promise<SnapshotEntry | undefined> {
  const entry = await captureEntry(root, path, maxFileBytes, signal)
  if (entry === undefined || entry.kind === 'symlink' || gitObjectFormat === undefined) return entry?.snapshot
  return gitFileSnapshot(entry.snapshot, entry.content, gitObjectFormat)
}

function gitFileSnapshot(
  snapshot: SnapshotEntry & { readonly kind: 'file' },
  content: Buffer,
  objectFormat: 'sha1' | 'sha256',
): SnapshotEntry {
  const header = Buffer.from(`blob ${String(content.length)}\0`)
  const blob = createHash(objectFormat).update(header).update(content).digest('hex')
  return { ...snapshot, blob, provider: 'git' }
}

async function captureEntry(
  root: string,
  path: string,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly kind: 'file'; readonly snapshot: SnapshotEntry & { readonly kind: 'file' }; readonly content: Buffer; readonly info: BigIntStats }
  | { readonly kind: 'symlink'; readonly snapshot: SnapshotEntry & { readonly kind: 'symlink' }; readonly info: BigIntStats }
  | undefined> {
  const target = resolveWorkspacePath(root, path)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal)
    let before
    try {
      before = await lstat(target, { bigint: true })
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined
      throw error
    }
    const mode = Number(before.mode & 0o777n)
    if (before.isSymbolicLink()) {
      const linkTarget = await readlink(target)
      const after = await lstat(target, { bigint: true })
      if (!sameStat(before, after)) continue
      return { kind: 'symlink', snapshot: { kind: 'symlink', target: linkTarget, mode }, info: after }
    }
    if (!before.isFile()) {
      throw new ChangeLedgerError('UNSUPPORTED_FILE_TYPE', `eligible path is not a regular file or symlink: ${JSON.stringify(path)}`)
    }
    if (before.size > BigInt(maxFileBytes)) {
      throw new ChangeLedgerError(
        'FILE_TOO_LARGE',
        `${JSON.stringify(path)} is ${before.size.toString()} bytes; configured per-file maximum is ${maxFileBytes}`,
      )
    }
    let handle
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isNodeError(error, 'ELOOP')) continue
      throw error
    }
    let content: Buffer
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameStat(before, opened)) continue
      content = await readBoundedFile(handle, Number(opened.size))
      throwIfAborted(signal)
      const after = await handle.stat({ bigint: true })
      if (!sameStat(opened, after) || BigInt(content.length) !== after.size) continue
    } finally {
      await handle.close()
    }
    const blob = createHash('sha256').update(content).digest('hex')
    return {
      kind: 'file',
      snapshot: { kind: 'file', blob, size: content.length, mode },
      content,
      info: { ...before, size: BigInt(content.length) } as BigIntStats,
    }
  }
  throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `path changed repeatedly while being captured: ${JSON.stringify(path)}`)
}

async function readBoundedFile(handle: Awaited<ReturnType<typeof open>>, expectedSize: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(expectedSize + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason
}

function comparePaths(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
