import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { ChangeLedgerError } from './errors.js'
import {
  discoverRepository,
  ensureGitWorktreeIdentity,
  runGit,
  runGitBuffer,
  runGitInput,
  runGitOptional,
  sameRepositoryFence,
} from './git.js'
import { isNodeError, resolveWorkspacePath, validateRelativePath } from './path-utils.js'
import { hashTree } from './snapshot.js'
import { ensureStoreId } from './store.js'
import {
  GIT_CHECKPOINT_FORMAT_VERSION,
  type GitCheckpointMetadata,
  type ResolvedChangeLedgerConfig,
  type RestorePointManifestV2,
  type SnapshotEntry,
} from './types.js'

interface IndexEntry {
  readonly mode: string
  readonly oid: string
}

interface CacheRecord {
  readonly kind: 'file' | 'symlink'
  readonly mode: number
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
  readonly dev: string
  readonly ino: string
  readonly indexOid?: string
  readonly attributes: string
  readonly oid: string
  readonly target?: string
}

interface GitCache {
  readonly version: 2
  readonly storeId: string
  readonly worktreeId: string
  readonly paths: Readonly<Record<string, CacheRecord>>
  readonly checksum: string
}

export interface GitCheckpointCapture {
  readonly manifest: RestorePointManifestV2
  readonly cache: GitCache
}

