# Large-repository checkpoint design

Status: revised after prior-art audit and an independent adversarial review loop; no high-value actionable findings remain

Implementation status (August 21, 2026): the first production-safe slice is implemented. Legacy automatic checkpoints remain the default but are capped by a 5-second pre-step deadline, so large repositories skip explicitly instead of blocking for minutes. Git-native v2 is available through `turnCheckpointMode: git-native` while the stronger cross-platform capability-filesystem helper remains a rollout gate. Skip outcomes are durable across process restarts.

The repeatable issue-size fixture (`pnpm benchmark:git-checkpoint`) covers 15,500 files and 380,928,000 logical bytes. On the development machine, clean, cold 10-file overlay, and warm 10-file overlay checkpoints completed in 2.00s, 2.03s, and 2.00s respectively; comparing the warm checkpoint with the unchanged worktree completed in 3.88s. Clean/warm capture reread zero worktree bytes, the cold overlay read 245,760 bytes, and Git status, user refs, and the real index remained unchanged.

## 1. Decision summary

Turn Rewind v2 should use **Git's existing object model as the snapshot engine** instead of building a second Merkle tree and content-provider framework.

Each checkpoint consists of:

```text
Git snapshot envelope
  -> captured HEAD tree
  -> complete worktree tree
  -> exact index tree
  -> parentless synthetic commit
  -> private Turn Rewind ref
  + small Change Ledger sidecar
```

The sidecar stores only DSH-specific data that Git cannot express: Session/turn identity, repository fences, exact non-Git mode metadata, checkpoint trust level, restore approval state, rescue links, publication/restore journals, retention data, and the path-state cache.

The target cost is:

```text
Git status/path metadata + bytes whose trusted path state changed
```

not:

```text
all eligible worktree bytes on every turn
```

Automatic capture remains before the first Agent step, but is deadline-gated. It publishes a complete checkpoint or records an explicit skip; it never publishes a partial point.

The coordinator reserves part of the end-to-end deadline for the small durable outcome write. Repository discovery, queueing, and capture stop at the boundary; a slow outcome write may finish afterward without blocking the first Agent step, and a lock-protected ready-check prevents a late skip from overwriting a successful retry. Failed bounded legacy captures leave a cleanup journal; startup or the next capture removes only blobs still unreferenced by a durable manifest.

## 2. Prior-art decision

The following are existing wheels and must not be rebuilt:

- Git tree objects are already a content-addressed Merkle DAG.
- Git plumbing already supplies isolated indexes, blob/tree/commit creation, tree diffing, batched object reads, compare-and-swap ref updates, and garbage-collection reachability.
- Jujutsu's `TreeState` demonstrates the correct performance pattern: retain per-path file state, trust unchanged metadata in fast mode, and optionally let a filesystem monitor narrow scans.
- GitButler demonstrates snapshot commits, operation logging, size limits, and safe worktree restoration patterns.

Turn Rewind should borrow those patterns, but should not embed Jujutsu or GitButler:

- Jujutsu snapshots are coupled to its own working-copy commit and operation model.
- GitButler snapshots are coupled to its workspace/virtual-branch model; its newer generic stash/snapshot commit API is still incomplete, while its older whole-worktree helper is explicitly deprecated.
- Both projects are Rust systems with a much larger runtime and compatibility surface than this portable TypeScript Profile Bundle.

The reusable dependency is therefore **Git CLI plumbing**, not either product's repository model.

## 3. Required invariants

1. The checkpoint boundary remains before the first Agent step.
2. Staged, unstaged, deleted, untracked, symlink, supported type, and supported mode changes remain observable.
3. Checkpoints remain independent across Sessions and conversation branches.
4. Durable paths remain canonical and workspace-relative; malformed paths fail closed.
5. Restore remains plan-gated, approval-gated, rescue-first, journaled, and post-verified.
6. Restore never moves `HEAD` or a user branch and never writes the real Git index.
7. Worktree content is never recursively deleted.
8. A point is valid only when its manifest, private ref, commit, envelope, HEAD/index/worktree trees, blobs, and sidecar metadata all verify.
9. Unsupported or unstable repository state produces a skip/failure, never a partial snapshot.
10. User and rescue points are byte-verified. Automatic fast points explicitly carry metadata-trust semantics instead of claiming cryptographic proof of unchanged bytes.

