import { ChangeLedgerError, errorMessage } from './errors.js';
export const REWIND_HTTP_PATH = '/change-ledger/rewind';
const BODY_LIMIT = 64 * 1024;
const CHANGE_PREVIEW_LIMIT = 200;
/** In-memory capture status used to distinguish a pending checkpoint from a permanent miss. */
export class TurnCheckpointCoordinator {
    engine;
    scheduled = new Map();
    pending = new Set();
    failures = new Map();
    constructor(engine) {
        this.engine = engine;
    }
    /** Install idle-boundary capture listeners while the Agent service is present. */
    install(ctx) {
        const schedule = (agent) => { this.schedule(ctx, agent); };
        ctx.on('agent/created', ({ agent }) => { schedule(agent); });
        ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle')
            schedule(agent); });
        queueMicrotask(() => { for (const agent of ctx.agents.list())
            schedule(agent); });
    }
    /** Current capture state for a session turn when no durable checkpoint exists yet. */
    state(sessionId, turn) {
        const key = checkpointKey(sessionId, turn);
        if (this.pending.has(key))
            return { status: 'pending' };
        const error = this.failures.get(key);
        return error === undefined ? { status: 'missing' } : { status: 'failed', error };
    }
    schedule(ctx, agent) {
        if (agent.status !== 'idle')
            return;
        const cwd = agent.session.header.cwd;
        if (cwd === undefined)
            return;
        const end = agent.session.events.findLast(event => event.type === 'turn/end');
        const turn = end?.data.turn;
        if (end === undefined || !Number.isSafeInteger(turn) || turn < 0)
            return;
        if ((this.scheduled.get(agent.id) ?? -1) >= end.seq)
            return;
        this.scheduled.set(agent.id, end.seq);
        const key = checkpointKey(agent.id, turn);
        this.pending.add(key);
        this.failures.delete(key);
        try {
            void agent.runMaintenance(async (signal) => {
                await this.engine.createTurnCheckpoint({
                    cwd,
                    sessionId: agent.id,
                    turn: turn,
                    turnEndSeq: end.seq,
                    signal,
                });
            }).catch((error) => {
                this.failures.set(key, errorMessage(error));
                ctx.logger.warn(`[change-ledger] turn checkpoint failed for ${agent.id} turn ${String(turn)}: ${errorMessage(error)}`);
            }).finally(() => { this.pending.delete(key); });
        }
        catch (error) {
            this.pending.delete(key);
            this.scheduled.delete(agent.id);
            this.failures.set(key, errorMessage(error));
        }
    }
}
/** Register the same-origin preview/apply endpoint consumed by the browser half. */
export function installRewindHttp(ctx, engine, coordinator) {
    ctx.effect(() => ctx.httpServer.register({
        kind: 'exact',
        path: REWIND_HTTP_PATH,
        handler: createRewindHttpHandler(ctx, engine, coordinator),
    }), 'change-ledger.rewindHttp');
}
/** Build the exact-route handler as a testable unit. */
export function createRewindHttpHandler(ctx, engine, coordinator) {
    return async (request, response) => {
        try {
            if (request.method === 'GET') {
                const url = new URL(request.url ?? REWIND_HTTP_PATH, 'http://dsh.local');
                const sessionId = requiredText(url.searchParams.get('sessionId'), 'sessionId');
                const turn = nonNegativeInteger(url.searchParams.get('turn'), 'turn');
                const cwd = await sessionCwd(ctx, sessionId);
                const checkpoint = await engine.findTurnCheckpoint({ cwd, sessionId, turn });
                if (checkpoint === undefined) {
                    json(response, 200, coordinator.state(sessionId, turn));
                    return;
                }
                const inspection = await engine.inspect({ cwd, restorePointId: checkpoint.id });
                if (inspection.changes.length === 0) {
                    json(response, 200, {
                        status: 'ready', sessionId, turn, checkpointId: checkpoint.id,
                        turnEndSeq: checkpoint.turnEndSeq, totalChanges: 0, changes: [], truncated: false,
                        headChanged: inspection.headChanged, operationChanged: inspection.operationChanged,
                    });
                    return;
                }
                const plan = await engine.planRestore({ cwd, restorePointId: checkpoint.id, sessionId });
                json(response, 200, {
                    status: 'ready', sessionId, turn, checkpointId: checkpoint.id,
                    turnEndSeq: checkpoint.turnEndSeq,
                    totalChanges: inspection.changes.length,
                    changes: inspection.changes.slice(0, CHANGE_PREVIEW_LIMIT).map(change => ({ path: change.path, kind: change.kind })),
                    truncated: inspection.changes.length > CHANGE_PREVIEW_LIMIT,
                    headChanged: inspection.headChanged,
                    operationChanged: inspection.operationChanged,
                    planId: plan.id,
                    confirmation: plan.confirmation,
                });
                return;
            }
            if (request.method === 'POST') {
                const body = objectBody(await readBody(request));
                if (body.mode !== 'code')
                    throw new ChangeLedgerError('INVALID_ARGUMENTS', 'this endpoint currently accepts mode "code"');
                const sessionId = requiredText(body.sessionId, 'sessionId');
                const planId = requiredText(body.planId, 'planId');
                const confirmation = requiredText(body.confirmation, 'confirmation');
                const result = await engine.applyRestore({ planId, confirmation, sessionId });
                json(response, 200, { status: 'completed', mode: 'code', ...result });
                return;
            }
            json(response, 405, { error: 'method not allowed' });
        }
        catch (error) {
            const status = error instanceof ChangeLedgerError && error.code === 'RESTORE_POINT_NOT_FOUND' ? 404 : 409;
            json(response, status, { error: errorMessage(error), code: error instanceof ChangeLedgerError ? error.code : 'REWIND_FAILED' });
        }
    };
}
async function sessionCwd(ctx, sessionId) {
    const live = ctx.sessions.get(sessionId);
    const cwd = live?.header.cwd ?? (await ctx.sessionQuery.readSession(sessionId)).header.cwd;
    if (cwd === undefined)
        throw new ChangeLedgerError('WORKSPACE_REQUIRED', `session ${sessionId} has no workspace`);
    return cwd;
}
function checkpointKey(sessionId, turn) {
    return `${sessionId}\0${String(turn)}`;
}
function requiredText(value, name) {
    if (typeof value !== 'string' || value === '')
        throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a non-empty string`);
    return value;
}
function nonNegativeInteger(value, name) {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a non-negative safe integer`);
    }
    return parsed;
}
function objectBody(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ChangeLedgerError('INVALID_ARGUMENTS', 'request body must be an object');
    }
    return value;
}
async function readBody(request) {
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
        request.on('data', (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > BODY_LIMIT) {
                reject(new ChangeLedgerError('INVALID_ARGUMENTS', 'request body is too large'));
                return;
            }
            chunks.push(bytes);
        });
        request.on('end', resolve);
        request.on('error', reject);
    });
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch (error) {
        throw new ChangeLedgerError('INVALID_ARGUMENTS', 'request body must be valid JSON', { cause: error });
    }
}
function json(response, status, value) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`${JSON.stringify(value)}\n`);
}
//# sourceMappingURL=rewind-host.js.map