/** Create a complete Git-native turn checkpoint without writing the real index. */
export async function captureGitTurnCheckpoint(options: {
  readonly cwd: string
  readonly id: string
  readonly sessionId: string
  readonly turn: number
  readonly turnStartSeq: number
  readonly config: ResolvedChangeLedgerConfig
  readonly signal?: AbortSignal
}): Promise<GitCheckpointCapture> {
  const source = await discoverRepository(options.cwd, options.signal)
  await rejectExternalObjectStores(source.state.root, source.state.commonDir, options.signal)
  const storeId = await ensureStoreId(options.config.storageDir)
  const identity = await ensureGitWorktreeIdentity(source.state.root, options.signal)
  if (identity.root !== source.state.root || identity.commonDir !== source.state.commonDir) {
    throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'Git worktree identity changed before checkpoint capture')
  }
  const objectFormat = parseObjectFormat(await runGit(source.state.root, ['rev-parse', '--show-object-format'], options.signal))
  const oidLength = objectFormat === 'sha1' ? 40 : 64
  const zeroOid = '0'.repeat(oidLength)
  const workspaceDir = ledgerWorkspaceDir(options.config.storageDir, identity.commonDir, identity.worktreeId)
  const transactionRoot = join(workspaceDir, 'transactions')
  await mkdir(transactionRoot, { recursive: true })
  const transactionDir = await mkdtemp(join(transactionRoot, 'git-'))
  const hooksDir = join(transactionDir, 'hooks')
  await mkdir(hooksDir, { mode: 0o700 })
  const indexPath = join(transactionDir, 'index')
  const gitEnv: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  }
  const gitArgs = (args: readonly string[]) => ['-c', `core.hooksPath=${hooksDir}`, '-c', 'core.fsmonitor=false', ...args]
  let cache = await readCache(workspaceDir, storeId, identity.worktreeId)
  const cachePaths: Record<string, CacheRecord> = Object.assign(Object.create(null), cache.paths) as Record<string, CacheRecord>
  try {
    const realIndex = await copyPrivateIndex(source.state.root, indexPath, transactionDir, options.signal)
    if (realIndex.info === undefined) {
      await runGit(source.state.root, gitArgs(['read-tree', '--empty']), options.signal, { env: gitEnv })
    }
    await runGit(source.state.root, gitArgs(['update-index', '--no-split-index', '--no-fsmonitor', '--no-untracked-cache']), options.signal, { env: gitEnv })
    await rejectAmbiguousIndex(source.state.root, gitArgs, gitEnv, options.signal)

    const stageOutput = await runGit(source.state.root, gitArgs(['ls-files', '--stage', '-z']), options.signal, { env: gitEnv })
    const indexEntries = parseIndex(stageOutput)
    const indexTree = strip(await runGit(source.state.root, gitArgs(['write-tree']), options.signal, { env: gitEnv }))
    const headTree = strip(await runGitOptional(
      source.state.root,
      ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'],
      options.signal,
      { env: gitEnv },
    )
      ?? await runGitInput(source.state.root, gitArgs(['mktree']), '', options.signal, { env: gitEnv }))
    const dirty = new Set(splitNul(await runGit(source.state.root, gitArgs(['diff-files', '--name-only', '-z']), options.signal, { env: gitEnv })).map(validateRelativePath))
    const attributes = await effectiveAttributes(source.state.root, source.paths, hooksDir, options.signal)
    const configFence = await transformConfigFence(source.state.root, hooksDir, options.signal)
    const strict = options.config.turnCheckpointTrust === 'strict'
    const entries: Record<string, SnapshotEntry> = Object.create(null) as Record<string, SnapshotEntry>
    const indexInfo: string[] = []
    const observed = new Map<string, BigIntStats | undefined>()
    let totalBytes = 0
    let newlyStoredBytes = 0

    for (const path of source.paths) {
      options.signal?.throwIfAborted()
      const target = resolveWorkspacePath(source.state.root, path)
      const indexEntry = indexEntries.get(path)
      let info: BigIntStats
      try {
        info = await lstat(target, { bigint: true })
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          observed.set(path, undefined)
          if (indexEntry !== undefined) indexInfo.push(`0 ${zeroOid}\t${path}\0`)
          delete cachePaths[path]
          continue
        }
        throw error
      }
      observed.set(path, info)
      if (!info.isFile() && !info.isSymbolicLink()) {
        throw new ChangeLedgerError('UNSUPPORTED_FILE_TYPE', `eligible path is not a regular file or symlink: ${JSON.stringify(path)}`)
      }
      const exactMode = Number(info.mode & 0o777n)
      const size = info.isFile() ? Number(info.size) : undefined
      if (size !== undefined && size > options.config.maxFileBytes) {
        throw new ChangeLedgerError('FILE_TOO_LARGE', `${JSON.stringify(path)} is ${size} bytes; configured maximum is ${options.config.maxFileBytes}`)
      }
      const pathAttributes = attributes.get(path) ?? ''
      const attributeFence = `${configFence}\0${pathAttributes}`
      const identitySafe = !strict
        && indexEntry !== undefined
        && !dirty.has(path)
        && isIndexEquivalent(info, indexEntry.mode)
        && configFence.endsWith('\0safe')
        && pathAttributes === 'safe'

      if (identitySafe && info.isFile()) {
        entries[path] = { kind: 'file', blob: indexEntry.oid, provider: 'git', size: size ?? 0, mode: exactMode }
        totalBytes += size ?? 0
        enforceSnapshotLimit(totalBytes, options.config.maxSnapshotBytes)
        continue
      }
      if (identitySafe && info.isSymbolicLink()) {
        const targetValue = await gitBlobText(source.state.root, indexEntry.oid, hooksDir, options.signal)
        entries[path] = { kind: 'symlink', target: targetValue, mode: exactMode }
        continue
      }

      const cached = !strict ? cachePaths[path] : undefined
      const cachedOid = cached !== undefined && cacheMatches(cached, info, indexEntry?.oid, attributeFence)
        && await gitBlobExists(source.state.root, cached.oid, hooksDir, options.signal)
        ? cached.oid
        : undefined
      if (info.isSymbolicLink()) {
        const targetValue = cachedOid === undefined ? await stableReadlink(target, info, path, options.signal) : cached?.target
        if (targetValue === undefined) throw new ChangeLedgerError('STATE_CORRUPT', `cached symlink target is absent for ${JSON.stringify(path)}`)
        const content = Buffer.from(targetValue)
        const oid = cachedOid ?? strip(await runGitInput(source.state.root, gitArgs(['hash-object', '-w', '--stdin']), content, options.signal, { env: gitEnv }))
        if (cachedOid === undefined) newlyStoredBytes += content.length
        enforceNewContentLimit(newlyStoredBytes, options.config.turnCheckpointMaxNewBytes)
        entries[path] = { kind: 'symlink', target: targetValue, mode: exactMode }
        indexInfo.push(`120000 ${oid}\t${path}\0`)
        cachePaths[path] = makeCacheRecord(info, indexEntry?.oid, attributeFence, oid, targetValue)
        continue
      }

      if (size === undefined) throw new ChangeLedgerError('STATE_CORRUPT', `regular file size is unavailable for ${JSON.stringify(path)}`)
      let oid = cachedOid
      if (oid === undefined) {
        const content = await stableReadFile(target, info, path, options.signal)
        oid = strip(await runGitInput(source.state.root, gitArgs(['hash-object', '-w', '--stdin']), content, options.signal, { env: gitEnv }))
        newlyStoredBytes += content.length
      }
      enforceNewContentLimit(newlyStoredBytes, options.config.turnCheckpointMaxNewBytes)
      totalBytes += size
      enforceSnapshotLimit(totalBytes, options.config.maxSnapshotBytes)
      entries[path] = { kind: 'file', blob: oid, provider: 'git', size, mode: exactMode }
      indexInfo.push(`${exactMode & 0o111 ? '100755' : '100644'} ${oid}\t${path}\0`)
      cachePaths[path] = makeCacheRecord(info, indexEntry?.oid, attributeFence, oid)
    }

    if (Object.keys(entries).length > options.config.maxFiles) {
      throw new ChangeLedgerError('TOO_MANY_FILES', `workspace exceeds configured maximum of ${options.config.maxFiles} files`)
    }
    if (indexInfo.length > 0) {
      await runGitInput(source.state.root, gitArgs(['update-index', '-z', '--index-info']), indexInfo.join(''), options.signal, { env: gitEnv })
    }
    const worktreeTree = strip(await runGit(source.state.root, gitArgs(['write-tree']), options.signal, { env: gitEnv }))
    const envelopeTree = strip(await runGitInput(
      source.state.root,
      gitArgs(['mktree']),
      `040000 tree ${headTree}\thead\n040000 tree ${indexTree}\tindex\n040000 tree ${worktreeTree}\tworktree\n`,
      options.signal,
      { env: gitEnv },
    ))
    const commit = strip(await runGitInput(
      source.state.root,
      gitArgs(['commit-tree', envelopeTree]),
      `Turn Rewind checkpoint ${options.id}\n`,
      options.signal,
      {
        env: {
          ...gitEnv,
          GIT_AUTHOR_NAME: 'Turn Rewind',
          GIT_AUTHOR_EMAIL: 'turn-rewind@localhost',
          GIT_COMMITTER_NAME: 'Turn Rewind',
          GIT_COMMITTER_EMAIL: 'turn-rewind@localhost',
        },
      },
    ))
    await verifyStableCapture({
      source,
      observed,
      realIndex,
      attributes,
      configFence,
      hooksDir,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (identity.root !== source.state.root || identity.commonDir !== source.state.commonDir) {
      throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'Git worktree identity changed during checkpoint capture')
    }
    const privateRef = `refs/dsh-turn-rewind/v2/${storeId}/${identity.worktreeId}/${options.id}`
    await runGit(source.state.root, gitArgs(['check-ref-format', privateRef]), options.signal, { env: gitEnv })

    cache = makeCache(storeId, identity.worktreeId, cachePaths)
    await writeCache(workspaceDir, cache)
    const git: GitCheckpointMetadata = {
      objectFormat,
      trust: strict ? 'byte-verified' : 'metadata-fenced',
      storeId,
      worktreeId: identity.worktreeId,
      headTree,
      indexTree,
      worktreeTree,
      envelopeTree,
      commit,
      ref: privateRef,
      newlyStoredBytes,
    }
    const manifest: RestorePointManifestV2 = {
      version: GIT_CHECKPOINT_FORMAT_VERSION,
      id: options.id,
      kind: 'turn',
      workspace: source.state.root,
      repository: source.state,
      sessionId: options.sessionId,
      label: `Before turn ${String(options.turn)} checkpoint`,
      turn: options.turn,
      turnStartSeq: options.turnStartSeq,
      createdAt: Date.now(),
      treeHash: hashTree(entries),
      fileCount: Object.keys(entries).length,
      totalBytes,
      entries,
      restoreCount: 0,
      git,
    }
    return { manifest, cache }
  } catch (error) {
    await writeCache(workspaceDir, makeCache(storeId, identity.worktreeId, cachePaths)).catch(() => undefined)
    throw error
  } finally {
    await rm(transactionDir, { recursive: true, force: true })
  }
}

