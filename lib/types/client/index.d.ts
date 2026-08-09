import { type ReactNode } from 'react';
interface ConversationNodeLike {
    readonly kind: string;
    readonly seq: number;
    readonly turn?: number;
}
interface TurnTailOwnerLike {
    readonly nodes: readonly ConversationNodeLike[];
    readonly seq: number;
}
interface ConversationSnapshotLike {
    readonly nodes: readonly ConversationNodeLike[];
}
interface RewindMatch {
    readonly turn: number;
    readonly seq: number;
}
interface RewindTailProps {
    readonly matched: RewindMatch;
    readonly sessionId: string;
    readonly openSession: (sessionId: string) => void;
}
interface RewindPortalBridgeProps {
    readonly sessionId: string;
    readonly openSession: (sessionId: string) => void;
    readonly useSession: <T>(selector: (snapshot: ConversationSnapshotLike) => T) => T;
}
interface SlotsLike {
    inject(name: string, install: () => unknown): void;
    register(entry: {
        readonly name: string;
        readonly id: string;
        readonly order: number;
        readonly inject: () => {
            readonly openSession: (sessionId: string) => void;
        };
    }, component: (props: RewindPortalBridgeProps) => ReactNode): () => void;
}
interface ClientContextLike {
    readonly slots: SlotsLike;
    readonly sessions: {
        open(sessionId: string): void;
    };
    effect(setup: () => (() => void), label?: string): unknown;
}
/** Return the completed turn closed by one assistant-tail anchor. */
export declare function selectRewindTurn(owner: TurnTailOwnerLike): RewindMatch | null;
/** Browser plugin entry: bridge every finalized assistant action row to the rewind UI. */
export declare const inject: string[];
export declare function apply(ctx: ClientContextLike): void;
/** Session-scoped bridge that portals rewind controls into finalized assistant action rows. */
export declare function RewindTurnPortals({ sessionId, openSession, useSession }: RewindPortalBridgeProps): ReactNode;
/** Turn-tail action and its review-first code/conversation restore dialog. */
export declare function RewindTurnTail({ matched, sessionId, openSession }: RewindTailProps): ReactNode;
export {};
