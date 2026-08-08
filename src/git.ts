import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ChangeLedgerError, errorMessage } from './errors.js'
import { canonicalDirectory, isNodeError, validateRelativePath } from './path-utils.js'
import type { RepositoryState } from './types.js'

const GIT_MAX_BUFFER = 32 * 1024 * 1024

/** Repository discovery result plus the eligible path inventory. */
export interface RepositorySnapshotSource {
  readonly state: RepositoryState
  readonly paths: readonly string[]
}

/** Discover the Git worktree owning `cwd` and enumerate tracked/non-ignored paths. */
export async function discoverRepository(cwd: string, signal?: AbortSignal): Promise<RepositorySnapshotSource> {
  const canonicalCwd = await canonicalDirectory(cwd)
  const rootRaw = await git(canonicalCwd, ['rev-parse', '--show-toplevel'], signal)
  const root = await realpath(stripLineEnding(rootRaw))
  if (!isAbsolute(root)) {
    throw new ChangeLedgerError('GIT_ROOT_INVALID', `git returned a non-absolute worktree root: ${JSON.stringify(root)}`)
  }

  const sparse = (await gitOptional(root, ['config', '--bool', '--get', 'core.sparseCheckout'], signal))?.trim() === 'true'
  if (sparse) {
    throw new ChangeLedgerError('SPARSE_CHECKOUT_UNSUPPORTED', 'sparse-checkout worktrees are not supported because absent paths are ambiguous')
  }

  const gitDirRaw = stripLineEnding(await git(root, ['rev-parse', '--git-dir'], signal))
  const gitDir = await realpath(resolve(root, gitDirRaw))
  const commonDirRaw = stripLineEnding(await git(root, ['rev-parse', '--git-common-dir'], signal))
  const commonDir = await realpath(resolve(root, commonDirRaw))

  const stageOutput = await git(root, ['ls-files', '--stage', '-z'], signal)
  const submodules = parseSubmodules(stageOutput)
  if (submodules.length > 0) {
    throw new ChangeLedgerError(
      'SUBMODULE_UNSUPPORTED',
      `submodules require independent restore points; unsupported gitlinks: ${submodules.slice(0, 10).join(', ')}`,
    )
  }

  const pathOutput = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)
  const paths = [...new Set(splitNul(pathOutput).map(validateRelativePath))].sort(comparePaths)
  const head = trimOptional(await gitOptional(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal))
  const branch = trimOptional(await gitOptional(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal))
  const stagedOutput = await git(root, ['diff', '--cached', '--name-only', '-z'], signal)
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

/** Return true when two repository fences refer to the same checkout state. */
export function sameRepositoryFence(left: RepositoryState, right: RepositoryState): boolean {
  return left.root === right.root
    && left.commonDir === right.commonDir
    && left.head === right.head
    && left.branch === right.branch
    && left.operation === right.operation
}

async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      signal,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout, stderr) => {
      if (error !== null) {
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

async function gitOptional(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await git(cwd, args, signal)
  } catch (error) {
    if (error instanceof ChangeLedgerError && error.code === 'GIT_COMMAND_FAILED' && gitExitCode(error.cause) === 1) return undefined
    throw error
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

/** Return the Git metadata directory for diagnostics. */
export function gitMetadataParent(state: RepositoryState): string {
  return dirname(state.commonDir)
}
