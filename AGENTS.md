# AGENTS.md

This repository is an independent DSH Profile Bundle. Do not modify DeepSeek Harness core to implement a feature here.

- Keep the engine independent of Cordis in `src/engine.ts`; DSH adaptation belongs in `src/rewind-host.ts` and `src/index.ts`.
- Preserve durable format validation and path containment. Never normalize malformed persisted paths into accepted paths.
- Never recursively delete worktree content.
- A restore must remain plan-gated, approval-gated, rescue-first, journaled, and post-verified.
- Run `pnpm run check` before pushing.
- Keep the installable bundle manifest portable: declare `dsh.bundle.patch`, publish `lib/`, `src/`, and `cordis.patch.yml`, expose runtime entry points from `lib/` with declarations under `lib/types/`, provide `build` and `prepack`, and never use absolute, `file:`, or `link:` development dependencies. Commit generated `lib/` because Profile Bundle installation consumes built JavaScript directly, and keep a package-layout test covering these invariants.
