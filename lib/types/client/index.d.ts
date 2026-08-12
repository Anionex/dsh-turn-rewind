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
    register(entry: {
        readonly name: string;
        readonly id: string;
        readonly order: number;
        readonly inject: () => {
            readonly openRestoredSession: (sessionId: string, promptText: string) => Promise<void>;
        };
    }, component: (props: RewindPortalBridgeProps) => ReactNode): () => void;
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
    effect(setup: () => (() => void), label?: string): unknown;
}
type ChangeKind = 'added' | 'deleted' | 'modified' | 'mode-changed' | 'type-changed';
/** Return the rewind anchor and editable text owned by one direct user message. */
export declare function selectRewindMessage(node: ConversationNodeLike): RewindMatch | null;
/** Browser plugin entry: bridge every direct user-message action row to the rewind UI. */
export declare const inject: string[];
export declare function apply(ctx: ClientContextLike): void;
/** Session-scoped bridge that portals rewind controls into direct user-message action rows. */
export declare function RewindMessagePortals({ sessionId, openRestoredSession, useSession }: RewindPortalBridgeProps): ReactNode;
/** User-message action and its review-first file/conversation restore dialog. */
export declare function RewindMessageAction({ matched, sessionId, openRestoredSession }: RewindMessageActionProps): ReactNode;
/** Resolve one conversation node to its DOM row key and rewind match. */
export declare function selectRewindMessageTarget(value: RewindNodeLike): {
    readonly matched: RewindMatch;
    readonly rowKey: string;
} | null;
/** Describe the user-visible result of restoring one changed file. */
export declare function fileRecoveryLabel(kind: ChangeKind): string;
export {};