## 4. Snapshot representation

### 4.1 HEAD, index, and worktree trees

The worktree tree represents the observed supported filesystem state:

- identity-safe clean tracked paths reuse the stage-0 index blob;
- dirty tracked, untracked, and transform-sensitive paths use raw worktree blobs;
- deletions are absent from the tree;
- Git tree mode is selected from the actual filesystem type, not copied blindly from the index;
- `core.symlinks=false` regular-file emulation is therefore stored as a regular file even when the index entry is a symlink;
- regular executable state and actual symlink type use Git tree modes;
- exact supported mode bits beyond Git's executable bit live in a canonical sidecar map.

The captured `HEAD^{tree}` and exact index tree are stored separately from the worktree tree. An unborn `HEAD` uses Git's canonical empty tree. This preserves the `HEAD=A, index=B, worktree=C` boundary for inspection and fencing even after branch rewrites or reflog expiry, while Turn Rewind restore continues to modify only selected worktree paths and never rewrites the user's index.

All three tree IDs are content roots. Git automatically reuses unchanged blobs and subtrees, so Turn Rewind does not need a second path trie, logical hash, storage hash, or provider-neutral content identity.

### 4.2 Snapshot envelope, commit, and private ref

The engine creates a small Git envelope tree with `head`, `index`, and `worktree` subtree entries, then creates a parentless synthetic commit whose root is that envelope. A private ref pins the commit and all reachable objects:

```text
refs/dsh-turn-rewind/v2/<store-id>/<worktree-id>/<restore-point-id>
```

Using a commit rather than a ref directly to a tree follows normal Git snapshot/oplog practice and leaves room for minimal diagnostic trailers without pinning repository history.

Ref creation and deletion use `git update-ref` compare-and-swap. The engine verifies the exact ref target and object types after publication.

### 4.3 Change Ledger sidecar

The v2 sidecar contains:

- DSH Session, turn, and turn-start sequence;
- checkpoint kind, label, timestamps, retention, and parent/rescue links;
- repository, index, attributes, configuration, and object-database fences;
- snapshot commit, envelope, HEAD-tree, index-tree, and worktree-tree IDs and private ref;
- checkpoint trust level: `byte-verified` or `metadata-fenced`;
- canonical exact-mode overrides and their hash;
- file count, logical bytes, newly read bytes, timing, and skip/failure codes;
- publication and restore journals;
- per-workspace path-state cache.

Checkpoint identity is the tuple:

```text
(Git object format, HEAD tree OID, index tree OID, worktree tree OID, exact-mode metadata hash, trust level)
```

## 5. Avoiding repeated content reads

### 5.1 Git supplies inventory and classification

The authoritative eligible-path inventory is the union of stage-0 index paths and Git's non-ignored untracked paths. Turn Rewind also obtains porcelain-v2 status as a dirtiness hint, but does not trust status alone to prove filesystem presence or type.

The private index is checked for and initially rejects `assume-unchanged`, `skip-worktree`, unresolved stages, intent-to-add, sparse-index entries, and any sparse-checkout configuration. This prevents Git optimizations from hiding a changed or absent path. Every eligible tracked path receives an actual no-follow metadata observation before its temporary-index entry is accepted.

V2 initially removes fsmonitor, untracked-cache, and split-index extensions from the private copy and disables external hooks. It preserves ordinary index stat entries but does not trust copied monitor tokens. Turn Rewind does not install or manage Watchman. If complete metadata enumeration exceeds the deadline, automatic capture skips and reports path scanning as the bottleneck; monitor integration is deferred until correctness and benchmark evidence justify it.

