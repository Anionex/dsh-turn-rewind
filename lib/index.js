/**
 * DSH Turn Rewind, powered by persistent, inspectable, approval-gated Change Ledger restore points.
 * @module @anionex/dsh-turn-rewind
 */
import { readFileSync } from 'node:fs';
import { ChangeLedgerEngine } from './engine.js';
import { installManageHttp, installRewindHttp, TurnCheckpointCoordinator } from './rewind-host.js';
import { installTurnRewindSettings } from './settings.js';
export * from './engine.js';
export * from './errors.js';
export * from './rewind-host.js';
export * from './settings.js';
export * from './types.js';
/**
 * Version of the running package.
 *
 * A Profile keeps the previous plugin in memory until DSH restarts, so the
 * loaded version is logged at activation and can be compared with what is on
 * disk in `.../profiles/<name>/node_modules/@anionex/dsh-turn-rewind`.
 * @returns the package version, or `unknown` when the manifest is unreadable.
 */
function pluginVersion() {
    try {
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof manifest.version === 'string' ? manifest.version : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/** Cordis service exposed as `ctx.changeLedger` for other DSH plugins. */
export class ChangeLedgerService {
    engine;
    /** Register the service and startup reconciliation. */
    constructor(ctx, config = {}) {
        ctx.provide('changeLedger', this);
        this.engine = new ChangeLedgerEngine(config);
        const checkpoints = new TurnCheckpointCoordinator(this.engine);
        ctx.logger.info(`[turn-rewind] v${pluginVersion()} active; workspace modes: git worktree, ordinary directory`);
        ctx.inject(['agents'], (scope) => { checkpoints.install(scope); });
        // `apiProxy` is deliberately absent: DSH 0.1.2-alpha carriers (DSH Desktop 2.x)
        // provide `sessionController` instead, and the route must exist on both.
        ctx.inject(['webServer', 'sessions', 'sessionQuery', 'agents'], (scope) => {
            installRewindHttp(scope, this.engine, checkpoints);
            installManageHttp(scope, this.engine);
        });
        installTurnRewindSettings(ctx, config, this.engine);
        void this.engine.initialize().then((reconciled) => {
            if (reconciled > 0) {
                ctx.logger.warn(`[change-ledger] reconciled ${reconciled} interrupted durable operation(s)`);
            }
            else {
                ctx.logger.info(`[change-ledger] ready; state=${this.engine.config.storageDir}`);
            }
        }).catch((error) => {
            ctx.logger.error(`[change-ledger] startup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    /** Wait for startup reconciliation. */
    initialize() {
        return this.engine.initialize();
    }
    /** Create a user restore point. */
    create(options) {
        return this.engine.create(options);
    }
    /** Capture project files before one turn enters its first Agent step. */
    createTurnCheckpoint(options) {
        return this.engine.createTurnCheckpoint(options);
    }
    /** Find the prompt-anchored checkpoint for one session turn. */
    findTurnCheckpoint(options) {
        return this.engine.findTurnCheckpoint(options);
    }
    /** List restore points. */
    list(options) {
        return this.engine.list(options);
    }
    /** Compare a restore point with the current worktree. */
    inspect(options) {
        return this.engine.inspect(options);
    }
    /** Create an expiring restore plan. */
    planRestore(options) {
        return this.engine.planRestore(options);
    }
    /** Apply an exact restore plan after approval. */
    applyRestore(options) {
        return this.engine.applyRestore(options);
    }
    /** Delete one restore point and collect unused blobs. */
    delete(options) {
        return this.engine.delete(options);
    }
    /** List interrupted restore operations and their rescue points. */
    listRecovery(options) {
        return this.engine.listRecovery(options);
    }
    /** Inventory every workspace this storage root has persisted state for. */
    listWorkspaces(options) {
        return this.engine.listWorkspaces(options);
    }
    /** Delete unprotected restore points recorded for one workspace. */
    purgeWorkspace(options) {
        return this.engine.purgeWorkspace(options);
    }
    /** Swap runtime-tunable configuration; the storage root must stay fixed. */
    updateConfig(config) {
        this.engine.updateConfig(config);
    }
}
export default ChangeLedgerService;