/** Publish a prepared checkpoint under its exact private ref. */
export async function publishGitCheckpoint(
  manifest: RestorePointManifestV2,
  storageDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const zeroOid = '0'.repeat(manifest.git.objectFormat === 'sha1' ? 40 : 64)
  const identity = await ensureGitWorktreeIdentity(manifest.workspace, signal)
  if (identity.worktreeId !== manifest.git.worktreeId || identity.commonDir !== manifest.repository.commonDir) {
    throw new ChangeLedgerError('STATE_CORRUPT', `Git worktree identity changed before publishing ${manifest.id}`)
  }
  await withHooksSandbox(storageDir, async (hooksDir) => {
    await runGit(manifest.workspace, ['-c', `core.hooksPath=${hooksDir}`, 'update-ref', manifest.git.ref, manifest.git.commit, zeroOid], signal, {
      env: { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    })
  })
}

/** Verify persisted Git metadata before exposing or restoring a v2 point. */
export async function verifyGitCheckpoint(manifest: RestorePointManifestV2, signal?: AbortSignal): Promise<void> {
  const env = { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }
  const identity = await ensureGitWorktreeIdentity(manifest.workspace, signal)
  if (identity.root !== manifest.workspace
    || identity.commonDir !== manifest.repository.commonDir
    || identity.worktreeId !== manifest.git.worktreeId) {
    throw new ChangeLedgerError('STATE_CORRUPT', `Git worktree identity changed for ${manifest.id}`)
  }
  const ref = strip(await runGit(manifest.workspace, ['rev-parse', '--verify', manifest.git.ref], signal, { env }))
  if (ref !== manifest.git.commit) throw new ChangeLedgerError('STATE_CORRUPT', `private ref target changed for ${manifest.id}`)
  const ancestry = strip(await runGit(manifest.workspace, ['rev-list', '--parents', '-n', '1', manifest.git.commit], signal, { env }))
  if (ancestry !== manifest.git.commit) throw new ChangeLedgerError('STATE_CORRUPT', `snapshot commit has unexpected parents for ${manifest.id}`)
  const commitTree = strip(await runGit(manifest.workspace, ['show', '-s', '--format=%T', manifest.git.commit], signal, { env }))
  if (commitTree !== manifest.git.envelopeTree) throw new ChangeLedgerError('STATE_CORRUPT', `snapshot commit tree changed for ${manifest.id}`)
  const envelope = await runGit(manifest.workspace, ['ls-tree', manifest.git.envelopeTree], signal, { env })
  const expected = new Map([
    ['head', manifest.git.headTree],
    ['index', manifest.git.indexTree],
    ['worktree', manifest.git.worktreeTree],
  ])
  for (const line of envelope.trim().split('\n')) {
    if (line === '') continue
    const match = /^040000 tree ([0-9a-f]+)\t(head|index|worktree)$/.exec(line)
    if (match === null || expected.get(match[2] ?? '') !== match[1]) {
      throw new ChangeLedgerError('STATE_CORRUPT', `snapshot envelope is invalid for ${manifest.id}`)
    }
    expected.delete(match[2] ?? '')
  }
  if (expected.size !== 0) throw new ChangeLedgerError('STATE_CORRUPT', `snapshot envelope is incomplete for ${manifest.id}`)
  await verifyWorktreeEntries(manifest, signal)
}

/** Compare-and-swap delete a v2 private ref. */
export async function deleteGitCheckpoint(
  manifest: RestorePointManifestV2,
  storageDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await deleteGitCheckpointRef(manifest.workspace, manifest.git.ref, manifest.git.commit, storageDir, signal)
}

/** Delete an exact private ref target, including during startup journal reconciliation. */
export async function deleteGitCheckpointRef(
  workspace: string,
  ref: string,
  commit: string,
  storageDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!/^refs\/dsh-turn-rewind\/v2\/[0-9a-f]{32}\/[0-9a-f]{32}\/rp_[0-9a-z]+_[0-9a-f]{12}$/.test(ref)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'ref deletion metadata is malformed')
  }
  await ensureGitWorktreeIdentity(workspace, signal)
  await withHooksSandbox(storageDir, async (hooksDir) => {
    await runGit(workspace, ['-c', `core.hooksPath=${hooksDir}`, 'update-ref', '-d', ref, commit], signal)
  })
}