### 5.2 Small path-state cache

Git's index does not cache raw worktree blob IDs for untracked, dirty, or transform-sensitive files. The Ledger therefore keeps a narrow cache for only those paths:

```ts
interface CachedPathState {
  path: string
  kind: 'file' | 'symlink'
  mode: number
  size: number
  mtimeNs: string
  ctimeNs?: string
  device?: string
  inode?: string
  indexBlob?: string
  attributesFence: string
  rawBlob: string
}
```

Fast mode reuses `rawBlob` only when the complete available stat fence, path type, index blob, and attributes/configuration fence still match, and Git verifies that the cached object still exists with the expected blob type and size. A cache write is not trusted when the observed file timestamp is ambiguous relative to the cache publication time.

This produces a `metadata-fenced` checkpoint, not proof against metadata-preserving or ABA content replacement. Strict mode ignores the cache, securely reads and hashes every eligible regular file/symlink, and produces a `byte-verified` checkpoint under the documented stable-capture boundary. User-created and rescue checkpoints are always strict; automatic turn checkpoints may be fast only when the manifest and UI expose that trust level.

This is deliberately not a second filesystem database: Git remains authoritative for path inventory and tracked-state classification; the cache only avoids rereading non-index-equivalent bytes. The cache is advisory and never pins an object by itself.

## 6. Isolated index and capture algorithm

The real Git index is read-only to Turn Rewind.

1. Acquire the store-independent workspace lock.
2. Capture repository, `HEAD`, real-index, attributes/configuration, and object-database fences.
3. Copy the real index and any split-index dependency to a private transaction directory.
4. Point all mutating index plumbing at the copy with `GIT_INDEX_FILE`; disable optional locks, hooks, monitor hooks, lazy fetch, and replacement objects.
5. Remove split-index/fsmonitor/untracked-cache extensions from the private copy.
6. Reject unresolved stages, `assume-unchanged`, `skip-worktree`, sparse index/checkout, submodules, intent-to-add ambiguity, unsafe path encodings, and unsupported repository state.
7. Resolve and record the captured `HEAD^{tree}` (or canonical empty tree for unborn `HEAD`) and write the unchanged exact index tree from the normalized private copy.
8. Enumerate index paths plus non-ignored untracked paths, observe actual no-follow filesystem metadata, and obtain status/effective attributes.
9. Select paths for raw capture: every eligible content path in strict mode; dirty, untracked, transform-sensitive, or invalid-cache paths in fast mode.
10. For each selected raw-capture path:
   - in fast mode reuse a valid cached raw blob when possible; otherwise securely open and stream the path;
   - write raw bytes as a Git blob without clean/smudge/EOL conversion;
   - update only the temporary index entry with the blob and the mode derived from actual filesystem type.
11. Remove deleted paths from the temporary index and resolve file/directory replacements deterministically.
12. Run `git write-tree` to create the complete worktree tree, then create the `head`/`index`/`worktree` envelope tree.
13. Recheck repository, real index, inventory, attributes/configuration, and path-state fences. Retry a bounded number of times if they changed.
14. Write the parentless envelope commit, publication journal, private ref, and manifest.
15. Verify ref -> commit -> envelope -> HEAD/index/worktree trees -> blobs and sidecar hashes before marking the point ready.

Git cannot atomically create objects and their first ref. Normal Git unreachable-object grace covers the short pre-ref window. Concurrent external `git gc --prune=now` remains unsupported because it is unsafe alongside object writers generally.

All internal Git commands use a store-owned empty hooks directory. They do not execute user hooks, external filesystem-monitor hooks, clean/smudge filters, or text-conversion commands.

## 7. Capability-scoped filesystem I/O

`lstat(path) -> read/write(path) -> lstat(path)` is not sufficient against concurrent symlink exchange. V2 uses one capability-scoped helper for both reads and restore mutations, preferably built on a maintained capability-filesystem library rather than handwritten path walking.

For capture it:

