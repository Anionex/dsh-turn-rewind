import { type ReactNode } from 'react';
interface ConversationNodeLike {
    readonly kind: string;
    readonly seq: number;
    readonly content?: readonly {
        readonly type: string;
        readonly text?: string;
    }[];
}
interface ConversationChatNodeLike {
    readonly key: string;
    readonly kind: string;
    readonly data: ConversationNodeLike;
}
/**
 * Chat node store exposed by the Chat target. DSH 0.1.2+ publishes a mutable
 * keyed store; older clients published a Map with the same `get` contract.
 */
interface ChatNodeStoreLike {
    get(key: string): RewindNodeLike | undefined;
    values?(): Iterable<RewindNodeLike>;
}
/** Chat projection shared by `session.chat` (0.1.1) and the `useChat` hook (0.1.2+). */
interface ChatSnapshotLike {
    readonly order?: readonly string[];
    readonly nodes?: ChatNodeStoreLike | readonly RewindNodeLike[];
}
/**
 * Snapshot seen by a session-scoped slot entry. 0.1.1 exposes the chat
 * projection as `snapshot.chat`; 0.1.2+ moved it to the separate `useChat`
 * hook, so the same snapshot is the chat projection itself.
 */
interface ConversationSnapshotLike extends ChatSnapshotLike {
    readonly chat?: ChatSnapshotLike;
}
/** Selector hook shape shared by `useSession` and `useChat`. */
type SnapshotSelectorHook = <T>(selector: (snapshot: ConversationSnapshotLike) => T) => T;
type RewindNodeLike = ConversationNodeLike | ConversationChatNodeLike;
interface RewindMatch {
    readonly messageSeq: number;
    readonly promptText: string;
}
interface RewindMessageActionProps {
    readonly matched: RewindMatch;
    readonly sessionId: string;
    readonly openRestoredSession: (sessionId: string, promptText: string) => Promise<void>;
}
interface RewindPortalBridgeProps {
    readonly sessionId: string;
    readonly openRestoredSession: (sessionId: string, promptText: string) => Promise<void>;
    readonly useSession: SnapshotSelectorHook;
    readonly useChat?: SnapshotSelectorHook;
}
interface SlotsLike {
    inject(name: string, install: () => unknown): void;
    register<I, P>(entry: {
        readonly name: string;
        readonly id?: string;
        readonly key?: string;
        readonly order?: number;
        readonly locale?: string;
        readonly inject?: () => I;
    }, component: (props: P) => ReactNode): () => void;
}
interface ClientContextLike {
    readonly slots: SlotsLike;
    readonly sessions: {
        open(sessionId: string): void;
        scope(sessionId: string): unknown | undefined;
    };
    readonly conversation: {
        readonly input: {
            for(scope: unknown): {
                setDraft(text: string): void;
            };
        };
    };
    readonly settingsScope?: {
        bind<T>(spec: {
            readonly namespace: string;
        }): SettingsScopeLike<T>;
    };
    effect(setup: () => (() => void), label?: string): unknown;
}
type ChangeKind = 'added' | 'deleted' | 'modified' | 'mode-changed' | 'type-changed';
/** Runtime-tunable Turn Rewind settings mirrored from the `turn-rewind` namespace. */
export interface TurnRewindSettingsValue {
    readonly maxRestorePoints: number;
    readonly maxTurnCheckpointsPerSession: number;
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxSnapshotBytes: number;
    readonly planTtlMs: number;
    readonly staleLockMs: number;
    readonly turnCheckpointMode: 'off' | 'git-native' | 'legacy';
    readonly turnCheckpointTimeoutMs: number;
    readonly turnCheckpointMaxNewBytes: number;
    readonly turnCheckpointTrust: 'fast' | 'strict';
}
/** Browser mirror of one settings namespace, as bound by `ctx.settingsScope`. */
export interface SettingsScopeLike<T> {
    getSnapshot(): SettingsScopeSnapshotLike<T>;
    subscribe(listener: () => void): () => void;
    set(field: string, value: unknown): Promise<void>;
    unset(field: string): Promise<void>;
}
/** Sync snapshot shape shared by every settings scope. */
export interface SettingsScopeSnapshotLike<T> {
    readonly status: 'loading' | 'ready' | 'unavailable';
    readonly value: T | undefined;
    readonly base: unknown;
    readonly user: unknown;
    readonly revision: number | undefined;
    readonly writable: boolean;
    readonly mode: 'host' | 'memory';
}
/** One checkpoint row in the storage-management overview. */
export interface ManageRestorePoint {
    readonly id: string;
    readonly kind: string;
    readonly format: number;
    readonly createdAt: number;
    readonly totalBytes: number;
    readonly fileCount: number;
    readonly sessionId?: string;
    readonly label?: string;
}
/** One workspace group in the storage-management overview. */
export interface ManageWorkspace {
    readonly workspace: string;
    readonly totalBytes: number;
    readonly recoveryCount: number;
    readonly restorePoints: readonly ManageRestorePoint[];
}
/** Storage-management overview served by `/turn-rewind/manage`. */
export interface ManageOverview {
    readonly storageDir: string;
    readonly totalBytes: number;
    readonly workspaces: readonly ManageWorkspace[];
}
/** Return the rewind anchor and editable text owned by one direct user message. */
export declare function selectRewindMessage(node: ConversationNodeLike): RewindMatch | null;
/**
 * Browser plugin entry: bridge every direct user-message action row to the rewind UI.
 *
 * Every service read on `ctx` must be declared here: Cordis throws while reading an
 * undeclared service off the context proxy, before optional chaining can apply.
 * `settingsScope` is provided by `@deepseek-ai/dsh-client-ui-settings` and may be
 * absent, which is what `ctx.settingsScope?.bind(…)` below relies on.
 */
