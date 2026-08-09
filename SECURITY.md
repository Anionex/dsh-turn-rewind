# Security model

## Trusted boundary

The plugin runs in the DSH host process and therefore has the host user's filesystem authority. It treats model arguments, durable state, current worktree contents, and concurrent external changes as untrusted inputs.

## Mutation gates

Workspace restoration requires all of the following:

1. an existing durable restore point;
2. a fresh in-memory plan generated from the current tree;
3. an exact short-lived confirmation value;
4. the same DSH session when the plan was session-bound;
5. an explicit human decision: the Web rewind dialog's reviewed impact plus final restore button for a direct browser action, or an equivalent human approval path implemented by a trusted service-API consumer;
6. still-fresh selected-path hashes and the exact reviewed HEAD/branch/operation fence under the workspace lock;
7. a durable rescue point and operation journal.

The Web rewind adapter obtains the same session-bound plan and exact confirmation from a same-origin preview request, then sends both only after the user reviews the affected files and presses the final restore button. Direct mutation requests without that live plan pair fail closed. Conversation-only branching is deliberately absent and remains the responsibility of DSH's native Branch action.

Restore-and-restart verifies that the durable checkpoint still names the exact `turn/start` before the selected `user/message`. A forked Session may resolve that checkpoint through its parent lineage only while both event sequences remain below every durable `seedLength` and every ancestor contains the same message and turn boundary. A direct checkpoint wins over an inherited checkpoint, sibling checkpoints are isolated, and malformed or missing lineage fails closed. The first message restarts through Host `session.create`; later messages fork at the previous completed `turn/end`. The Host owns seed creation, model-target inheritance, persistence, and Workspace attachment. The original append-only Session remains intact.

Restore-and-restart restores files first, then creates the conversation child. If child creation fails, the adapter immediately applies the first restore's rescue point to compensate the file change. If compensation also fails, the ordinary durable restore journals and rescue points remain available for manual recovery rather than hiding a partial outcome. Any running Agent using the same canonical worktree, including the source Session, blocks Web restoration before mutation and is rechecked at apply time; idle Agents do not create a concurrent writer risk. A reviewed HEAD or branch difference is allowed because restoration never moves refs, HEAD, the branch, or the index; a changed or newly active Git operation remains blocked.

An absent or expired confirmation fails closed at apply time: the engine applies a restore only when the confirmation exactly matches a fresh session-bound plan.

## Filesystem containment

- State storage and the managed worktree may not overlap.
- Manifest paths are validated before joining them to the canonical worktree root.
- Existing parent components are checked with `lstat`; symlink parents are rejected.
- A regular file, symlink, or special file omitted by Git's current eligible-path inventory is never overwritten as though it were absent.
- Added paths are removed individually. Recursive deletion is never used for worktree content.
- A directory is removed only when empty. Unmanaged contents therefore block restoration.
- Blobs are SHA-256 verified before use and size-checked against their manifest entry.

## Concurrency and crashes

Each canonical worktree has an exclusive owner-only lock file with PID, timestamp, and nonce. A second live DSH process does not reconcile or take over an active restore. Locks whose owner no longer exists become reclaimable after `staleLockMs`.

Restore journals are written before worktree mutation. A failed restore attempts rollback from the rescue point without honoring a newly aborted caller signal, because leaving a partial mutation is less safe than completing rollback. If rollback also fails, the journal becomes `recovery-required` and preserves both diagnostics and the rescue point.

## Explicit non-goals

- This plugin does not sandbox other processes or prevent them from changing files concurrently.
- It does not restore Git index entries, refs, commits, stash state, ignored files, submodules, or repository operation metadata.
- It does not preserve extended attributes, ACLs, ownership, timestamps, or hard-link identity.
- It does not provide confidentiality or tamper resistance against the same operating-system user. State files are owner-only by default, but the host user remains trusted.
- It automatically captures bounded, hidden checkpoints before the first step of newly observed DSH turns when the rewind adapter is active; it never automatically applies one. User and rescue restore points remain explicit.

## Reporting

Report a vulnerability through the private repository's GitHub security channel or to a repository maintainer. Include the plugin commit, platform, Git version, DSH snapshot, reproduction repository shape, and whether the failure happened before or after workspace mutation.
