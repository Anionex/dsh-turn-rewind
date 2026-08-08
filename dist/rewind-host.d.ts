import type { Context } from 'cordis';
import type { ChangeLedgerEngine } from './engine.js';
interface SessionEventLike {
    readonly type: string;
    readonly seq: number;
    readonly data: Record<string, unknown>;
}
interface SessionLike {
    readonly id: string;
    readonly header: {
        readonly cwd?: string;
    };
    readonly events: readonly SessionEventLike[];
}
interface AgentLike {
    readonly id: string;
    readonly status: 'idle' | 'running';
    readonly session: SessionLike;
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
interface AgentsLike {
    list(): AgentLike[];
}
interface SessionsLike {
    get(id: string): SessionLike | undefined;
}
interface SessionQueryLike {
    readSession(id: string): Promise<{
        readonly header: {
            readonly cwd?: string;
        };
        readonly events: readonly SessionEventLike[];
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
declare module 'cordis' {
    interface Context {
        agents: AgentsLike;
        sessions: SessionsLike;
        sessionQuery: SessionQueryLike;
        httpServer: HttpServerLike;
        apiProxy: ApiProxyLike;
    }
    interface Events {
        'agent/created'(payload: {
            readonly agent: AgentLike;
        }): void;
        'agent/status'(payload: {
            readonly agent: AgentLike;
            readonly status: 'idle' | 'running';
        }): void;
    }
}
export declare const REWIND_HTTP_PATH = "/change-ledger/rewind";
/** In-memory capture status used to distinguish a pending checkpoint from a permanent miss. */
export declare class TurnCheckpointCoordinator {
    private readonly engine;
    private readonly scheduled;
    private readonly pending;
    private readonly failures;
    constructor(engine: ChangeLedgerEngine);
    /** Install idle-boundary capture listeners while the Agent service is present. */
    install(ctx: Context): void;
    /** Current capture state for a session turn when no durable checkpoint exists yet. */
    state(sessionId: string, turn: number): {
        readonly status: 'pending' | 'failed' | 'missing';
        readonly error?: string;
    };
    private schedule;
}
/** Register the same-origin preview/apply endpoint consumed by the browser half. */
export declare function installRewindHttp(ctx: Context, engine: ChangeLedgerEngine, coordinator: TurnCheckpointCoordinator): void;
/** Build the exact-route handler as a testable unit. */
export declare function createRewindHttpHandler(ctx: Pick<Context, 'sessions' | 'sessionQuery' | 'apiProxy'>, engine: ChangeLedgerEngine, coordinator: TurnCheckpointCoordinator): (request: HttpRequestLike, response: HttpResponseLike) => Promise<void>;
export {};
//# sourceMappingURL=rewind-host.d.ts.map