- open relative to a trusted workspace directory handle;
- refuse symlink/reparse traversal beneath the root;
- stream bytes to Git hashing/object input;
- compare descriptor metadata before and after reading;
- re-resolve the relative path and require the same file identity;
- publish cache state only after all checks succeed.

For restore it:

- opens every parent component relative to the root with no-follow/reparse-safe semantics;
- creates temporary files in the verified destination directory and replaces by handle-relative atomic rename;
- performs `mkdir`, `rename`, `unlink`, `rmdir`, and `chmod` relative to verified directory handles;
- compares the target's current type, byte hash, exact supported mode, and filesystem identity with the approved plan immediately before destructive mutation;
- validates workspace containment and the affected path again after every mutation;
- aborts into the existing restore journal on any identity or namespace mismatch.

The helper fail-closes on pre-existing or exchanged symlink/reparse parents during path resolution. No portable userspace API can atomically prevent a hostile external process from relocating an already-open ancestor outside the workspace immediately before a handle-relative mutation. V2 therefore treats external directory-namespace mutation during apply as unsupported, documents that narrowed threat model, minimizes and checks the mutation window, and journals any detected partial restore. If that threat-model change is not approved, implementation must remain blocked until each supported platform has a stronger pre-mutation containment protocol; post-write detection alone is not presented as prevention.

The helper must be packaged for supported macOS, Linux, and Windows targets with verified checksums. Unsupported platforms fail explicitly. Git path input is NUL-delimited and literal; no path is interpolated into a shell command.

## 8. Transform, LFS, and object-store policy

An index blob may be reused only when raw worktree bytes are known to be identical. Active `filter`, `working-tree-encoding`, `ident`, EOL conversion, `core.symlinks` emulation, or equivalent uncertainty routes the path through the raw-blob/cache path.

The configuration fence records effective values with origin/scope, including worktree configuration and relevant environment overrides. Effective attributes for every eligible path are captured before and after tree construction. A path enters the index-blob fast path only when both observations prove that no worktree transformation applies; uncertainty routes to raw capture or skip.

The first v2 implementation does not create a provider abstraction for Git LFS. A materialized LFS file is captured as a raw Git blob when it must be represented exactly. Its first capture may exceed the automatic byte/deadline budget; manual/rescue capture may continue. A dedicated LFS optimization is deferred until measurements justify the added durability and pinning protocol.

All v2 modes initially reject alternates and promisor/partial-clone states unless every object reachable from the captured HEAD/index/worktree trees is recursively localized into the primary object database and verified before publication. The first implementation does not attempt localization, so these repository states are unsupported for automatic, user, and rescue points. Internal reads disable replacement objects and lazy fetch. Supporting external object stores later requires an explicit localization design, not optimistic reachability checks.

## 9. Publication, ownership, and locking

Each v2 storage root owns a durable random `storeInstanceId`, included in its ref namespace. Manifests and transition journals are accepted only when that identity matches the current storage root, preventing one root from deleting another root's private refs. Missing/corrupt identity in a non-empty store fails closed.

Each Git worktree also owns a durable random `worktreeInstanceId` stored in validated Turn Rewind metadata under its per-worktree Git directory. For the main worktree this is under the common Git directory; linked worktrees use their own `git worktree` administrative directory. The workspace key is derived from repository common-directory identity plus `worktreeInstanceId`, not from the movable worktree root path. Each storage root atomically claims a `worktreeInstanceId` before creating or migrating its namespace; the claim serializes concurrent copied repositories, and historical bindings plus incomplete migration journals are treated as ownership claims during upgrades.

