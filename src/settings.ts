/**
 * Runtime settings surface for Turn Rewind on the DSH web settings page.
 * @module @anionex/dsh-turn-rewind
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the host's `Context.settings` augmentation and its provider
// type without binding any runtime symbol (0.1.5 deleted `settingsNamespace`
// and the free `installSettingsSection`, so a value import would break the whole
// DSH web profile at load time).
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { resolveConfig, type ChangeLedgerEngine } from './engine.js'
import type { ChangeLedgerConfig, ResolvedChangeLedgerConfig } from './types.js'

/**
 * Namespace join key shared by the host section and the browser settings card.
 *
 * DSH 0.1.5 removed the `settingsNamespace` helper and made `SettingsNamespace`
 * a compile-time-only brand, so a plain lowercase literal is the entire runtime
 * value — the upstream convention (`const CHAT_SETTINGS_NAMESPACE = 'ui-chat'`).
 * The literal satisfies 0.1.5's registration grammar `/^[a-z][a-z0-9-]*$/` and is
 * the exact key the browser card binds through `ctx.settingsScope.bind`.
 */
export const TURN_REWIND_SETTINGS_NAMESPACE = 'turn-rewind'

/** Every runtime-tunable field of {@link ChangeLedgerConfig}; `storageDir` stays config-layer only. */
export interface TurnRewindSettings {
  /** Maximum user and rescue restore points retained per workspace. */
  maxRestorePoints: number
  /** Maximum automatic turn checkpoints retained per session. */
  maxTurnCheckpointsPerSession: number
  /** Maximum number of files in one restore point. */
  maxFiles: number
  /** Maximum bytes read from one regular file. */
  maxFileBytes: number
  /** Maximum aggregate regular-file bytes in one restore point. */
  maxSnapshotBytes: number
  /** Restore-plan lifetime in milliseconds. */
  planTtlMs: number
  /** Age after which a lock whose owner is gone may be reclaimed. */
  staleLockMs: number
  /** Automatic turn-checkpoint implementation; `off` records durable skips instead. */
  turnCheckpointMode: 'off' | 'git-native' | 'legacy'
  /** Maximum time one automatic checkpoint may block the first Agent step. */
  turnCheckpointTimeoutMs: number
  /** Maximum uncached worktree bytes read by one automatic Git-native checkpoint. */
  turnCheckpointMaxNewBytes: number
  /** Fast trusts fenced Git/stat metadata; strict rereads every eligible path. */
  turnCheckpointTrust: 'fast' | 'strict'
}

/** Schemastery schema for the `turn-rewind` settings namespace. */
export const TurnRewindSettingsSchema: z<TurnRewindSettings> = (() => {
  const defaults = tunableSettings(resolveConfig({}))
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
  })
})()

/** Project one resolved configuration onto the settings namespace subset. */
function tunableSettings(resolved: ResolvedChangeLedgerConfig): TurnRewindSettings {
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
  }
}

/** Owner scope handed back by {@link SettingsProviderLike.register}. */
interface SettingsScopeLike<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** Source sink and change notification a settings consumer hands to the provider. */
interface SettingsSectionHooksLike<T> {
  setSource(current: () => T): void
  onChange(): void
}

/**
 * Version-portable view of the parts of `ctx.settings` this plugin drives.
 *
 * The plugin spans DSH releases whose `@deepseek-ai/dsh-settings` type surface
 * differs — 0.1.5 branded the namespace parameter and moved the consumer wiring
 * onto the provider — so the wiring below is written against this structural view
 * (namespace as a plain string) and intersected with the host's own
 * {@link SettingsProvider} type at the single boundary where it is used.
 */
interface SettingsProviderLike {
  register<T>(ns: string, schema: z<T>, options?: { readonly base?: Partial<T> }): SettingsScopeLike<T>
  installSection?<T>(owner: Context, ns: string, schema: z<T>, entry: T, hooks: SettingsSectionHooksLike<T>): void
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
export function installTurnRewindSettings(ctx: Context, config: ChangeLedgerConfig, engine: ChangeLedgerEngine): void {
  const entry = tunableSettings(resolveConfig(config))
  let source: () => TurnRewindSettings = () => entry
  const hooks: SettingsSectionHooksLike<TurnRewindSettings> = {
    setSource: (current) => { source = current },
    onChange: () => {
      try {
        engine.updateConfig({ ...config, ...source() })
      } catch (error) {
        ctx.logger.warn(`[turn-rewind] could not apply settings update: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
  ctx.inject(['settings'], (scope: Context) => {
    const provider = scope.settings as SettingsProvider & SettingsProviderLike
    // 0.1.5 owns the canonical wiring on the provider itself; it also suppresses the
    // detach fallback while the consumer is unloading, which the deleted free
    // function did not do.
    if (typeof provider.installSection === 'function') {
      provider.installSection(ctx, TURN_REWIND_SETTINGS_NAMESPACE, TurnRewindSettingsSchema, entry, hooks)
      return
    }
    // Older hosts shipped that wiring only as the free `installSettingsSection`,
    // which 0.1.5 removed, so reproduce its body against `register` + `scope.get()`
    // + `scope.watch()` — present in every supported version.
    const settingsScope = provider.register(
      TURN_REWIND_SETTINGS_NAMESPACE,
      TurnRewindSettingsSchema,
      { base: entry },
    )
    hooks.setSource(() => settingsScope.get())
    scope.effect(() => () => {
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    settingsScope.watch(() => { hooks.onChange() })
  })
}