export declare const inject: string[];
export declare function apply(ctx: ClientContextLike): void;
/**
 * Resolve the ordered chat node list from one chat projection.
 *
 * Both inputs keep a stable identity across renders: `order` is republished only
 * when the node set changes and the store is a mutable handle, so the caller can
 * memoize the list instead of allocating a new array on every render (a fresh
 * array per render makes `useSyncExternalStore` loop forever).
 * @param order - ordered node keys, or null when the projection is absent.
 * @param store - keyed node store, a legacy node array, or null.
 * @returns the chat nodes in render order.
 */
export declare function collectChatNodes(order: readonly string[] | null, store: ChatNodeStoreLike | readonly RewindNodeLike[] | null): readonly RewindNodeLike[];
/** Session-scoped bridge that portals rewind controls into direct user-message action rows. */
export declare function RewindMessagePortals({ sessionId, openRestoredSession, useSession, useChat }: RewindPortalBridgeProps): ReactNode;
/** User-message action and its review-first file/conversation restore dialog. */
export declare function RewindMessageAction({ matched, sessionId, openRestoredSession }: RewindMessageActionProps): ReactNode;
interface TurnRewindSettingsCardProps {
    readonly scope: SettingsScopeLike<TurnRewindSettingsValue> | undefined;
}
/** Settings card for the `turn-rewind` namespace: runtime options plus checkpoint management. */
export declare function TurnRewindSettingsCard({ scope }: TurnRewindSettingsCardProps): ReactNode;
/** Format one byte count with human-friendly units. */
export declare function formatBytes(bytes: number): string;
/** Resolve one conversation node to its DOM row key and rewind match. */
export declare function selectRewindMessageTarget(value: RewindNodeLike): {
    readonly matched: RewindMatch;
    readonly rowKey: string;
} | null;
/**
 * Read one rewind response body without ever leaking a raw parse error.
 *
 * A missing route, a restarted Host, or a proxy answering before the plugin
 * loads all produce a body that is not the plugin's JSON envelope; those must
 * surface as an explained failure instead of `Failed to execute 'json' …`.
 * @param response - fetch response from the rewind endpoint.
 * @returns the decoded JSON body.
 */
export declare function responseJson(response: Response): Promise<unknown>;
/** Describe the user-visible result of restoring one changed file. */
export declare function fileRecoveryLabel(kind: ChangeKind): string;
/**
 * Explain one recorded checkpoint failure in user terms.
 *
 * The Host records the raw `[CODE] diagnostic` line; a non-Git project
 * directory is the common case and deserves a plain sentence instead of a
 * `git rev-parse` transcript.
 * @param message - recorded checkpoint failure message.
 * @returns one user-facing sentence.
 */
export declare function explainCheckpointFailure(message: string): string;
export {};
