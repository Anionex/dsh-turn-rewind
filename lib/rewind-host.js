import { randomUUID } from 'node:crypto';
import { createDeadline } from './deadline.js';
import { ChangeLedgerError, errorMessage } from './errors.js';
import { discoverRepositoryRoot } from './git.js';
export const REWIND_HTTP_PATH = '/turn-rewind';
const BODY_LIMIT = 64 * 1024;
const INITIAL_CHANGE_PREVIEW_LIMIT = 8;
const MAX_CHANGE_PAGE_SIZE = 200;
/** Capture each turn before its opening user message can trigger model or tool work. */
export class TurnCheckpointCoordinator {
    engine;
    captures = new Map();
    pending = new Set();
    failures = new Map();
    skips = new Map();
    workspaceTails = new Map();
    constructor(engine) {
        this.engine = engine;
    }
    /** Install the first-step gate; checkpoint failures are recorded but never reject the user turn. */
    install(ctx) {
        ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
            if (step === 1)
                await this.capture(ctx, agent, turn, signal);
            return next();
        }, { prepend: true });
    }
    /** Current capture state for a session turn when no durable checkpoint exists yet. */
    state(sessionId, turn) {
        const key = checkpointKey(sessionId, turn);
        if (this.pending.has(key))
            return { status: 'pending' };
        const reason = this.skips.get(key);
        if (reason !== undefined)
            return { status: 'skipped', reason };
        const error = this.failures.get(key);
        return error === undefined ? { status: 'missing' } : { status: 'failed', error };
    }
    async capture(ctx, agent, turn, signal) {
        const key = checkpointKey(agent.id, turn);
        const cwd = agent.session.header.cwd;
        if (cwd === undefined)
            return;
        const start = agent.session.events.findLast(event => event.type === 'turn/start' && event.data.turn === turn);
        if (start === undefined) {
            await this.recordFailure(ctx, agent.id, turn, new Error('turn/start is unavailable before the first step'));
            return;
        }
        const timeoutMs = this.engine.config.turnCheckpointTimeoutMs;
        const outcomeDeadline = createDeadline(timeoutMs);
        const outcomeSignal = AbortSignal.any([signal, outcomeDeadline.signal]);
        const reserveMs = Math.min(250, Math.max(10, Math.ceil(timeoutMs / 5)));
        const captureDeadline = createDeadline(Math.max(1, timeoutMs - reserveMs));
        const captureSignal = AbortSignal.any([signal, captureDeadline.signal]);
        try {
            const existing = this.captures.get(key);
            if (existing !== undefined) {
                await waitWithSignal(existing, captureSignal).catch(() => undefined);
                return;
            }
            this.pending.add(key);
            this.failures.delete(key);
            this.skips.delete(key);
            const capture = (async () => {
                try {
                    const workspace = await discoverRepositoryRoot(cwd, captureSignal);
                    await this.serializeWorkspace(workspace, captureSignal, async () => {
                        try {
                            await this.engine.createTurnCheckpoint({
                                cwd: workspace,
                                sessionId: agent.id,
                                turn,
                                turnStartSeq: start.seq,
                                signal: captureSignal,
                            });
                        }
                        catch (error) {
                            await this.recordFailure(ctx, agent.id, turn, checkpointTimeoutError(error, timeoutMs, captureDeadline.signal, signal), { cwd: workspace, turnStartSeq: start.seq });
                        }
                    });
                }
                catch (error) {
                    await this.recordFailure(ctx, agent.id, turn, checkpointTimeoutError(error, timeoutMs, captureDeadline.signal, signal), { cwd, turnStartSeq: start.seq });
                }
                finally {
                    this.pending.delete(key);
                }
            })();
            this.captures.set(key, capture);
            try {
                await waitWithSignal(capture, outcomeSignal);
            }
            catch (error) {
                const bounded = checkpointTimeoutError(error, timeoutMs, outcomeDeadline.signal, signal);
                const message = errorMessage(bounded);
                this.pending.delete(key);
                if (bounded instanceof ChangeLedgerError && isCheckpointSkip(bounded.code)) {
                    this.skips.set(key, message);
                }
                else {
                    this.failures.set(key, message);
                }
            }
        }
        finally {
            captureDeadline.cancel();
            outcomeDeadline.cancel();
        }
    }
    async serializeWorkspace(workspace, signal, task) {
        const previous = this.workspaceTails.get(workspace) ?? Promise.resolve();
        const current = (async () => {
            await waitWithSignal(previous.catch(() => undefined), signal);
            signal.throwIfAborted();
            await task();
        })();
        this.workspaceTails.set(workspace, current);
        try {
            await current;
        }
        finally {
            if (this.workspaceTails.get(workspace) === current)
                this.workspaceTails.delete(workspace);
        }
    }
    async recordFailure(ctx, sessionId, turn, error, skipContext) {
        const message = errorMessage(error);
        if (error instanceof ChangeLedgerError && isCheckpointSkip(error.code)) {
            this.skips.set(checkpointKey(sessionId, turn), message);
            if (skipContext !== undefined) {
                try {
                    await this.engine.recordTurnCheckpointSkip({
                        cwd: skipContext.cwd,
                        sessionId,
                        turn,
                        turnStartSeq: skipContext.turnStartSeq,
                        reason: message,
                    });
                }
                catch (persistError) {
                    ctx.logger.warn(`[turn-rewind] could not persist checkpoint skip for ${sessionId} turn ${String(turn)}: ${errorMessage(persistError)}`);
                }
            }
            ctx.logger.warn(`[turn-rewind] checkpoint skipped for ${sessionId} turn ${String(turn)}: ${message}`);
            return;
        }
        this.failures.set(checkpointKey(sessionId, turn), message);
        ctx.logger.warn(`[turn-rewind] checkpoint failed for ${sessionId} turn ${String(turn)}: ${message}`);
    }
}
function isCheckpointSkip(code) {
    return code === 'TURN_CHECKPOINT_DISABLED'
        || code === 'TURN_CHECKPOINT_TIMEOUT'
        || code === 'TURN_CHECKPOINT_NEW_CONTENT_LIMIT'
        || code === 'GIT_OBJECT_STORE_UNSUPPORTED'
        || code === 'GIT_INDEX_UNSUPPORTED';
}
async function waitWithSignal(promise, signal) {
    signal.throwIfAborted();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort?.(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await Promise.race([promise, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function checkpointTimeoutError(error, timeoutMs, deadline, callerSignal) {
    if (!callerSignal.aborted && deadline.aborted) {
        return new ChangeLedgerError('TURN_CHECKPOINT_TIMEOUT', `automatic checkpoint exceeded ${timeoutMs} ms`, { cause: error });
    }
    return error;
}
/** Register the same-origin preview/apply endpoint consumed by the browser half. */
export function installRewindHttp(ctx, engine, coordinator) {
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: REWIND_HTTP_PATH,
        handler: createRewindHttpHandler(ctx, engine, coordinator),
    }), 'change-ledger.rewindHttp');
}
export const MANAGE_HTTP_PATH = '/turn-rewind/manage';
/** Register the same-origin storage-management endpoint consumed by the settings card. */
export function installManageHttp(ctx, engine) {
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: MANAGE_HTTP_PATH,
        handler: createManageHttpHandler(engine),
    }), 'change-ledger.manageHttp');
}
/** Build the storage-management route as a testable unit. */
export function createManageHttpHandler(engine) {
    return async (request, response) => {
        try {
            if (request.method === 'GET') {
                const workspaces = await engine.listWorkspaces();
                json(response, 200, {
                    storageDir: engine.config.storageDir,
                    totalBytes: workspaces.reduce((total, workspace) => total + workspace.totalBytes, 0),
                    workspaces: workspaces.map((workspace) => ({
                        workspace: workspace.workspace,
                        totalBytes: workspace.totalBytes,
                        recoveryCount: workspace.recoveryCount,
                        restorePoints: workspace.restorePoints.map((point) => ({
                            id: point.id,
                            kind: point.kind,
                            format: point.format,
                            createdAt: point.createdAt,
                            totalBytes: point.totalBytes,
                            fileCount: point.fileCount,
                            ...(point.sessionId === undefined ? {} : { sessionId: point.sessionId }),
                            ...(point.turn === undefined ? {} : { turn: point.turn }),
                            ...(point.label === undefined ? {} : { label: point.label }),
                        })),
                    })),
                });
                return;
            }
            if (request.method === 'POST') {
                const body = objectBody(await readBody(request));
                const action = requiredText(body.action, 'action');
                if (action === 'delete') {
                    const workspace = requiredText(body.workspace, 'workspace');
                    const restorePointId = requiredText(body.restorePointId, 'restorePointId');
                    const report = await engine.purgeWorkspace({ workspace, restorePointIds: [restorePointId] });
                    if (report.deletedRestorePoints === 0) {
                        throw new ChangeLedgerError(report.retainedRestorePoints > 0 ? 'RECOVERY_REFERENCE' : 'RESTORE_POINT_NOT_FOUND', report.retainedRestorePoints > 0
                            ? 'restore point is required by an incomplete recovery journal'
                            : `restore point ${restorePointId} does not exist`);
                    }
                    json(response, 200, { status: 'completed', action, ...report });
                    return;
                }
                if (action === 'clear-workspace') {
                    const workspace = requiredText(body.workspace, 'workspace');
                    json(response, 200, { status: 'completed', action, ...await engine.purgeWorkspace({ workspace }) });
                    return;
                }
                if (action === 'clear-all') {
                    const reports = [];
                    const failures = [];
                    for (const overview of await engine.listWorkspaces()) {
                        try {
                            reports.push(await engine.purgeWorkspace({ workspace: overview.workspace }));
                        }
                        catch (error) {
                            failures.push({ workspace: overview.workspace, error: errorMessage(error) });
                        }
                    }
                    json(response, 200, {
                        status: failures.length > 0 ? 'partial' : 'completed',
                        action,
                        reports,
                        ...(failures.length > 0 ? { failures } : {}),
                    });
                    return;
                }
                throw new ChangeLedgerError('INVALID_ARGUMENTS', 'action must be "delete", "clear-workspace", or "clear-all"');
            }
            json(response, 405, { error: 'method not allowed' });
        }
        catch (error) {
            const status = error instanceof ChangeLedgerError && error.code === 'RESTORE_POINT_NOT_FOUND' ? 404 : 409;
            json(response, status, {
                error: errorMessage(error),
                code: error instanceof ChangeLedgerError ? error.code : 'MANAGE_FAILED',
            });
        }
    };
}
/** Build the exact-route handler as a testable unit. */
export function createRewindHttpHandler(ctx, engine, coordinator) {
    return async (request, response) => {
        try {
            if (request.method === 'GET') {
                const url = new URL(request.url ?? REWIND_HTTP_PATH, 'http://dsh.local');
                const sessionId = requiredText(url.searchParams.get('sessionId'), 'sessionId');
                const messageSeq = nonNegativeInteger(url.searchParams.get('messageSeq'), 'messageSeq');
                const detailsOnly = url.searchParams.get('details') === '1';
                const offset = nonNegativeInteger(url.searchParams.get('offset') ?? '0', 'offset');
                const limit = pageSize(url.searchParams.get('limit'), detailsOnly ? MAX_CHANGE_PAGE_SIZE : INITIAL_CHANGE_PREVIEW_LIMIT);
                const { session, target } = await resolveMessageTarget(ctx, sessionId, messageSeq);
                let checkpoint;
                try {
                    checkpoint = await resolveMessageCheckpoint(ctx, engine, sessionId, session, target);
                }
                catch (error) {
                    // File-checkpoint discovery is allowed to fail independently: the dialog
                    // must still expose message-only rewind for a valid Session boundary.
                    json(response, 200, { status: 'failed', error: errorMessage(error) });
                    return;
                }
                if (checkpoint === undefined) {
                    const durableSkip = await engine.findTurnCheckpointSkip({
                        cwd: target.cwd,
                        sessionId,
                        turn: target.turn,
                        turnStartSeq: target.turnStartSeq,
                    });
                    json(response, 200, durableSkip === undefined
                        ? coordinator.state(sessionId, target.turn)
                        : { status: 'skipped', reason: durableSkip.reason });
                    return;
                }
                const inspection = await engine.inspect({ cwd: checkpoint.cwd, restorePointId: checkpoint.id });
                const activeSessionIds = await sharedWorkspaceSessions(ctx.agents, checkpoint.cwd);
                const changes = inspection.changes.slice(offset, offset + limit);
                const common = {
                    status: 'ready', sessionId, messageSeq, turn: checkpoint.turn, checkpointId: checkpoint.id,
                    turnStartSeq: checkpoint.turnStartSeq,
                    totalChanges: inspection.changes.length,
                    changes: changes.map(change => ({ path: change.path, kind: change.kind })),
                    offset,
                    truncated: offset + changes.length < inspection.changes.length,
                    headChanged: inspection.headChanged,
                    operationChanged: inspection.operationChanged,
                    checkpointHead: inspection.restorePoint.head,
                    checkpointBranch: inspection.restorePoint.branch,
                    checkpointOperation: inspection.restorePoint.operation,
                    currentHead: inspection.currentHead,
                    currentBranch: inspection.currentBranch,
                    currentOperation: inspection.currentOperation,
                    activeSessionIds,
                    restoreBlocked: activeSessionIds.length > 0 || inspection.operationChanged,
                };
                if (inspection.changes.length === 0) {
                    json(response, 200, common);
                    return;
                }
                if (detailsOnly || activeSessionIds.length > 0 || inspection.operationChanged) {
                    json(response, 200, common);
                    return;
                }
                const plan = await engine.planRestore({
                    cwd: checkpoint.cwd,
                    restorePointId: checkpoint.id,
                    sessionId,
                    allowHeadChange: inspection.headChanged,
                    expectedCurrentTreeHash: inspection.currentTreeHash,
                    expectedRepository: inspection.currentRepository,
                });
                json(response, 200, { ...common, planId: plan.id, confirmation: plan.confirmation });
                return;
            }
            if (request.method === 'POST') {
                const body = objectBody(await readBody(request));
                const mode = body.mode;
                if (mode !== 'code' && mode !== 'both' && mode !== 'messages') {
                    throw new ChangeLedgerError('INVALID_ARGUMENTS', 'mode must be "code", "both", or "messages"');
                }
                const sessionId = requiredText(body.sessionId, 'sessionId');
                const messageSeq = nonNegativeInteger(body.messageSeq, 'messageSeq');
                if (mode === 'messages') {
                    // Message-only rewind never mutates project files, so no checkpoint, no
                    // restore plan, and no shared-workspace gate apply; the conversation
                    // restart revalidates the message boundary itself.
                    const { target } = await resolveMessageTarget(ctx, sessionId, messageSeq);
                    const fork = await createConversationRestart(ctx, sessionId, target);
                    json(response, 200, { status: 'completed', mode, sessionId: fork.sessionId });
                    return;
                }
                const checkpointId = requiredText(body.checkpointId, 'checkpointId');
                const checkpoint = await checkpointForRequest(ctx, engine, sessionId, messageSeq, checkpointId);
                const activeSessionIds = await sharedWorkspaceSessions(ctx.agents, checkpoint.cwd);
                if (activeSessionIds.length > 0) {
                    throw new ChangeLedgerError('WORKSPACE_IN_USE', `project files are also used by active sessions: ${activeSessionIds.slice(0, 5).join(', ')}`);
                }
                const planId = optionalText(body.planId, 'planId');
                const confirmation = optionalText(body.confirmation, 'confirmation');
                if (planId === undefined || confirmation === undefined) {
                    throw new ChangeLedgerError('NO_CHANGES', 'the selected turn has no project files to restore');
                }
                const restoreResult = await engine.applyRestore({ planId, confirmation, sessionId });
                if (mode === 'code') {
                    json(response, 200, { status: 'completed', mode, ...restoreResult });
                    return;
                }
                try {
                    const fork = await createConversationRestart(ctx, sessionId, checkpoint);
                    json(response, 200, { status: 'completed', mode, sessionId: fork.sessionId, ...restoreResult });
                }
                catch (forkError) {
                    if (restoreResult === undefined)
                        throw forkError;
                    try {
                        const rollbackPlan = await engine.planRestore({
                            cwd: checkpoint.cwd,
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
async function readSession(ctx, sessionId) {
    const live = ctx.sessions.get(sessionId);
    if (live !== undefined)
        return live;
    const stored = await ctx.sessionQuery.readSession(sessionId);
    return { id: sessionId, header: stored.session, events: stored.events };
}
async function resolveMessageTarget(ctx, sessionId, messageSeq) {
    const session = await readSession(ctx, sessionId);
    return { session, target: messageTarget(session, messageSeq) };
}
async function resolveMessageCheckpoint(ctx, engine, sessionId, source, target) {
    let current = source;
    const direct = await engine.findTurnCheckpoint({ cwd: target.cwd, sessionId, turn: target.turn });
    if (direct !== undefined) {
        if (direct.turnStartSeq !== target.turnStartSeq) {
            throw new ChangeLedgerError('PLAN_STALE', 'the message checkpoint no longer matches its turn start');
        }
        return { ...target, id: direct.id };
    }
    const seen = new Set([sessionId]);
    while (true) {
        const parentId = current.header.parentSession;
        const seedLength = current.header.seedLength;
        if ((parentId === undefined) !== (seedLength === undefined)) {
            throw new ChangeLedgerError('PLAN_STALE', 'session fork lineage has incomplete parent metadata');
        }
        if (parentId === undefined || seedLength === undefined
            || target.messageSeq >= seedLength || target.turnStartSeq >= seedLength) {
            return undefined;
        }
        if (seen.has(parentId)) {
            throw new ChangeLedgerError('PLAN_STALE', 'session fork lineage contains a cycle');
        }
        seen.add(parentId);
        try {
            current = await readSession(ctx, parentId);
        }
        catch (error) {
            throw new ChangeLedgerError('PLAN_STALE', `parent session ${parentId} is unavailable`, { cause: error });
        }
        const parentTarget = messageTarget(current, target.messageSeq);
        if (parentTarget.turn !== target.turn
            || parentTarget.turnStartSeq !== target.turnStartSeq
            || parentTarget.previousTurnEndSeq !== target.previousTurnEndSeq) {
            throw new ChangeLedgerError('PLAN_STALE', 'session fork lineage no longer matches the inherited message boundary');
        }
        const inherited = await engine.findTurnCheckpoint({ cwd: target.cwd, sessionId: parentId, turn: target.turn });
        if (inherited === undefined)
            continue;
        if (inherited.turnStartSeq !== target.turnStartSeq) {
            throw new ChangeLedgerError('PLAN_STALE', 'the inherited message checkpoint no longer matches the fork boundary');
        }
        return { ...target, id: inherited.id };
    }
}
async function checkpointForRequest(ctx, engine, sessionId, messageSeq, requestedId) {
    const { session, target } = await resolveMessageTarget(ctx, sessionId, messageSeq);
    const checkpoint = await resolveMessageCheckpoint(ctx, engine, sessionId, session, target);
    if (checkpoint === undefined) {
        throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `message ${String(target.messageSeq)} has no rewind checkpoint`);
    }
    if (requestedId !== checkpoint.id) {
        throw new ChangeLedgerError('PLAN_STALE', 'the selected message checkpoint changed; reopen the rewind dialog');
    }
    return checkpoint;
}
async function createConversationRestart(ctx, sourceId, target) {
    const source = await readSession(ctx, sourceId);
    const current = messageTarget(source, target.messageSeq);
    if (current.turn !== target.turn
        || current.turnStartSeq !== target.turnStartSeq
        || current.previousTurnEndSeq !== target.previousTurnEndSeq) {
        throw new ChangeLedgerError('PLAN_STALE', 'the session no longer contains the selected message boundary');
    }
    const response = target.previousTurnEndSeq === undefined
        ? await ctx.apiProxy.sessions.create({
            rpcId: randomUUID(),
            payload: { cwd: target.cwd },
        })
        : await ctx.apiProxy.sessions.fork({
            rpcId: randomUUID(),
            payload: { sessionId: sourceId, atSeq: target.previousTurnEndSeq },
        });
    if (!response.result.ok) {
        throw new ChangeLedgerError('CONVERSATION_REWIND_FAILED', response.result.error.message);
    }
    return { sessionId: requiredText(response.result.value.sessionId, 'fork sessionId') };
}
function messageTarget(session, messageSeq) {
    const cwd = session.header.cwd;
    if (cwd === undefined)
        throw new ChangeLedgerError('WORKSPACE_REQUIRED', `session ${session.id} has no workspace`);
    const message = session.events.find(event => event.type === 'user/message' && event.seq === messageSeq && isDirectUserMessage(event));
    if (message === undefined) {
        throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', `session ${session.id} has no user message at ${String(messageSeq)}`);
    }
    const start = session.events.findLast(event => event.type === 'turn/start' && event.seq < messageSeq);
    const turn = start?.data.turn;
    if (start === undefined || !Number.isSafeInteger(turn) || turn < 0) {
        throw new ChangeLedgerError('PLAN_STALE', 'the selected user message has no valid turn start');
    }
    const openingMessage = session.events.find(event => (event.type === 'user/message'
        && event.seq > start.seq
        && event.seq <= messageSeq
        && isDirectUserMessage(event)));
    if (openingMessage?.seq !== messageSeq) {
        throw new ChangeLedgerError('RESTORE_POINT_NOT_FOUND', 'rewind is available only for the opening user message of a turn');
    }
    const interveningEnd = session.events.find(event => event.type === 'turn/end' && event.seq > start.seq && event.seq < messageSeq);
    if (interveningEnd !== undefined) {
        throw new ChangeLedgerError('PLAN_STALE', 'the selected user message is outside its recorded turn');
    }
    const previousEnd = session.events.findLast(event => event.type === 'turn/end' && event.seq < start.seq);
    return {
        messageSeq,
        turn: turn,
        turnStartSeq: start.seq,
        ...(previousEnd === undefined ? {} : { previousTurnEndSeq: previousEnd.seq }),
        cwd,
    };
}
function isDirectUserMessage(event) {
    const source = event.data.source;
    return source !== null && typeof source === 'object' && !Array.isArray(source)
        && source.kind === 'user';
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
function pageSize(value, fallback) {
    if (value === null || value === undefined)
        return fallback;
    const parsed = nonNegativeInteger(value, 'limit');
    if (parsed < 1 || parsed > MAX_CHANGE_PAGE_SIZE) {
        throw new ChangeLedgerError('INVALID_ARGUMENTS', `limit must be between 1 and ${String(MAX_CHANGE_PAGE_SIZE)}`);
    }
    return parsed;
}
async function sharedWorkspaceSessions(agents, cwd) {
    const listed = agents?.list() ?? [];
    if (listed.length === 0)
        return [];
    const root = await discoverRepositoryRoot(cwd);
    const shared = [];
    for (const agent of listed) {
        if (agent.status !== 'running')
            continue;
        const session = agent.session;
        if (session.header.cwd === undefined)
            continue;
        try {
            if (await discoverRepositoryRoot(session.header.cwd) === root)
                shared.push(session.id);
        }
        catch {
            // A live Session whose cwd is not a valid Git worktree cannot share this worktree.
        }
    }
    return shared.sort();
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
