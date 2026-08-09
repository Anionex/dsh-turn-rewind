# Contributing

## Requirements

- Node.js `^22.19.0` or `>=24`
- pnpm `11.7.0`
- Git `2.26` or newer

## Checks

```sh
pnpm install --frozen-lockfile
pnpm run check
```

The repository commits the generated `lib/` runtime and declarations so a Git checkout is directly installable as a DSH Profile Bundle. Keep `dsh.bundle.patch`, `package.json#files`, and the `lib/` entry points aligned, and do not add machine-local `file:`, `link:`, or absolute-path development dependencies.

Behavioral changes must include a real temporary-Git-repository test. Restore-path changes require coverage for the successful path, stale or invalid input, and failure recovery. Durable format changes require an update to `docs/FORMAT.md` and must reject old or unknown shapes unless an explicit migration is shipped.

## Design constraints

- Restores are always user-triggered and reviewable. Automatic turn checkpoints may capture state but never apply it.
- No Git commit, reset, stash, checkout, ref, or index mutation.
- No recursive deletion of worktree content.
- Fail loud rather than silently omitting an eligible path.
- Every workspace mutation has a prewritten rescue point and journal.
- Model-visible tool payloads stay bounded; trusted same-process APIs stay structured.
- New deployment-varying limits are configuration fields, not hidden constants.