/** Read one v2 Git blob for selective restore. */
export async function readGitBlob(workspace: string, oid: string, expectedSize: number, signal?: AbortSignal): Promise<Buffer> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new ChangeLedgerError('STATE_CORRUPT', 'invalid Git blob id')
  return runGitBuffer(workspace, ['cat-file', 'blob', oid], signal, {
    maxBuffer: expectedSize + 1024,
    env: { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  })
}

async function verifyWorktreeEntries(manifest: RestorePointManifestV2, signal?: AbortSignal): Promise<void> {
  const output = await runGit(manifest.workspace, ['ls-tree', '-r', '-z', manifest.git.worktreeTree], signal, {
    env: { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  })
  const actual = new Map<string, { readonly mode: string; readonly oid: string }>()
  for (const record of splitNul(output)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
    if (match === null) throw new ChangeLedgerError('STATE_CORRUPT', `unsupported worktree tree entry in ${manifest.id}`)
    actual.set(validateRelativePath(match[3] ?? ''), { mode: match[1] ?? '', oid: match[2] ?? '' })
  }
  if (actual.size !== Object.keys(manifest.entries).length) {
    throw new ChangeLedgerError('STATE_CORRUPT', `worktree tree path count does not match manifest ${manifest.id}`)
  }
  const sizes = new Map<string, number>()
  for (const [path, entry] of Object.entries(manifest.entries)) {
    const treeEntry = actual.get(path)
    if (treeEntry === undefined) throw new ChangeLedgerError('STATE_CORRUPT', `worktree tree is missing ${JSON.stringify(path)}`)
    const expectedMode = entry.kind === 'symlink' ? '120000' : entry.mode & 0o111 ? '100755' : '100644'
    if (treeEntry.mode !== expectedMode) throw new ChangeLedgerError('STATE_CORRUPT', `worktree tree mode mismatch at ${JSON.stringify(path)}`)
    if (entry.kind === 'file') {
      if (entry.provider !== 'git' || treeEntry.oid !== entry.blob) {
        throw new ChangeLedgerError('STATE_CORRUPT', `worktree tree blob mismatch at ${JSON.stringify(path)}`)
      }
      sizes.set(entry.blob, entry.size)
    } else {
      const oid = strip(await runGitInput(manifest.workspace, ['hash-object', '--stdin'], Buffer.from(entry.target), signal))
      if (treeEntry.oid !== oid) throw new ChangeLedgerError('STATE_CORRUPT', `worktree symlink blob mismatch at ${JSON.stringify(path)}`)
    }
  }
  if (sizes.size === 0) return
  const checks = await runGitInput(
    manifest.workspace,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    `${[...sizes.keys()].join('\n')}\n`,
    signal,
    { env: { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' } },
  )
  for (const line of checks.trim().split('\n')) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line)
    if (match === null || sizes.get(match[1] ?? '') !== Number(match[2])) {
      throw new ChangeLedgerError('STATE_CORRUPT', `Git blob size verification failed for ${manifest.id}`)
    }
    sizes.delete(match[1] ?? '')
  }
  if (sizes.size !== 0) throw new ChangeLedgerError('STATE_CORRUPT', `Git blob verification was incomplete for ${manifest.id}`)
}

async function copyPrivateIndex(
  root: string,
  target: string,
  transactionDir: string,
  signal?: AbortSignal,
): Promise<{ readonly path: string; readonly info?: BigIntStats }> {
  const raw = strip(await runGit(root, ['rev-parse', '--git-path', 'index'], signal))
  const candidate = resolve(root, raw)
  try {
    const source = await realpath(candidate)
    const info = await lstat(source, { bigint: true })
    await copyFile(source, target)
    const shared = strip(await runGitOptional(root, ['rev-parse', '--shared-index-path'], signal) ?? '')
    if (shared !== '') await copyFile(await realpath(resolve(root, shared)), join(transactionDir, basename(shared)))
    return { path: source, info }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
    await open(target, 'wx', 0o600).then((handle) => handle.close())
    return { path: candidate }
  }
}

async function verifyStableCapture(options: {
  readonly source: Awaited<ReturnType<typeof discoverRepository>>
  readonly observed: ReadonlyMap<string, BigIntStats | undefined>
  readonly realIndex: { readonly path: string; readonly info?: BigIntStats }
  readonly attributes: ReadonlyMap<string, string>
  readonly configFence: string
  readonly hooksDir: string
  readonly signal?: AbortSignal
}): Promise<void> {
  const current = await discoverRepository(options.source.state.root, options.signal)
  if (!sameRepositoryFence(options.source.state, current.state)
    || !arraysEqual(options.source.paths, current.paths)
    || !arraysEqual(options.source.state.stagedPaths, current.state.stagedPaths)) {
    throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'repository or eligible path inventory changed during checkpoint capture')
  }
  if (options.realIndex.info !== undefined) {
    const currentIndex = await lstat(options.realIndex.path, { bigint: true })
    if (!sameStat(options.realIndex.info, currentIndex)) {
      throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'real Git index changed during checkpoint capture')
    }
  } else {
    try {
      await lstat(options.realIndex.path)
      throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'real Git index appeared during checkpoint capture')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
  for (const path of options.source.paths) {
    const expected = options.observed.get(path)
    try {
      const currentInfo = await lstat(resolveWorkspacePath(options.source.state.root, path), { bigint: true })
      if (expected === undefined || !sameStat(expected, currentInfo)) {
        throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `path changed during checkpoint capture: ${JSON.stringify(path)}`)
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT') && expected === undefined) continue
      throw error
    }
  }
  const finalConfig = await transformConfigFence(options.source.state.root, options.hooksDir, options.signal)
  const finalAttributes = await effectiveAttributes(options.source.state.root, options.source.paths, options.hooksDir, options.signal)
  if (finalConfig !== options.configFence || !mapsEqual(options.attributes, finalAttributes)) {
    throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', 'Git attributes or transformation configuration changed during checkpoint capture')
  }
}

