import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { isNodeError, pathExists, writeJsonAtomic } from './path-utils.js'
import type { SnapshotEntry } from './types.js'

const CACHE_FILE = 'path-cache.json'
const CACHE_VERSION = 1
const MAX_ENTRIES = 200_000
const MAX_FILE_BYTES = 64 * 1024 * 1024

/**
 * One observed path, keyed by the filesystem identity that proves it is unchanged.
 *
 * `ctimeNs` changes on every write even when size and mtime are restored, so a
 * matching key means the stored content is still exactly what the path holds.
 */
export interface PathCacheEntry {
  readonly dev: string
  readonly ino: string
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
  readonly mode: number
  readonly entry: SnapshotEntry
}

/** Stable identity string for one observed filesystem object. */
export function pathCacheKey(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode.toString()}`
}

/** Remember what one unknown does not already describe. */
export function toPathCacheEntry(info: BigIntStats, entry: SnapshotEntry): PathCacheEntry {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
    mode: Number(info.mode & 0o777n),
    entry,
  }
}

/** Whether a cached record still describes the object the filesystem reports now. */
export function matchesPathCache(record: PathCacheEntry, info: BigIntStats): boolean {
  return record.dev === info.dev.toString()
    && record.ino === info.ino.toString()
    && record.size === info.size.toString()
    && record.mtimeNs === info.mtimeNs.toString()
    && record.ctimeNs === info.ctimeNs.toString()
    && record.mode === Number(info.mode & 0o777n)
}

/**
 * Read the per-workspace path cache.
 *
 * The cache is a pure optimization: any malformed or unreadable record is
 * discarded instead of trusted, and a discarded cache only costs a cold capture.
 * @param workspaceDir - durable directory of one workspace.
 * @returns the cached records, newest read wins.
 */
export async function readPathCache(workspaceDir: string): Promise<Map<string, PathCacheEntry>> {
  const cache = new Map<string, PathCacheEntry>()
  let raw: string
  try {
    raw = await readFile(join(workspaceDir, CACHE_FILE), 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return cache
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return cache
    const record = parsed as { version?: unknown; paths?: unknown }
    if (record.version !== CACHE_VERSION || record.paths === null || typeof record.paths !== 'object') return cache
    for (const [path, value] of Object.entries(record.paths as Record<string, unknown>)) {
      const entry = parseCacheEntry(value)
      if (entry === undefined) continue
      cache.set(path, entry)
      if (cache.size >= MAX_ENTRIES) break
    }
  } catch {
    return new Map()
  }
  return cache
}

/** Persist the path cache atomically, replacing any previous generation. */
export async function writePathCache(workspaceDir: string, cache: ReadonlyMap<string, PathCacheEntry>): Promise<void> {
  const paths: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let count = 0
  for (const [path, entry] of cache) {
    if (count >= MAX_ENTRIES) break
    paths[path] = serializeCacheEntry(entry)
    count += 1
  }
  await writeJsonAtomic(join(workspaceDir, CACHE_FILE), { version: CACHE_VERSION, paths })
}

/** Drop the cache when its file is unreadable or was never written. */
export async function pathCacheExists(workspaceDir: string): Promise<boolean> {
  return pathExists(join(workspaceDir, CACHE_FILE))
}

function serializeCacheEntry(record: PathCacheEntry): Record<string, unknown> {
  const entry = record.entry
  return {
    dev: record.dev, ino: record.ino, size: record.size,
    mtimeNs: record.mtimeNs, ctimeNs: record.ctimeNs, mode: record.mode,
    kind: entry.kind,
    ...(entry.kind === 'file' ? { blob: entry.blob, provider: entry.provider } : { target: entry.target }),
  }
}

function parseCacheEntry(value: unknown): PathCacheEntry | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const text = (key: string): string | undefined => (typeof record[key] === 'string' ? record[key] as string : undefined)
  const dev = text('dev'); const ino = text('ino'); const size = text('size')
  const mtimeNs = text('mtimeNs'); const ctimeNs = text('ctimeNs')
  if (dev === undefined || ino === undefined || size === undefined || mtimeNs === undefined || ctimeNs === undefined) return undefined
  if (typeof record.mode !== 'number' || !Number.isInteger(record.mode)) return undefined
  let entry: SnapshotEntry
  if (record.kind === 'file') {
    const blob = text('blob')
    if (blob === undefined || !/^[0-9a-f]{64}$/.test(blob)) return undefined
    const provider = record.provider
    if (provider !== undefined && provider !== 'git') return undefined
    entry = {
      kind: 'file', blob, size: Number(size), mode: record.mode,
      ...(provider === undefined ? {} : { provider }),
    }
  } else if (record.kind === 'symlink') {
    const target = text('target')
    if (target === undefined || target.includes('\0')) return undefined
    entry = { kind: 'symlink', target, mode: record.mode }
  } else {
    return undefined
  }
  if (BigInt(size) > BigInt(MAX_FILE_BYTES)) return undefined
  return { dev, ino, size, mtimeNs, ctimeNs, mode: record.mode, entry }
}
