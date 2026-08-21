import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ChangeLedgerError, errorMessage } from './errors.js'
import { canonicalDirectory, isNodeError, syncDirectory, validateRelativePath } from './path-utils.js'
import type { RepositoryState } from './types.js'

const GIT_MAX_BUFFER = 32 * 1024 * 1024

/** Repository discovery result plus the eligible path inventory. */
export interface RepositorySnapshotSource {
  readonly state: RepositoryState
  readonly paths: readonly string[]
}

/** Durable identity and shared lock location for one concrete Git worktree. */
export interface GitWorktreeIdentity {
  readonly root: string
  readonly gitDir: string
  readonly commonDir: string
  readonly worktreeId: string
  readonly lockPath: string
}

/** Discover the Git worktree owning `cwd` and enumerate tracked/non-ignored paths. */
export async function discoverRepository(cwd: string, signal?: AbortSignal): Promise<RepositorySnapshotSource> {
  const root = await discoverRepositoryRoot(cwd, signal)

  const sparse = (await runGitOptional(root, ['config', '--bool', '--get', 'core.sparseCheckout'], signal))?.trim() === 'true'
  if (sparse) {
    throw new ChangeLedgerError('SPARSE_CHECKOUT_UNSUPPORTED', 'sparse-checkout worktrees are not supported because absent paths are ambiguous')
  }

  const gitDirRaw = stripLineEnding(await runGit(root, ['rev-parse', '--git-dir'], signal))
  const gitDir = await realpath(resolve(root, gitDirRaw))
  const commonDirRaw = stripLineEnding(await runGit(root, ['rev-parse', '--git-common-dir'], signal))
  const commonDir = await realpath(resolve(root, commonDirRaw))

  const stageOutput = await runGit(root, ['ls-files', '--stage', '-z'], signal)
  const submodules = parseSubmodules(stageOutput)
  if (submodules.length > 0) {
    throw new ChangeLedgerError(
      'SUBMODULE_UNSUPPORTED',
      `submodules require independent restore points; unsupported gitlinks: ${submodules.slice(0, 10).join(', ')}`,
    )
  }

  const pathOutput = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)
  // `ls-files --others` refuses to descend into embedded repositories, such as a
  // linked worktree nested inside this checkout; it reports the directory itself
  // with a trailing slash (for example `nested/`). Those directories are separate
  // checkouts, not files of this worktree, so exclude them from the snapshot
  // inventory instead of rejecting the entry as a non-canonical path.
  const paths = [...new Set(splitNul(pathOutput)
    .filter((path) => !path.endsWith('/'))
    .map(validateRelativePath))].sort(comparePaths)
  const head = trimOptional(await runGitOptional(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal))
  const branch = trimOptional(await runGitOptional(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal))
  const stagedOutput = await runGit(root, ['diff', '--cached', '--name-only', '-z'], signal)
  const stagedPaths = splitNul(stagedOutput).map(validateRelativePath).sort(comparePaths)
  const operation = await gitOperation(gitDir)

  return {
    state: {
      root,
      commonDir,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
      ...(operation === undefined ? {} : { operation }),
      stagedPaths,
    },
    paths,
  }
}

/** Resolve the canonical Git worktree root owning `cwd` without inventorying its files. */
export async function discoverRepositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const canonicalCwd = await canonicalDirectory(cwd)
  const rootRaw = await runGit(canonicalCwd, ['rev-parse', '--show-toplevel'], signal)
  const root = await realpath(stripLineEnding(rootRaw))
  if (!isAbsolute(root)) {
    throw new ChangeLedgerError('GIT_ROOT_INVALID', `git returned a non-absolute worktree root: ${JSON.stringify(root)}`)
  }
  return root
}

/** Create or read the per-worktree identity used by refs and cross-store locking. */
export async function ensureGitWorktreeIdentity(cwd: string, signal?: AbortSignal): Promise<GitWorktreeIdentity> {
  const root = await discoverRepositoryRoot(cwd, signal)
  const gitDir = await realpath(resolve(root, stripLineEnding(await runGit(root, ['rev-parse', '--git-dir'], signal))))
  const commonDir = await realpath(resolve(root, stripLineEnding(await runGit(root, ['rev-parse', '--git-common-dir'], signal))))
  const identityDir = join(gitDir, 'dsh-turn-rewind')
  await mkdir(identityDir, { recursive: true, mode: 0o700 })
  const worktreeId = await ensureWorktreeId(identityDir, commonDir, gitDir)
  return {
    root,
    gitDir,
    commonDir,
    worktreeId,
    lockPath: join(commonDir, 'dsh-turn-rewind', 'locks', `${worktreeId}.json`),
  }
}

