import { randomUUID } from 'node:crypto';
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
                const mode = body.mode;
                if (mode !== 'code' && mode !== 'conversation' && mode !== 'both') {
                    throw new ChangeLedgerError('INVALID_ARGUMENTS', 'mode must be "code", "conversation", or "both"');
                }
                const sessionId = requiredText(body.sessionId, 'sessionId');
                const planId = optionalText(body.planId, 'planId');
                const confirmation = optionalText(body.confirmation, 'confirmation');
                if (mode === 'code') {
                    if (planId === undefined || confirmation === undefined) {
                        throw new ChangeLedgerError('NO_CHANGES', 'the selected turn has no code changes to restore');
                    }
                    const result = await engine.applyRestore({ planId, confirmation, sessionId });
                    json(response, 200, { status: 'completed', mode, ...result });
                    return;
                }
                const turn = nonNegativeInteger(body.turn, 'turn');
                const checkpointId = requiredText(body.checkpointId, 'checkpointId');
                const checkpoint = await checkpointForRequest(ctx, engine, sessionId, turn, checkpointId);
                if (mode === 'conversation') {
                    const fork = await createConversationFork(ctx, sessionId, turn, checkpoint.turnEndSeq);
                    json(response, 200, { status: 'completed', mode, sessionId: fork.sessionId });
                    return;
                }
                let restoreResult;
                if (planId !== undefined || confirmation !== undefined) {
                    if (planId === undefined || confirmation === undefined) {
                        throw new ChangeLedgerError('INVALID_ARGUMENTS', 'planId and confirmation must be supplied together');
                    }
                    restoreResult = await engine.applyRestore({ planId, confirmation, sessionId });
                }
                try {
                    const fork = await createConversationFork(ctx, sessionId, turn, checkpoint.turnEndSeq);
                    json(response, 200, { status: 'completed', mode, sessionId: fork.sessionId, ...restoreResult });
                }
                catch (forkError) {
                    if (restoreResult === undefined)
                        throw forkError;
                    try {
                        const cwd = await sessionCwd(ctx, sessionId);
                        const rollbackPlan = await engine.planRestore({
                            cwd,
                            restorePointId: restoreResult.rescuePointId,
                            sessionId,
                        });
                        await engine.applyRestore({
                            planId: rollbackPlan.id,
                            confirmation: rollbackPlan.confirmation,
                            sessionId,
                        });
                    }
                    catch (rollbackError) {
                        throw new AggregateError([forkError, rollbackError], 'conversation fork failed and code compensation also failed');
                    }
                    throw new ChangeLedgerError('RESTORE_FAILED_ROLLED_BACK', `conversation fork failed; code was recovered from ${restoreResult.rescuePointId}: ${errorMessage(forkError)}`, { cause: forkError });
                }
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
async function checkpointForRequest(ctx, engine, sessionId, turn, requestedId) {
    const cwd = await sessionCwd(ctx, sessionId);
    const checkpoint = await engine.findTurnCheckpoint({ cwd, sessionId, turn });
    if (checkpoint === undefined || checkpoint.turnEndSeq === undefined) {
        throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `turn ${String(turn)} has no rewind checkpoint`);
    }
    if (requestedId !== checkpoint.id) {
        throw new ChangeLedgerError('PLAN_STALE', 'the selected turn checkpoint changed; reopen the rewind dialog');
    }
    return { id: checkpoint.id, turnEndSeq: checkpoint.turnEndSeq };
}
async function createConversationFork(ctx, sourceId, turn, turnEndSeq) {
    const live = ctx.sessions.get(sourceId);
    const source = live ?? { id: sourceId, ...await ctx.sessionQuery.readSession(sourceId) };
    const boundary = source.events.find(event => (event.type === 'turn/end' && event.seq === turnEndSeq && event.data.turn === turn));
    if (boundary === undefined)
        throw new ChangeLedgerError('PLAN_STALE', 'the session no longer contains the checkpoint turn boundary');
    const response = await ctx.apiProxy.sessions.fork({
        rpcId: randomUUID(),
        payload: { sessionId: sourceId, atSeq: turnEndSeq },
    });
    if (!response.result.ok) {
        throw new ChangeLedgerError('CONVERSATION_REWIND_FAILED', response.result.error.message);
    }
    return { sessionId: requiredText(response.result.value.sessionId, 'fork sessionId') };
}
function checkpointKey(sessionId, turn) {
    return `${sessionId}\0${String(turn)}`;
}
function requiredText(value, name) {
    if (typeof value !== 'string' || value === '')
        throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a non-empty string`);
    return value;
}
function optionalText(value, name) {
    return value === undefined ? undefined : requiredText(value, name);
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