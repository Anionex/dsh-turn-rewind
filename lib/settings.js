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
        maxRestorePoints: z.number().step(1).min(1).default(defaults.maxRestorePoints),
        maxTurnCheckpointsPerSession: z.number().step(1).min(1).default(defaults.maxTurnCheckpointsPerSession),
        maxFiles: z.number().step(1).min(1).default(defaults.maxFiles),
        maxFileBytes: z.number().step(1).min(1).default(defaults.maxFileBytes),
        maxSnapshotBytes: z.number().step(1).min(1).default(defaults.maxSnapshotBytes),
        planTtlMs: z.number().step(1).min(1).default(defaults.planTtlMs),
        staleLockMs: z.number().step(1).min(1).default(defaults.staleLockMs),
        turnCheckpointMode: z.union(['off', 'auto', 'git-native', 'legacy']).default(defaults.turnCheckpointMode),
        turnCheckpointTimeoutMs: z.number().step(1).min(1).default(defaults.turnCheckpointTimeoutMs),
        turnCheckpointMaxNewBytes: z.number().step(1).min(1).default(defaults.turnCheckpointMaxNewBytes),
        turnCheckpointTrust: z.union(['fast', 'strict']).default(defaults.turnCheckpointTrust),
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
/**
 * Register the `turn-rewind` settings namespace and apply its resolved value to the
 * running engine. The composition entry (from `cordis.patch.yml`) is the base layer;
 * the user layer persists through the DSH settings provider. `storageDir` is never
 * carried by the namespace: the storage root must not move while the engine runs.
 *
 * `settings` is an optional service, so the whole wiring stays behind
 * `ctx.inject(['settings'], …)`: a host without a provider keeps running on the
 * composition entry alone.
 */
export function installTurnRewindSettings(ctx, config, engine) {
    const entry = tunableSettings(resolveConfig(config));
    let source = () => entry;
    const hooks = {
        setSource: (current) => { source = current; },
        onChange: () => {
            try {
                engine.updateConfig({ ...config, ...source() });
            }
            catch (error) {
                ctx.logger.warn(`[turn-rewind] could not apply settings update: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    };
    ctx.inject(['settings'], (scope) => {
        const provider = scope.settings;
        // 0.1.5 owns the canonical wiring on the provider itself; it also suppresses the
        // detach fallback while the consumer is unloading, which the deleted free
        // function did not do.
        if (typeof provider.installSection === 'function') {
            provider.installSection(ctx, TURN_REWIND_SETTINGS_NAMESPACE, TurnRewindSettingsSchema, entry, hooks);
            return;
        }
        // Older hosts shipped that wiring only as the free `installSettingsSection`,
        // which 0.1.5 removed, so reproduce its body against `register` + `scope.get()`
        // + `scope.watch()` — present in every supported version.
        const settingsScope = provider.register(TURN_REWIND_SETTINGS_NAMESPACE, TurnRewindSettingsSchema, { base: entry });
        hooks.setSource(() => settingsScope.get());
        scope.effect(() => () => {
            hooks.setSource(() => entry);
            hooks.onChange();
        });
        hooks.onChange();
        settingsScope.watch(() => { hooks.onChange(); });
    });
}