/** Resolve a moved linked worktree from its common directory and durable identity. */
export async function resolveGitWorktreeRoot(
  commonDir: string,
  worktreeId: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<string> {
  const candidates = [fallback]
  try {
    const output = await runGit(commonDir, [`--git-dir=${commonDir}`, 'worktree', 'list', '--porcelain', '-z'], signal)
    for (const record of output.split('\0\0')) {
      const first = record.split('\0', 1)[0]
      if (first?.startsWith('worktree ')) candidates.push(first.slice('worktree '.length))
    }
  } catch {
    // The fallback below still gives deterministic failure details if the common directory is gone.
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const identity = await readGitWorktreeIdentity(candidate, signal)
      if (identity.worktreeId === worktreeId && identity.commonDir === commonDir) return identity.root
    } catch {
      // Missing/pruned/unrelated worktrees are not candidates for this durable identity.
    }
  }
  throw new ChangeLedgerError('GIT_WORKTREE_MISSING', `cannot locate Git worktree ${worktreeId} under ${JSON.stringify(commonDir)}`)
}

/** Return true when two repository fences refer to the same checkout state. */
export function sameRepositoryFence(left: RepositoryState, right: RepositoryState): boolean {
  return left.root === right.root
    && left.commonDir === right.commonDir
    && left.head === right.head
    && left.branch === right.branch
    && left.operation === right.operation
}

/** Run Git with stable non-interactive defaults and return UTF-8 output. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  options: { readonly env?: NodeJS.ProcessEnv; readonly maxBuffer?: number } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      windowsHide: true,
      signal,
      env: gitEnvironment(options.env),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        if (signal?.aborted === true) {
          reject(signal.reason ?? error)
          return
        }
        reject(new ChangeLedgerError(
          'GIT_COMMAND_FAILED',
          `git ${args.join(' ')} failed in ${JSON.stringify(cwd)}: ${stderr.trim() || errorMessage(error)}`,
          { cause: error },
        ))
        return
      }
      resolvePromise(stdout)
    })
  })
}

/** Run Git and return undefined for its ordinary "not found" exit status. */
export async function runGitOptional(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  options: { readonly env?: NodeJS.ProcessEnv; readonly maxBuffer?: number } = {},
): Promise<string | undefined> {
  try {
    return await runGit(cwd, args, signal, options)
  } catch (error) {
    if (error instanceof ChangeLedgerError && error.code === 'GIT_COMMAND_FAILED' && gitExitCode(error.cause) === 1) return undefined
    throw error
  }
}

/** Run Git with binary stdin and return UTF-8 stdout. */
export async function runGitInput(
  cwd: string,
  args: readonly string[],
  input: Buffer | string,
  signal?: AbortSignal,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      windowsHide: true,
      signal,
      env: gitEnvironment(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= GIT_MAX_BUFFER) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      if (signal?.aborted === true) {
        reject(signal.reason ?? error)
        return
      }
      reject(new ChangeLedgerError(
        'GIT_COMMAND_FAILED',
        `git ${args.join(' ')} failed in ${JSON.stringify(cwd)}: ${errorMessage(error)}`,
        { cause: error },
      ))
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        settled = true
        const message = Buffer.concat(stderr).toString('utf8').trim()
        reject(new ChangeLedgerError(
          'GIT_COMMAND_FAILED',
          `git ${args.join(' ')} failed in ${JSON.stringify(cwd)}: ${message || `exit ${String(code)}`}`,
        ))
        return
      }
      if (stdoutBytes > GIT_MAX_BUFFER) {
        settled = true
        reject(new ChangeLedgerError('GIT_COMMAND_FAILED', `git ${args.join(' ')} output exceeded ${GIT_MAX_BUFFER} bytes`))
        return
      }
      settled = true
      resolvePromise(Buffer.concat(stdout).toString('utf8'))
    })
    child.stdin.end(input)
  })
}

/** Run Git and return raw stdout bytes. */
export async function runGitBuffer(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  options: { readonly env?: NodeJS.ProcessEnv; readonly maxBuffer?: number } = {},
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      windowsHide: true,
      signal,
      env: gitEnvironment(options.env),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        if (signal?.aborted === true) {
          reject(signal.reason ?? error)
          return
        }
        reject(new ChangeLedgerError(
          'GIT_COMMAND_FAILED',
          `git ${args.join(' ')} failed in ${JSON.stringify(cwd)}: ${stderr.toString('utf8').trim() || errorMessage(error)}`,
          { cause: error },
        ))
        return
      }
      resolvePromise(stdout)
    })
  })
}

