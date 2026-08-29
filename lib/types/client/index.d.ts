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
interface ConversationSnapshotLike {
    readonly nodes: readonly ConversationNodeLike[];
    readonly chat?: {
        readonly nodes: {
            values(): readonly ConversationChatNodeLike[];
        };
    };
}
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
    readonly useSession: <T>(selector: (snapshot: ConversationSnapshotLike) => T) => T;
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
/** Browser plugin entry: bridge every direct user-message action row to the rewind UI. */
export declare const inject: string[];
export declare function apply(ctx: ClientContextLike): void;
/** Session-scoped bridge that portals rewind controls into direct user-message action rows. */
export declare function RewindMessagePortals({ sessionId, openRestoredSession, useSession }: RewindPortalBridgeProps): ReactNode;
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
/** Describe the user-visible result of restoring one changed file. */
export declare function fileRecoveryLabel(kind: ChangeKind): string;
export {};
