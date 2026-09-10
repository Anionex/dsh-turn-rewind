import type { Context } from '@deepseek-ai/cordis';
import type { ChangeLedgerEngine } from './engine.js';
interface SessionEventLike {
    readonly type: string;
    readonly seq: number;
    readonly data: Record<string, unknown>;
}
interface SessionHeaderLike {
    readonly cwd?: string;
    readonly parentSession?: string;
    /**
     * Fork-inherited prefix length on DSH releases before 0.1.5. 0.1.5 deleted the
     * field — a stored header that still carries it is rejected outright — and moved
     * the same quantity to {@link SessionLike.inheritedEventCount}.
     */
    readonly seedLength?: number;
}
interface SessionLike {
    readonly id: string;
    readonly header: SessionHeaderLike;
    /**
     * Exact number of leading events inherited from the fork parent, as reported by
     * DSH 0.1.5+ on the live session and on the stored session-log snapshot. `0` —
     * never `undefined` — for a session with no inherited prefix.
     */
    readonly inheritedEventCount?: number;
    readonly events?: readonly SessionEventLike[];
    snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[];
}
interface AgentLike {
    readonly id: string;
    readonly status: 'idle' | 'running';
    readonly session: SessionLike;
}
interface ToolExecutionLike {
    readonly agent?: AgentLike;
    readonly parent?: symbol;
    readonly signal: AbortSignal;
}
interface AgentsLike {
    list(): AgentLike[];
}
interface SessionsLike {
    get(id: string): SessionLike | undefined;
}
interface SessionQueryLike {
    readSession(id: string): Promise<{
        readonly session: SessionHeaderLike;
        readonly events: readonly SessionEventLike[];
        readonly inheritedEventCount?: number;
    }>;
}
interface HttpRequestLike {
    method?: string;
    url?: string;
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
}
interface HttpResponseLike {
    writeHead(status: number, headers?: Record<string, string>): unknown;
    end(body?: string): void;
}
interface HttpServerLike {
    register(route: {
        kind: 'exact';
        path: string;
        handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>;
    }): () => void;
}
interface ApiProxyLike {
    readonly sessions: {
        create(request: {
            readonly rpcId: string;
            readonly payload: {
                readonly cwd: string;
            };
        }): Promise<{
            readonly result: {
                readonly ok: true;
                readonly value: {
                    readonly sessionId: string;
                };
            } | {
                readonly ok: false;
                readonly error: {
                    readonly message: string;
                };
            };
        }>;
        fork(request: {
            readonly rpcId: string;
            readonly payload: {
                readonly sessionId: string;
                readonly atSeq: number;
            };
        }): Promise<{
            readonly result: {
                readonly ok: true;
                readonly value: {
                    readonly sessionId: string;
                };
            } | {
                readonly ok: false;
                readonly error: {
                    readonly message: string;
                };
            };
        }>;
    };
}
/**
 * Conversation create/fork capability of the Session controller service.
 *
 * DSH 0.1.2-alpha replaced the `apiProxy` RPC envelope with this plain service,
 * so carriers without `apiProxy` (DSH Desktop 2.x) reach the same capability here.
 */
interface SessionControllerLike {
    create(request: {
        readonly cwd?: string;
        readonly workspaceId?: string;
    }): Promise<{
        readonly sessionId: string;
    }>;
    fork(request: {
        readonly sessionId: string;
        readonly atSeq?: number;
    }): Promise<{
        readonly sessionId: string;
    }>;
}
/** Services a conversation restart can be built on, in either carrier shape. */
type ConversationRestartContext = Pick<Context, 'sessions' | 'sessionQuery'> & {
    readonly apiProxy?: ApiProxyLike;
    readonly sessionController?: SessionControllerLike;
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        agents: AgentsLike;
        sessions: SessionsLike;
        sessionQuery: SessionQueryLike;
        webServer: HttpServerLike;
        apiProxy: ApiProxyLike;
        sessionController: SessionControllerLike;
    }
    interface Events {
        'agent/pre-step'(payload: {
            readonly agent: AgentLike;
            readonly turn: number;
            readonly step: number;
            readonly signal: AbortSignal;
        }, next: () => Promise<unknown>): Promise<unknown>;
        'tools/execute'(exec: ToolExecutionLike, next: () => Promise<unknown>): Promise<unknown>;
    }
}
export declare const REWIND_HTTP_PATH = "/turn-rewind";
/** Capture each turn beside model work and gate root tool side effects on its bounded outcome. */
export declare class TurnCheckpointCoordinator {
    private readonly engine;
    private readonly captures;
    private readonly pending;
    private readonly failures;
    private readonly skips;
    private readonly workspaceTails;
    constructor(engine: ChangeLedgerEngine);
    /** Keep sidecar checkpoint work out of the Agent response waterfall. */
    install(ctx: Context): void;
    /** Current capture state for a session turn when no durable checkpoint exists yet. */
    state(sessionId: string, turn: number): {
        readonly status: 'pending' | 'failed' | 'skipped' | 'missing';
        readonly error?: string;
        readonly reason?: string;
    };
    private startCapture;
    private capture;
    /** Wait only for the bounded checkpoint outcome of the Agent's open turn. */
    private waitForOpenTurn;
    private serializeWorkspace;
    private recordFailure;
}
/** Register the same-origin preview/apply endpoint consumed by the browser half. */
export declare function installRewindHttp(ctx: Context, engine: ChangeLedgerEngine, coordinator: TurnCheckpointCoordinator): void;
/** Build the exact-route handler as a testable unit. */
export declare function createRewindHttpHandler(ctx: ConversationRestartContext & {
    readonly agents?: AgentsLike;
}, engine: ChangeLedgerEngine, coordinator: TurnCheckpointCoordinator): (request: HttpRequestLike, response: HttpResponseLike) => Promise<void>;
export declare const MANAGE_HTTP_PATH = "/turn-rewind/manage";
/** Register the same-origin storage-management endpoint consumed by the settings card. */
export declare function installManageHttp(ctx: Context, engine: ChangeLedgerEngine): void;
/** Build the storage-management route as a testable unit. */
export declare function createManageHttpHandler(engine: ChangeLedgerEngine): (request: HttpRequestLike, response: HttpResponseLike) => Promise<void>;
export {};