async function rejectAmbiguousIndex(
  root: string,
  gitArgs: (args: readonly string[]) => string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const tags = splitNul(await runGit(root, gitArgs(['ls-files', '-v', '-z']), signal, { env }))
  const ambiguous = tags.find((record) => record.startsWith('S ') || /^[a-z] /.test(record))
  if (ambiguous !== undefined) {
    throw new ChangeLedgerError('GIT_INDEX_UNSUPPORTED', `skip-worktree/assume-unchanged path is unsupported: ${JSON.stringify(ambiguous.slice(2))}`)
  }
  const stages = parseIndexStages(await runGit(root, gitArgs(['ls-files', '--stage', '-z']), signal, { env }))
  const invalid = stages.find((entry) => entry.stage !== 0 || /^0+$/.test(entry.oid))
  if (invalid !== undefined) throw new ChangeLedgerError('GIT_INDEX_UNSUPPORTED', `unmerged or intent-to-add path is unsupported: ${JSON.stringify(invalid.path)}`)
}

async function rejectExternalObjectStores(root: string, commonDir: string, signal?: AbortSignal): Promise<void> {
  if (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES !== undefined) {
    throw new ChangeLedgerError('GIT_OBJECT_STORE_UNSUPPORTED', 'Git alternates are unsupported for durable v2 checkpoints')
  }
  try {
    if ((await stat(join(commonDir, 'objects', 'info', 'alternates'))).size > 0) {
      throw new ChangeLedgerError('GIT_OBJECT_STORE_UNSUPPORTED', 'Git alternates are unsupported for durable v2 checkpoints')
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  const promisor = await runGitOptional(root, ['config', '--get-regexp', '^remote\..*\.promisor$'], signal)
  const partialClone = await runGitOptional(root, ['config', '--get', 'extensions.partialClone'], signal)
  if ((promisor?.trim() ?? '') !== '' || (partialClone?.trim() ?? '') !== '') {
    throw new ChangeLedgerError('GIT_OBJECT_STORE_UNSUPPORTED', 'partial-clone/promisor repositories are unsupported for durable v2 checkpoints')
  }
}

async function effectiveAttributes(root: string, paths: readonly string[], hooksDir: string, signal?: AbortSignal): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map()
  const output = await runGitInput(
    root,
    ['-c', `core.hooksPath=${hooksDir}`, 'check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding', 'ident', 'text', 'eol'],
    `${paths.join('\0')}\0`,
    signal,
  )
  const parts = splitNul(output)
  if (parts.length % 3 !== 0) throw new ChangeLedgerError('GIT_ATTRIBUTE_PARSE_FAILED', 'git check-attr returned malformed output')
  const values = new Map<string, string[]>()
  for (let index = 0; index < parts.length; index += 3) {
    const path = validateRelativePath(parts[index] ?? '')
    const attr = parts[index + 1] ?? ''
    const value = parts[index + 2] ?? ''
    const current = values.get(path) ?? []
    current.push(`${attr}=${value}`)
    values.set(path, current)
  }
  const result = new Map<string, string>()
  for (const path of paths) {
    const attrs = values.get(path) ?? []
    const safe = attrs.every((item) => item.endsWith('=unspecified'))
    result.set(path, safe ? 'safe' : attrs.join('\0'))
  }
  return result
}

async function transformConfigFence(root: string, hooksDir: string, signal?: AbortSignal): Promise<string> {
  const values = await Promise.all(['core.autocrlf', 'core.eol', 'core.symlinks'].map(async (key) => {
    const value = strip(await runGitOptional(root, ['-c', `core.hooksPath=${hooksDir}`, 'config', '--get', key], signal) ?? '')
    return `${key}=${value}`
  }))
  const safe = (values[0] === 'core.autocrlf=' || values[0] === 'core.autocrlf=false')
    && (values[1] === 'core.eol=' || values[1] === 'core.eol=native')
    && (values[2] === 'core.symlinks=' || values[2] === 'core.symlinks=true')
  return `${values.join('\0')}\0${safe ? 'safe' : 'unsafe'}`
}

function parseIndex(output: string): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>()
  for (const entry of parseIndexStages(output)) {
    if (entry.stage === 0) map.set(entry.path, { mode: entry.mode, oid: entry.oid })
  }
  return map
}