This identity survives `git worktree move`, separates linked-worktree indexes/configuration/ref namespaces, and prevents a pruned then recreated worktree name from inheriting old ownership. Durable workspace bindings include the stable per-worktree Git directory identity as well as the movable root; if all identity copies disappear but historical state still targets that Git directory, startup fails closed instead of silently adopting a replacement root. Moving the entire repository changes the common-directory identity, so the first v2 slice also fails closed when it finds the same durable worktree identity under the historical namespace rather than hiding existing checkpoints; journaled whole-repository migration is deferred. Fences include the exact per-worktree Git directory, worktree root, `config.worktree` when enabled, and the effective configuration origins. Reconciliation does not delete refs for a missing/pruned worktree unless the owning store manifest and IDs prove ownership.

The workspace lock lives in validated Turn Rewind metadata under the Git common directory and is keyed by that worktree identity. This makes different `storageDir` instances contend on the same worktree without blocking unrelated linked worktrees. Lock ownership includes a stable operating-system machine identity, so a PID lookup on one host cannot reclaim another host's lock. Legacy active locks are respected before path-keyed state is migrated. The lock protects capture, inspect/plan/recovery snapshots, delete, reconciliation, rescue capture, restore, and post-verification.

When a linked worktree moves, a durable rebind journal makes manifest, operation, and Git-publication metadata rewriting idempotent. Legacy path-keyed state migration is journaled as well. Startup completes any mixed old/new-path state before ordinary validation, but performs no migration, rebind, or cleanup while an active or hostless legacy lock prevents proving exclusive ownership; it then atomically advances the workspace binding and removes the journal.

Publication uses a durable journal with these states:

```text
prepared -> ref-created -> manifest-created -> committed
```

Startup reconciliation may delete only validated orphan refs in its exact store namespace, complete a manifest whose dependencies verify, or quarantine an uncertain journal. It never guesses ownership.

## 10. Automatic capture policy

Suggested configuration:

```ts
interface TurnCheckpointPolicy {
  mode: 'off' | 'automatic'
  queueDeadlineMs: number
  captureDeadlineMs: number
  maxNewContentBytes: number
  trust: 'fast' | 'strict'
}
```

- Queue time and capture time are reported separately.
- Automatic capture publishes only a complete point within policy limits.
- On deadline, unsupported state, or new-content overflow, the turn proceeds with a stable reason code and visible warning.
- Fast automatic points are labeled `metadata-fenced`; strict automatic points are labeled `byte-verified`.
- User and rescue captures are always strict, use the same format, and do not silently degrade to partial results.
- Hashing and object writes run outside the Node event-loop hot path through streaming subprocess/helper work.

The qualified service objective is: after warm cache, a large repository with a small changed overlay should normally add only Git status/path-scan latency before the first Agent step. Benchmarks, not a hard-coded promise, determine the default deadline.

## 11. Inspection and restore

### 11.1 Diff

Use Git tree diff plumbing separately for `HEAD -> index` and `index -> worktree`, plus exact-mode sidecar comparison. This preserves staged/unstaged boundaries for inspection. Equal tree IDs stop immediately; Git traverses only changed subtrees.

### 11.2 Materialization

Selected file blobs are streamed with `git cat-file --batch`. Symlink targets come from symlink blobs. No path uses `git checkout`, `reset`, `stash`, or `clean`.

Apply preserves the existing rules:

- deepest targeted deletions first;
- shallowest restorations second;
- safe-parent validation before every mutation;
- no symlink-parent traversal;
- no recursive worktree deletion;
- unmanaged descendants block file/directory replacement;
- `rmdir` only after a directory is proven empty.

### 11.3 Approval and verification

`planRestore` performs a strict current-state capture and records its exact worktree/index identity plus selected changes. `applyRestore` reacquires the workspace lock, validates confirmation, and creates a strict v2 rescue point. Before creating the restore journal or mutating anything, it compares the rescue point's selected-path bytes/type/mode and index/repository fences with the plan's expected current state. Any mismatch returns `PLAN_STALE` and performs no worktree mutation. Immediately before each approved mutation, capability-scoped I/O repeats the selected target byte/type/mode check. Only then does apply journal and mutate approved worktree paths, followed by selective post-verification. It never restores the saved index tree automatically.

## 12. Retention and v1 compatibility

