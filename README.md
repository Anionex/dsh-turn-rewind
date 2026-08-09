# DSH Turn Rewind

[中文说明](README.zh.md)

Message-anchored project-file recovery for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with an option to restart from the restored request.

**Turn Rewind** is the user-facing feature, repository, and Profile Bundle name. **Change Ledger** is the durable restore engine underneath it: the `ctx.changeLedger` service, on-disk format, and storage path keep that name because they describe the reusable snapshot and recovery layer rather than the Web action alone.

Change Ledger gives a DSH session an explicit safety boundary around workspace mutations:

```text
create restore point
        ↓
agent / user / external tools modify the worktree
        ↓
preview exact path-level drift
        ↓
review a full or selective restore plan
        ↓
press the final restore button in the rewind dialog
        ↓
create rescue point → restore → verify
```

It never commits, stashes, resets, switches branches, edits the Git index, or decides automatically that a change should be reverted.

## Preview

Rewind appears as an icon-only third action under each user message, after its timestamp and native Copy action:

![Turn Rewind action under a user message](docs/assets/turn-rewind-action.png)

Opening it shows the affected files and offers two choices: restore the files and restart from before that message, or restore only the files:

![Turn Rewind review dialog](docs/assets/turn-rewind-dialog.png)

## Why it has a Change Ledger engine

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

- **Explicit only:** nothing is restored automatically — every restore starts from the user pressing the final button in the Web dialog, or from an explicit call through the service API.
- **Read before write:** the dialog preview generates an expiring, session-bound plan from the current tree and changes no files.
- **Human gate:** the dialog's reviewed impact plus the final restore button is the human decision; direct mutation requests without a live session-bound plan pair fail closed.
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

dsh plugin --profile web add /path/to/dsh-turn-rewind
dsh plugin --profile headless add /path/to/dsh-turn-rewind

dsh --profile web --dump-config | grep turn-rewind
```

Restart a running profile after changing its bundle list.

The package is a DSH Profile Bundle. `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` mounts `@dsh-external/turn-rewind` without a DSH core patch.

When the profile also provides the DSH Agent service, the plugin captures a hidden checkpoint in the first `agent/pre-step` waterfall before the Agent processes the opening user message. Capture failures are reported but do not reject the user's turn; the corresponding message simply has no usable rewind point. In Web profiles, the same-origin `/turn-rewind` endpoint resolves the selected `user/message` sequence, exposes a paged file preview, mints a short-lived session-bound restore plan, and delegates child creation to DSH's official Host create/fork lifecycle. It never restores files automatically.

## User flow

In the Web profile, each direct user message gains a compact, icon-only **Rewind** action after its timestamp and native Copy control. The tooltip reads “Return to before sending this message.” Opening Rewind checks the saved file state, shows a concise preview with a “view all files” action, and offers two modes:

| Mode | Code | Conversation |
| --- | --- | --- |
| **Restore files and restart** (default) | Restores the project files after automatically backing up their current state. | Creates and opens a Session ending before the selected message, then puts that message's text back in the composer. |
| **Restore files only** | Restores the project files after automatically backing up their current state. | Leaves the current Session open and unchanged. |

The dialog itself is the confirmation: there is no duplicate checkbox. It describes each file as restoring an earlier version, finding a deleted file, removing a later-added file, or restoring permissions/type. If the project files already match the state before the selected message, Turn Rewind performs no action and directs the user to the native **Branch** button for conversation-only branching.

Before mutation, Turn Rewind rechecks the selected files and repository state, then creates an automatic backup. Changes made after preview invalidate the operation. Any running Agent using the same worktree, including the source Session, blocks restoration; idle Sessions do not block. A reviewed HEAD or branch difference does not block restoration: commits, refs, branch, and index remain unchanged, so restored content may appear as ordinary uncommitted changes against the current HEAD. An in-progress Git operation still blocks. If child creation fails after “restore and restart,” Change Ledger automatically restores the pre-operation files from the backup.

DSH Session logs are append-only, so “restart” creates a new Session instead of truncating the original. For the first message, the Host creates a blank Session in the same working directory; for later messages, it forks at the previous completed `turn/end`. A child may reuse an ancestor's prompt checkpoint only while both the selected `user/message` and its exact `turn/start` remain inside every durable `seedLength` fence. Direct child checkpoints take priority and sibling checkpoints never mix. **Branch** creates only a conversation branch and keeps project files unchanged; **Turn Rewind** always restores project files, optionally followed by a new conversation with the selected prompt restored to the composer. The original Session is always retained.

## Configuration

Override configuration in the profile patch layer:

```yaml
- id: turn-rewind
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

Recovery uses the public `ctx.changeLedger` service API: `listRecovery` finds the operation's `rescuePointId`, `inspect` reviews that rescue point, then `planRestore`/`applyRestore` handle the affected paths. Rescue points remain ordinary, inspectable restore points until explicitly deleted.

## Public service

Other Cordis plugins can inject `changeLedger` and call the same lifecycle through the structured service API:

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

The complete exported types are available from `@dsh-external/turn-rewind/format`; the engine is available from `@dsh-external/turn-rewind/core` for non-Cordis tests and trusted integrations.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
```

The test suite creates real temporary Git repositories and covers full/selective restore, stale plans, ignored-path collision refusal, HEAD drift, rescue rollback, crash reconciliation, active-lock preservation, durable-state integrity, symlinks, size limits, sparse checkouts, submodules, deletion, and blob garbage collection.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