function parseIndexStages(output: string): Array<{ readonly mode: string; readonly oid: string; readonly stage: number; readonly path: string }> {
  return splitNul(output).map((record) => {
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
    if (match === null) throw new ChangeLedgerError('GIT_INDEX_PARSE_FAILED', `cannot parse index record: ${JSON.stringify(record.slice(0, 200))}`)
    return { mode: match[1] ?? '', oid: match[2] ?? '', stage: Number(match[3]), path: validateRelativePath(match[4] ?? '') }
  })
}

function isIndexEquivalent(info: BigIntStats, mode: string): boolean {
  if (info.isSymbolicLink()) return mode === '120000'
  if (!info.isFile()) return false
  return mode === (Number(info.mode & 0o111n) === 0 ? '100644' : '100755')
}

async function withHooksSandbox<T>(storageDir: string, task: (hooksDir: string) => Promise<T>): Promise<T> {
  const root = join(storageDir, 'hook-sandboxes')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const hooksDir = await mkdtemp(join(root, 'hooks-'))
  try {
    return await task(hooksDir)
  } finally {
    await rm(hooksDir, { recursive: true, force: true })
  }
}

async function stableReadFile(target: string, before: BigIntStats, path: string, signal?: AbortSignal): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted()
    let handle
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isNodeError(error, 'ELOOP')) {
        throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `file became a symlink while captured: ${JSON.stringify(path)}`)
      }
      throw error
    }
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameStat(before, opened)) {
        before = opened
        continue
      }
      const content = await handle.readFile()
      const after = await handle.stat({ bigint: true })
      if (sameStat(opened, after) && BigInt(content.length) === after.size) return content
      before = after
    } finally {
      await handle.close()
    }
  }
  throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `path changed repeatedly while captured: ${JSON.stringify(path)}`)
}

