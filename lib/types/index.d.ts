import type { Context } from '@deepseek-ai/cordis';
import { ChangeLedgerEngine } from './engine.js';
import type { ChangeLedgerConfig } from './types.js';
export * from './engine.js';
export * from './errors.js';
export * from './rewind-host.js';
export * from './settings.js';
export * from './types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        changeLedger: ChangeLedgerService;
    }
}
/** Cordis service exposed as `ctx.changeLedger` for other DSH plugins. */
export declare class ChangeLedgerService {
    /**
     * Plugin configuration schema. Since DSH 0.1.7 dropped the separate settings
     * namespace API, this is both the cordis config validator and the settings form
     * source: every `.volatile()` field is projected into an editable form keyed by
     * the profile entry id (`turn-rewind`), and a volatile edit restarts the plugin
     * through cordis `update()`. `storageDir` is deliberately NOT in this schema —
     * it stays a composition-only pin (see `resolveConfig`), never editable online.
     *
     * Declared `static` because cordis reads `Config` off the resolved plugin value
     * (here the default-exported service class), not off the module namespace.
     */
    static Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        maxRestorePoints: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxTurnCheckpointsPerSession: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxFiles: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxFileBytes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxSnapshotBytes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        planTtlMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        staleLockMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        turnCheckpointMode: import("@deepseek-ai/schemastery").default<"off" | "auto" | "git-native" | "legacy", "off" | "auto" | "git-native" | "legacy", "volatile-defined">;
        turnCheckpointTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        turnCheckpointMaxNewBytes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        turnCheckpointTrust: import("@deepseek-ai/schemastery").default<"fast" | "strict", "fast" | "strict", "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        maxRestorePoints: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxTurnCheckpointsPerSession: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxFiles: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxFileBytes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        maxSnapshotBytes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        planTtlMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        staleLockMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        turnCheckpointMode: import("@deepseek-ai/schemastery").default<"off" | "auto" | "git-native" | "legacy", "off" | "auto" | "git-native" | "legacy", "volatile-defined">;
        turnCheckpointTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        turnCheckpointMaxNewBytes: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        turnCheckpointTrust: import("@deepseek-ai/schemastery").default<"fast" | "strict", "fast" | "strict", "volatile-defined">;
    }>>, "plain">;
    readonly engine: ChangeLedgerEngine;
    /** Register the service and startup reconciliation. */
    constructor(ctx: Context, config?: ChangeLedgerConfig);
    /** Wait for startup reconciliation. */
    initialize(): ReturnType<ChangeLedgerEngine['initialize']>;
    /** Create a user restore point. */
    create(options: Parameters<ChangeLedgerEngine['create']>[0]): ReturnType<ChangeLedgerEngine['create']>;
    /** Capture project files before one turn enters its first Agent step. */
    createTurnCheckpoint(options: Parameters<ChangeLedgerEngine['createTurnCheckpoint']>[0]): ReturnType<ChangeLedgerEngine['createTurnCheckpoint']>;
    /** Find the prompt-anchored checkpoint for one session turn. */
    findTurnCheckpoint(options: Parameters<ChangeLedgerEngine['findTurnCheckpoint']>[0]): ReturnType<ChangeLedgerEngine['findTurnCheckpoint']>;
    /** List restore points. */
    list(options: Parameters<ChangeLedgerEngine['list']>[0]): ReturnType<ChangeLedgerEngine['list']>;
    /** Compare a restore point with the current worktree. */
    inspect(options: Parameters<ChangeLedgerEngine['inspect']>[0]): ReturnType<ChangeLedgerEngine['inspect']>;
    /** Create an expiring restore plan. */
    planRestore(options: Parameters<ChangeLedgerEngine['planRestore']>[0]): ReturnType<ChangeLedgerEngine['planRestore']>;
    /** Apply an exact restore plan after approval. */
    applyRestore(options: Parameters<ChangeLedgerEngine['applyRestore']>[0]): ReturnType<ChangeLedgerEngine['applyRestore']>;
    /** Delete one restore point and collect unused blobs. */
    delete(options: Parameters<ChangeLedgerEngine['delete']>[0]): ReturnType<ChangeLedgerEngine['delete']>;
    /** List interrupted restore operations and their rescue points. */
    listRecovery(options: Parameters<ChangeLedgerEngine['listRecovery']>[0]): ReturnType<ChangeLedgerEngine['listRecovery']>;
    /** Inventory every workspace this storage root has persisted state for. */
    listWorkspaces(options?: Parameters<ChangeLedgerEngine['listWorkspaces']>[0]): ReturnType<ChangeLedgerEngine['listWorkspaces']>;
    /** Delete unprotected restore points recorded for one workspace. */
    purgeWorkspace(options: Parameters<ChangeLedgerEngine['purgeWorkspace']>[0]): ReturnType<ChangeLedgerEngine['purgeWorkspace']>;
    /** Swap runtime-tunable configuration; the storage root must stay fixed. */
    updateConfig(config: ChangeLedgerConfig): void;
}
export default ChangeLedgerService;