Deleting a v2 point removes its manifest and then compare-and-swap deletes its exact private ref. Git reclaims unreachable objects through normal GC; Turn Rewind never runs aggressive worktree cleanup.

V1 remains readable during opt-in rollout. V1 and v2 IDs are explicitly typed, share the same workspace lock domain, and are never guessed from an unqualified string. Restoring a v1 point creates a v2 rescue point and v2 restore journal. Generated v1 data is not rewritten in place.

## 13. Verification and acceptance

Required correctness cases include staged+unstaged content, additions, deletions, untracked files, symlinks, mode/type changes, file/directory replacement, CRLF and attributes, LFS boundaries, linked worktrees, concurrent edits, crash injection, normal Git GC, and simultaneous operations from two storage roots.

Required performance fixtures include approximately 400 files/2 MB, 7,500 files/50 MB, 15,500 files/390 MB, and a 10-20 GB mostly-clean repository, each with clean, small-overlay, stable-large-overlay, and cold/warm-cache variants.

Acceptance requires:

- snapshot envelope durably pins captured HEAD/index/worktree trees and inspection preserves separate `HEAD -> index` and `index -> worktree` changes after branch rewrites and normal GC;
- in fast mode, unchanged identity-safe tracked paths are not opened for content reads;
- in strict mode, every eligible regular file/symlink is securely read and hashed;
- unchanged cached dirty/untracked/transform-sensitive paths are not reread in fast mode;
- consecutive unchanged checkpoints create no new file blobs;
- `HEAD`, user refs, real/shared index, staged paths, and porcelain status remain unchanged;
- sparse checkout, `assume-unchanged`, `skip-worktree`, unresolved index, and unsupported submodule states fail explicitly;
- user/rescue points and restore planning use byte-verified strict capture;
- restore mutations use capability-scoped operations and do not follow symlink/reparse parents outside the workspace;
- linked worktrees receive distinct durable worktree identities, locks, refs, indexes, and configuration fences;
- every ready point survives normal Git GC;
- deadline and byte-limit skips are explicit and leave no ready partial point;
- restore remains rescue-first, selectively approved, and selectively post-verified;
- syscall tracing and object counts confirm the claimed read/write reductions.

## 14. Implementation sequence

1. Build repeatable cold/warm-cache benchmarks and syscall tracing for issue #10 sizes.
2. Prototype the Git-native index/worktree envelope with an isolated index and prove that real Git state is unchanged.
3. Implement the narrow path-state cache and compare fast versus strict mode.
4. Prototype and package capability-scoped read/write helper operations; stop if portable path containment cannot be delivered.
5. Implement private refs, store ownership, workspace locking, and publication reconciliation.
6. Implement v2 manifest validation, tree diff/materialization, selective restore, and post-verification.
7. Add v1/v2 routing, automatic deadline/skip UI, crash tests, and retention.
8. Keep v2 opt-in until correctness, recovery, and issue #10 performance evidence pass.

## 15. Product-visible decisions required before implementation

1. Allow Turn Rewind to write raw checkpoint blobs, parentless commits, and private refs into the repository's Git object database.
2. Allow store-independent worktree identity and lock metadata under the main/per-worktree Git administrative directories.
3. Allow automatic fast mode to create explicitly labeled metadata-fenced points, while user/rescue/restore planning remain strict.
4. Allow packaged cross-platform helper executables for capability-scoped reads and restore mutations.
5. Accept that cold capture of large untracked, dirty, transformed, or LFS materialized content may skip automatic checkpointing rather than delay the model indefinitely.
6. Preserve the index tree for inspection and fencing only; file restore continues not to rewrite the user's index.
7. Either approve external directory-namespace mutation during restore as unsupported, or require implementation to remain blocked until stronger per-platform pre-mutation containment is proven.
8. Accept that v2 initially rejects alternates and promisor/partial-clone repositories in every capture mode until durable object localization is implemented.

No runtime implementation should begin until these product-visible behaviors are approved.