async function stableReadlink(target: string, before: BigIntStats, path: string, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted()
    const value = await readlink(target)
    const after = await lstat(target, { bigint: true })
    if (sameStat(before, after)) return value
    before = after
  }
  throw new ChangeLedgerError('WORKSPACE_CHANGED_DURING_CAPTURE', `symlink changed repeatedly while captured: ${JSON.stringify(path)}`)
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function makeCacheRecord(
  info: BigIntStats,
  indexOid: string | undefined,
  attributes: string,
  oid: string,
  target?: string,
): CacheRecord {
  return {
    kind: info.isSymbolicLink() ? 'symlink' : 'file',
    mode: Number(info.mode & 0o777n),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    ...(indexOid === undefined ? {} : { indexOid }),
    attributes,
    oid,
    ...(target === undefined ? {} : { target }),
  }
}

function cacheMatches(record: CacheRecord, info: BigIntStats, indexOid: string | undefined, attributes: string): boolean {
  return record.kind === (info.isSymbolicLink() ? 'symlink' : 'file')
    && record.mode === Number(info.mode & 0o777n)
    && record.size === info.size.toString()
    && record.mtimeNs === info.mtimeNs.toString()
    && record.ctimeNs === info.ctimeNs.toString()
    && record.dev === info.dev.toString()
    && record.ino === info.ino.toString()
    && record.indexOid === indexOid
    && record.attributes === attributes
}

async function gitBlobExists(root: string, oid: string, hooksDir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(root, ['-c', `core.hooksPath=${hooksDir}`, 'cat-file', '-e', `${oid}^{blob}`], signal)
    return true
  } catch (error) {
    if (error instanceof ChangeLedgerError && error.code === 'GIT_COMMAND_FAILED') return false
    throw error
  }
}

async function gitBlobText(root: string, oid: string, hooksDir: string, signal?: AbortSignal): Promise<string> {
  return runGit(root, ['-c', `core.hooksPath=${hooksDir}`, 'cat-file', 'blob', oid], signal)
}

async function readCache(workspaceDir: string, storeId: string, worktreeId: string): Promise<GitCache> {
  const empty = () => makeCache(storeId, worktreeId, {})
  try {
    const value = JSON.parse(await readFile(join(workspaceDir, 'git-cache.json'), 'utf8')) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return empty()
    const record = value as { version?: unknown; storeId?: unknown; worktreeId?: unknown; paths?: unknown; checksum?: unknown }
    if (record.version !== 2
      || record.storeId !== storeId
      || record.worktreeId !== worktreeId
      || record.paths === null
      || typeof record.paths !== 'object'
      || Array.isArray(record.paths)
      || typeof record.checksum !== 'string'
      || record.checksum !== cacheChecksum(storeId, worktreeId, record.paths as Record<string, unknown>)) {
      return empty()
    }
    const paths: Record<string, CacheRecord> = Object.create(null) as Record<string, CacheRecord>
    for (const [rawPath, rawRecord] of Object.entries(record.paths as Record<string, unknown>)) {
      try {
        const path = validateRelativePath(rawPath)
        paths[path] = parseCacheRecord(rawRecord)
      } catch {
        // Cache entries are advisory. Ignore malformed records instead of failing open or blocking capture.
      }
    }
    return makeCache(storeId, worktreeId, paths)
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) return empty()
    throw error
  }
}

