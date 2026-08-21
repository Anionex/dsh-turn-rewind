export interface Deadline {
    readonly signal: AbortSignal;
    cancel(): void;
}
/** Create a cancellable timeout whose timer keeps Node alive until it fires. */
export declare function createDeadline(timeoutMs: number): Deadline;
