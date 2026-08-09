/** Stable error carrying a machine-readable change-ledger code. */
export declare class ChangeLedgerError extends Error {
    readonly code: string;
    readonly name = "ChangeLedgerError";
    /**
     * @param code - Stable error category.
     * @param message - Human-readable diagnostic.
     * @param cause - Optional lower-level failure.
     */
    constructor(code: string, message: string, options?: {
        readonly cause?: unknown;
    });
}
/** Convert an unknown thrown value into one bounded diagnostic line. */
export declare function errorMessage(error: unknown): string;
