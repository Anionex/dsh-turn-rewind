# Change Ledger durable format v1

The state root defaults to `$DSH_HOME/change-ledger/v1`, falling back to `~/.dsh/change-ledger/v1`. It must not overlap a managed worktree.

```text
v1/
└── workspaces/
    └── <sha256(canonical-worktree-path)>/
        ├── lock.json
        ├── manifests/
        │   └── rp_<time>_<random>.json
        ├── operations/
        │   └── op_<time>_<random>.json
        └── blobs/
            └── <first-two-hex>/
                └── <sha256>
```

Every JSON write uses a sibling temporary file followed by rename. Blob publication writes and fsyncs a sibling temporary file, then creates the final content-addressed name through an atomic hard link. Existing blobs are read back and hash-verified.

## Restore-point manifest

```ts
interface RestorePointManifestV1 {
  version: 1
  id: `rp_${string}`
  kind: 'user' | 'rescue' | 'turn'
  workspace: string
  repository: {
    root: string
    commonDir: string
    head?: string
    branch?: string
    operation?: string
    stagedPaths: string[]
  }
  sessionId?: string
  label?: string
  parentRestorePoint?: string
  turn?: number
  turnEndSeq?: number
  createdAt: number
  treeHash: string
  fileCount: number
  totalBytes: number
  entries: Record<string, FileEntry | SymlinkEntry>
  restoreCount: number
  lastRestoredAt?: number
}

interface FileEntry {
  kind: 'file'
  blob: string
  size: number
  mode: number
}

interface SymlinkEntry {
  kind: 'symlink'
  target: string
  mode: number
}
```

`turn` manifests are automatic, hidden checkpoints used by the Web rewind surface. They require `sessionId`, `turn`, and the inclusive `turnEndSeq`; those fields are rejected on `user` and `rescue` manifests. This is an additive version-1 shape: pre-existing version-1 user and rescue manifests remain valid, while malformed or partially anchored turn manifests fail closed.

Entry keys are canonical Git-style relative paths using `/`. Absolute paths, empty segments, `.` segments, `..` segments, and NUL bytes are rejected before filesystem resolution.

`treeHash` is SHA-256 over every sorted path and its complete type/content/mode signature. Readers recompute it from validated entries and reject mismatches. Regular-file blobs are SHA-256 addressed and verified on every restore read.

## Restore operation

```ts
interface RestoreOperationV1 {
  version: 1
  id: `op_${string}`
  workspace: string
  restorePointId: string
  rescuePointId: string
  sessionId?: string
  paths: string[]
  startedAt: number
  finishedAt?: number
  state:
    | 'running'
    | 'rollback-running'
    | 'completed'
    | 'rolled-back'
    | 'interrupted'
    | 'recovery-required'
  error?: string
  rollbackError?: string
}
```

`running` and `rollback-running` are non-terminal. Startup changes them to `interrupted` only when the workspace has no live lock owner. Terminal journals remain as local audit evidence; restore-point deletion never removes an incomplete journal's referenced point.

## Compatibility

Readers reject unknown `version` values and malformed durable data. There is no best-effort fallback, path normalization, or legacy coercion. A future incompatible format must use a new state-root version and an explicit migration tool.
