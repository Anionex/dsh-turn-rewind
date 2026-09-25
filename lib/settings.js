import z from '@deepseek-ai/schemastery';
import { resolveConfig } from './engine.js';
/**
 * Namespace join key shared by the host section and the browser settings card.
 *
 * DSH 0.1.5 removed the `settingsNamespace` helper and made `SettingsNamespace`
 * a compile-time-only brand, so a plain lowercase literal is the entire runtime
 * value — the upstream convention (`const CHAT_SETTINGS_NAMESPACE = 'ui-chat'`).
 * The literal satisfies 0.1.5's registration grammar `/^[a-z][a-z0-9-]*$/` and is
 * the exact key the browser card binds through `ctx.settingsScope.bind`.
 */
export const TURN_REWIND_SETTINGS_NAMESPACE = 'turn-rewind';
/** Schemastery schema for the `turn-rewind` settings namespace. */
export const TurnRewindSettingsSchema = (() => {
    const defaults = tunableSettings(resolveConfig({}));
    return z.object({
        maxRestorePoints: z.number().step(1).min(1).default(defaults.maxRestorePoints).volatile(),
        maxTurnCheckpointsPerSession: z.number().step(1).min(1).default(defaults.maxTurnCheckpointsPerSession).volatile(),
        maxFiles: z.number().step(1).min(1).default(defaults.maxFiles).volatile(),
        maxFileBytes: z.number().step(1).min(1).default(defaults.maxFileBytes).volatile(),
        maxSnapshotBytes: z.number().step(1).min(1).default(defaults.maxSnapshotBytes).volatile(),
        planTtlMs: z.number().step(1).min(1).default(defaults.planTtlMs).volatile(),
        staleLockMs: z.number().step(1).min(1).default(defaults.staleLockMs).volatile(),
        turnCheckpointMode: z.union(['off', 'auto', 'git-native', 'legacy']).default(defaults.turnCheckpointMode).volatile(),
        turnCheckpointTimeoutMs: z.number().step(1).min(1).default(defaults.turnCheckpointTimeoutMs).volatile(),
        turnCheckpointMaxNewBytes: z.number().step(1).min(1).default(defaults.turnCheckpointMaxNewBytes).volatile(),
        turnCheckpointTrust: z.union(['fast', 'strict']).default(defaults.turnCheckpointTrust).volatile(),
    });
})();
/** Project one resolved configuration onto the settings namespace subset. */
function tunableSettings(resolved) {
    return {
        maxRestorePoints: resolved.maxRestorePoints,
        maxTurnCheckpointsPerSession: resolved.maxTurnCheckpointsPerSession,
        maxFiles: resolved.maxFiles,
        maxFileBytes: resolved.maxFileBytes,
        maxSnapshotBytes: resolved.maxSnapshotBytes,
        planTtlMs: resolved.planTtlMs,
        staleLockMs: resolved.staleLockMs,
        turnCheckpointMode: resolved.turnCheckpointMode,
        turnCheckpointTimeoutMs: resolved.turnCheckpointTimeoutMs,
        turnCheckpointMaxNewBytes: resolved.turnCheckpointMaxNewBytes,
        turnCheckpointTrust: resolved.turnCheckpointTrust,
    };
}
export function installTurnRewindSettings(ctx, config, engine) {
    // DSH 0.1.7 removed the `settings.register` / `settingsNamespace` API. The
    // plugin's Config schema (see index.ts `ChangeLedgerService.Config`, built from
    // `TurnRewindSettingsSchema`) is now projected into an editable form by the
    // settings service automatically, and any volatile edit restarts the plugin
    // through cordis `update()` — so `new ChangeLedgerService(ctx, nextConfig)`
    // re-runs and the engine is rebuilt with the new tunables. There is nothing to
    // register here anymore; this function exists only for API compatibility with
    // the rest of the host half.
    void ctx;
    void config;
    void engine;
}