function gitEnvironment(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_QUARANTINE_PATH',
    'GIT_REPLACE_REF_BASE',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
  ]) delete env[key]
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key]
  }
  return {
    ...env,
    ...extra,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function gitExitCode(error: unknown): string | number | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function splitNul(value: string): string[] {
  if (value === '') return []
  const parts = value.split('\0')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

function parseSubmodules(value: string): string[] {
  const paths: string[] = []
  for (const record of splitNul(value)) {
    const match = /^(\d{6}) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(record)
    if (match === null) {
      throw new ChangeLedgerError('GIT_INDEX_PARSE_FAILED', `cannot parse git index record: ${JSON.stringify(record.slice(0, 200))}`)
    }
    if (match[1] === '160000') paths.push(validateRelativePath(match[2] ?? ''))
  }
  return paths.sort(comparePaths)
}

async function gitOperation(gitDir: string): Promise<string | undefined> {
  const markers: readonly [string, string][] = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ]
  for (const [marker, operation] of markers) {
    try {
      await lstat(resolve(gitDir, marker))
      return operation
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
  return undefined
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function stripLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n')) return value.slice(0, -1)
  return value
}

function comparePaths(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}

function parseWorktreeId(value: string): string {
  const worktreeId = value.trim()
  if (!/^[0-9a-f]{32}$/.test(worktreeId)) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git worktree identity is malformed')
  }
  return worktreeId
}

async function readGitWorktreeIdentity(cwd: string, signal?: AbortSignal): Promise<GitWorktreeIdentity> {
  const root = await discoverRepositoryRoot(cwd, signal)
  const gitDir = await realpath(resolve(root, stripLineEnding(await runGit(root, ['rev-parse', '--git-dir'], signal))))
  const commonDir = await realpath(resolve(root, stripLineEnding(await runGit(root, ['rev-parse', '--git-common-dir'], signal))))
  const worktreeId = await ensureWorktreeId(join(gitDir, 'dsh-turn-rewind'), commonDir, gitDir)
  return {
    root,
    gitDir,
    commonDir,
    worktreeId,
    lockPath: join(commonDir, 'dsh-turn-rewind', 'locks', `${worktreeId}.json`),
  }
}

async function ensureWorktreeId(identityDir: string, commonDir: string, gitDir: string): Promise<string> {
  const identityPath = join(identityDir, 'worktree-id')
  const backupPath = join(identityDir, 'worktree-id.backup')
  const initializedPath = join(identityDir, 'worktree-id.initialized')
  const localPaths = [identityPath, backupPath, initializedPath]
  const centralDir = join(commonDir, 'dsh-turn-rewind-worktree-identities')
  const centralPath = join(centralDir, `${createHash('sha256').update(gitDir).digest('hex')}.id`)
  await mkdir(identityDir, { recursive: true, mode: 0o700 })
  await mkdir(centralDir, { recursive: true, mode: 0o700 })
  const localCopies = await Promise.all(localPaths.map(readIdentityCopy))
  const centralCopy = await readIdentityCopy(centralPath)
  const valid = [...localCopies, centralCopy].flatMap(copy => copy.value === undefined ? [] : [copy.value])
  if (new Set(valid).size > 1) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git worktree identity copies disagree')
  }
  const localValid = localCopies.flatMap(copy => copy.value === undefined ? [] : [copy.value])
  const localDurable = localValid[0]
  const durable = localDurable ?? (gitDir === commonDir ? centralCopy.value : undefined)
  if (durable !== undefined) {
    for (const path of [...localPaths, centralPath]) {
      if (await publishIdentityFile(path, durable, true) !== durable) {
        throw new ChangeLedgerError('STATE_CORRUPT', `Git worktree identity copy disagrees at ${JSON.stringify(path)}`)
      }
    }
    await syncDirectory(identityDir)
    await syncDirectory(centralDir)
    return durable
  }
  if (localCopies.some(copy => copy.malformed) || centralCopy.malformed) {
    throw new ChangeLedgerError('STATE_CORRUPT', 'Git worktree identity is malformed and no valid durable copy remains')
  }
  if (gitDir !== commonDir && centralCopy.value !== undefined) {
    throw new ChangeLedgerError(
      'STATE_CORRUPT',
      'linked Git worktree identity is ambiguous because only a detached central copy remains',
    )
  }
  const candidate = randomBytes(16).toString('hex')
  const chosen = await publishIdentityFile(identityPath, candidate, false)
  for (const path of [backupPath, initializedPath, centralPath]) {
    if (await publishIdentityFile(path, chosen, true) !== chosen) {
      throw new ChangeLedgerError('STATE_CORRUPT', `Git worktree identity copy disagrees at ${JSON.stringify(path)}`)
    }
  }
  await syncDirectory(identityDir)
  await syncDirectory(centralDir)
  return chosen
}

interface IdentityCopy {
  readonly value?: string
  readonly malformed: boolean
}

async function readIdentityCopy(path: string): Promise<IdentityCopy> {
  try {
    return { value: parseWorktreeId(await readFile(path, 'utf8')), malformed: false }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { malformed: false }
    if (error instanceof ChangeLedgerError && error.code === 'STATE_CORRUPT') return { malformed: true }
    throw error
  }
}

async function publishIdentityFile(path: string, value: string, repairMalformed: boolean): Promise<string> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomBytes(16).toString('hex')}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${value}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await link(temporary, path)
        await syncDirectory(directory)
        return value
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
      }
      const existing = await readIdentityCopy(path)
      if (existing.value !== undefined) return existing.value
      if (!existing.malformed) continue
      if (!repairMalformed) {
        throw new ChangeLedgerError('STATE_CORRUPT', `Git worktree identity copy is malformed at ${JSON.stringify(path)}`)
      }
      try {
        await unlink(path)
        await syncDirectory(directory)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
    throw new ChangeLedgerError('STATE_CORRUPT', `could not repair Git worktree identity copy at ${JSON.stringify(path)}`)
  } finally {
    try {
      await unlink(temporary)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
}

/** Return the Git metadata directory for diagnostics. */
export function gitMetadataParent(state: RepositoryState): string {
  return dirname(state.commonDir)
}
