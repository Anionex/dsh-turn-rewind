import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { resolveConfig } from './engine.js';
/** Namespace join key shared by the host section and the browser settings card. */
export const TURN_REWIND_SETTINGS_NAMESPACE = settingsNamespace('turn-rewind');
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
        turnCheckpointMode: z.union(['off', 'git-native', 'legacy']).default(defaults.turnCheckpointMode),
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
 */
export function installTurnRewindSettings(ctx, config, engine) {
    let source = () => tunableSettings(resolveConfig(config));
    installSettingsSection(ctx, TURN_REWIND_SETTINGS_NAMESPACE, TurnRewindSettingsSchema, source(), {
        setSource: (current) => { source = current; },
        onChange: () => {
            try {
                engine.updateConfig({ ...config, ...source() });
            }
            catch (error) {
                ctx.logger.warn(`[turn-rewind] could not apply settings update: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    });
}