function makeCache(storeId: string, worktreeId: string, paths: Readonly<Record<string, CacheRecord>>): GitCache {
  const sortedPaths: Record<string, CacheRecord> = Object.create(null) as Record<string, CacheRecord>
  for (const path of Object.keys(paths).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
    const record = paths[path]
    if (record !== undefined) sortedPaths[path] = record
  }
  return {
    version: 2,
    storeId,
    worktreeId,
    paths: sortedPaths,
    checksum: cacheChecksum(storeId, worktreeId, sortedPaths),
  }
}

function cacheChecksum(storeId: string, worktreeId: string, paths: Readonly<Record<string, unknown>>): string {
  const sortedPaths: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const path of Object.keys(paths).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
    sortedPaths[path] = paths[path]
  }
  return createHash('sha256').update(JSON.stringify({ version: 2, storeId, worktreeId, paths: sortedPaths })).digest('hex')
}

function parseCacheRecord(value: unknown): CacheRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid cache record')
  const record = value as Record<string, unknown>
  if (record.kind !== 'file' && record.kind !== 'symlink') throw new Error('invalid cache kind')
  if (!Number.isSafeInteger(record.mode) || (record.mode as number) < 0 || (record.mode as number) > 0o777) {
    throw new Error('invalid cache mode')
  }
  const decimal = (key: string) => {
    const field = record[key]
    if (typeof field !== 'string' || !/^(?:0|[1-9]\d*)$/.test(field)) throw new Error(`invalid cache ${key}`)
    return field
  }
  const oid = cacheOid(record.oid)
  const indexOid = record.indexOid === undefined ? undefined : cacheOid(record.indexOid)
  if (typeof record.attributes !== 'string') throw new Error('invalid cache attributes')
  const target = record.target
  if (record.kind === 'symlink') {
    if (typeof target !== 'string' || target.includes('\0')) throw new Error('invalid cached symlink target')
  } else if (target !== undefined) {
    throw new Error('file cache record carries a symlink target')
  }
  return {
    kind: record.kind,
    mode: record.mode as number,
    size: decimal('size'),
    mtimeNs: decimal('mtimeNs'),
    ctimeNs: decimal('ctimeNs'),
    dev: decimal('dev'),
    ino: decimal('ino'),
    ...(indexOid === undefined ? {} : { indexOid }),
    attributes: record.attributes,
    oid,
    ...(target === undefined ? {} : { target }),
  }
}

function cacheOid(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error('invalid cache object id')
  return value
}

async function writeCache(workspaceDir: string, cache: GitCache): Promise<void> {
  await mkdir(workspaceDir, { recursive: true })
  const path = join(workspaceDir, 'git-cache.json')
  const temporary = join(workspaceDir, `.git-cache-${randomBytes(6).toString('hex')}.tmp`)
  await open(temporary, 'wx', 0o600).then(async (handle) => {
    try {
      await handle.writeFile(`${JSON.stringify(cache)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
  await rename(temporary, path)
}

function ledgerWorkspaceDir(storageDir: string, commonDir: string, worktreeId: string): string {
  const key = `git-${createHash('sha256').update(`${commonDir}\0${worktreeId}`).digest('hex')}`
  return join(storageDir, 'workspaces', key)
}

function enforceNewContentLimit(bytes: number, maximum: number): void {
  if (bytes > maximum) {
    throw new ChangeLedgerError('TURN_CHECKPOINT_NEW_CONTENT_LIMIT', `automatic checkpoint needs ${bytes} new bytes; limit is ${maximum}`)
  }
}

function enforceSnapshotLimit(bytes: number, maximum: number): void {
  if (bytes > maximum) {
    throw new ChangeLedgerError('SNAPSHOT_TOO_LARGE', `eligible files exceed configured aggregate limit of ${maximum} bytes`)
  }
}

function parseObjectFormat(value: string): 'sha1' | 'sha256' {
  const format = strip(value)
  if (format !== 'sha1' && format !== 'sha256') throw new ChangeLedgerError('GIT_OBJECT_FORMAT_UNSUPPORTED', `unsupported Git object format ${JSON.stringify(format)}`)
  return format
}

function splitNul(value: string): string[] {
  if (value === '') return []
  const parts = value.split('\0')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

function strip(value: string): string {
  return value.replace(/\r?\n$/, '')
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) if (right.get(key) !== value) return false
  return true
}
