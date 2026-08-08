# DSH Change Ledger

[中文说明](README.zh.md)

Persistent, reviewable, and safely restorable working-tree change sets for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Change Ledger gives a DSH session an explicit safety boundary around workspace mutations:

```text
create restore point
        ↓
agent / user / external tools modify the worktree
        ↓
inspect exact path-level drift
        ↓
plan a full or selective restore
        ↓
echo the short-lived confirmation + approve in DSH
        ↓
create rescue point → restore → verify
```

It never commits, stashes, resets, switches branches, edits the Git index, or decides automatically that a change should be reverted.

## Why this is a standalone service

A diff button can show current changes, but it does not own a durable restore lifecycle. Change Ledger owns:

- content-addressed restore-point manifests;
- Git worktree, HEAD, branch, and in-progress-operation fences;
- stale-plan detection between review and mutation;
- exact two-step confirmation plus DSH human approval;
- automatic pre-restore rescue points;
- post-restore hash verification;
- rollback after a failed restore;
- startup reconciliation of interrupted restore journals;
- a public `ctx.changeLedger` service that other plugins can consume.

The durable format is documented in [docs/FORMAT.md](docs/FORMAT.md). The security and failure model is documented in [SECURITY.md](SECURITY.md).

## Safety contract

- **Explicit only:** the tool descriptions instruct the model to create a point only after an explicit user request.
- **Read before write:** `change_ledger_plan_restore` returns an expiring confirmation value but changes no files.
- **Human gate:** `change_ledger_apply_restore` and `change_ledger_delete` always return a DSH `ask` decision before dispatch. An unattended `approval: never` profile fails closed.
- **Rescue before mutation:** every restore captures the current eligible tree as a durable rescue point before changing a path.
- **No silent omission:** unsupported submodules, sparse checkouts, oversized files, aggregate limits, and unsupported file types fail point creation.
- **No path escape:** every durable path is canonical and workspace-relative; restore refuses symlink parents and non-empty directory replacement.
- **No stale overwrite:** selected paths and the reviewed HEAD/branch/operation fence are checked again at apply time. Any relevant post-review change invalidates the plan.
- **No Git control-plane mutation:** the index, branch, HEAD, stash, and commits remain untouched.

## Scope

Version `0.1` intentionally supports normal Git worktrees only:

- tracked files, including currently missing tracked paths;
- untracked files not excluded by `.gitignore` or other standard Git excludes;
- regular files, binary or text;
- symbolic links;
- executable and other portable permission bits.

The following are rejected or deliberately outside the snapshot:

- sparse checkouts;
- submodule gitlinks (create a restore point inside each submodule instead);
- ignored files;
- special files, sockets, devices, and named pipes;
- extended attributes, ACLs, ownership, timestamps, and hard-link topology;
- the Git index and repository metadata;
- non-Git directories.

If an ignored or otherwise unmanaged file occupies a path that restoration would replace, the restore fails rather than deleting it.

## Install

Build the checked-out plugin, then add it to each DSH profile that should expose the service:

```sh
pnpm install --frozen-lockfile
pnpm run check

dsh plugin --profile web add /path/to/dsh-change-ledger
dsh plugin --profile headless add /path/to/dsh-change-ledger

dsh --profile web --dump-config | grep change-ledger
```

Restart a running profile after changing its bundle list.

The package is a DSH Profile Bundle. `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` mounts `@dsh-external/change-ledger` without a DSH core patch.

When the profile also provides the DSH Agent service, the plugin claims the Agent's idle maintenance boundary after each completed turn and captures a hidden checkpoint before queued work may start another turn. In Web profiles, the same-origin `/change-ledger/rewind` endpoint exposes a bounded preview and mints the ordinary short-lived, session-bound restore plan used by the browser surface. It never restores merely because a turn completed.

## User flow

In the Web profile, each finalized assistant turn gains a compact **Rewind** action in the official `conversation.chat.turnTail` extension point. Opening it fetches the checkpoint lazily, shows every affected path up to the bounded preview cap, blocks HEAD/Git-operation drift, and requires an explicit acknowledgement before code restoration. The current conversation stays in place for this first Web mode.

Example requests:

```text
Create a Change Ledger restore point called "before auth refactor".

Inspect restore point rp_... and show the first 100 changed paths.

Plan restoring only src/auth.ts and tests/auth.test.ts from rp_....

Apply plan plan_... with confirmation RESTORE-....
```

The last step still opens the normal DSH approval prompt. A confirmation copied from the plan does not bypass approval.

## Tools

| Tool | Mutation | Purpose |
| --- | --- | --- |
| `change_ledger_create` | State store only | Capture a user restore point. |
| `change_ledger_list` | None | Paginate points; rescue points are hidden by default. |
| `change_ledger_inspect` | None | Paginate current drift from a point. |
| `change_ledger_plan_restore` | In-memory plan only | Select exact paths and mint an expiring confirmation. |
| `change_ledger_apply_restore` | Workspace | Approval-gated rescue, restore, and verification. |
| `change_ledger_delete` | State store | Approval-gated deletion and blob garbage collection. |
| `change_ledger_recovery_list` | None | Paginate interrupted operations and their rescue points. |

All model-visible list, inspect, recovery, plan, and apply payloads are paginated or summarized. The same-process service API returns complete structured values to trusted plugin consumers.

## Configuration

Override configuration in the profile patch layer:

```yaml
- id: change-ledger
  config:
    storageDir: ~/.dsh/change-ledger/v1
    maxRestorePoints: 50
    maxTurnCheckpointsPerSession: 30
    maxFiles: 20000
    maxFileBytes: 16777216
    maxSnapshotBytes: 536870912
    planTtlMs: 900000
    staleLockMs: 30000
```

All size and user-point retention limits fail loudly. Automatic turn checkpoints have a separate per-session retention window and prune only their own oldest checkpoints; user and rescue restore points are never silently pruned. When omitted, `storageDir` resolves to `$DSH_HOME/change-ledger/v1` and falls back to `~/.dsh/change-ledger/v1`; it must not overlap the managed worktree.

## Recovery

Before writing any path, a restore creates a rescue point and a durable operation journal. If DSH stops with a non-terminal journal, the next plugin startup marks it `interrupted` unless another live DSH process still owns that workspace lock.

Use `change_ledger_recovery_list` to find the operation's `rescuePointId`, inspect that rescue point, then use the normal plan/apply flow for the affected paths. Rescue points remain ordinary, inspectable restore points until explicitly deleted.

## Public service

Other Cordis plugins can inject `changeLedger` and call the same lifecycle without parsing model-facing text:

```ts
export const inject = ['changeLedger']

export async function apply(ctx: Context) {
  const point = await ctx.changeLedger.create({
    cwd: '/absolute/git/worktree',
    sessionId: 'session-id',
    label: 'before refactor',
  })
  // point.id is a durable restore-point id.
}
```

The complete exported types are available from `@dsh-external/change-ledger/format`; the engine is available from `@dsh-external/change-ledger/core` for non-Cordis tests and trusted integrations.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
```

The test suite creates real temporary Git repositories and covers full/selective restore, stale plans, ignored-path collision refusal, HEAD drift, rescue rollback, crash reconciliation, active-lock preservation, durable-state integrity, symlinks, size limits, sparse checkouts, submodules, deletion, and blob garbage collection.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
