/**
 * Runtime settings surface for Turn Rewind on the DSH web settings page.
 * @module @anionex/dsh-turn-rewind
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ChangeLedgerEngine } from './engine.js';
import type { ChangeLedgerConfig } from './types.js';
/** Namespace join key shared by the host section and the browser settings card. */
export declare const TURN_REWIND_SETTINGS_NAMESPACE: Branded<"SettingsNamespace">;
/** Every runtime-tunable field of {@link ChangeLedgerConfig}; `storageDir` stays config-layer only. */
export interface TurnRewindSettings {
    /** Maximum user and rescue restore points retained per workspace. */
    maxRestorePoints: number;
    /** Maximum automatic turn checkpoints retained per session. */
    maxTurnCheckpointsPerSession: number;
    /** Maximum number of files in one restore point. */
    maxFiles: number;
    /** Maximum bytes read from one regular file. */
    maxFileBytes: number;
    /** Maximum aggregate regular-file bytes in one restore point. */
    maxSnapshotBytes: number;
    /** Restore-plan lifetime in milliseconds. */
    planTtlMs: number;
    /** Age after which a lock whose owner is gone may be reclaimed. */
    staleLockMs: number;
    /** Automatic turn-checkpoint implementation; `off` records durable skips instead. */
    turnCheckpointMode: 'off' | 'git-native' | 'legacy';
    /** Maximum time one automatic checkpoint may block the first Agent step. */
    turnCheckpointTimeoutMs: number;
    /** Maximum uncached worktree bytes read by one automatic Git-native checkpoint. */
    turnCheckpointMaxNewBytes: number;
    /** Fast trusts fenced Git/stat metadata; strict rereads every eligible path. */
    turnCheckpointTrust: 'fast' | 'strict';
}
/** Schemastery schema for the `turn-rewind` settings namespace. */
export declare const TurnRewindSettingsSchema: z<TurnRewindSettings>;
/**
 * Register the `turn-rewind` settings namespace and apply its resolved value to the
 * running engine. The composition entry (from `cordis.patch.yml`) is the base layer;
 * the user layer persists through the DSH settings provider. `storageDir` is never
 * carried by the namespace: the storage root must not move while the engine runs.
 */
export declare function installTurnRewindSettings(ctx: Context, config: ChangeLedgerConfig, engine: ChangeLedgerEngine): void;
