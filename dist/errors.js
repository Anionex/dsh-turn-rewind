/** Stable error carrying a machine-readable change-ledger code. */
export class ChangeLedgerError extends Error {
    code;
    name = 'ChangeLedgerError';
    /**
     * @param code - Stable error category.
     * @param message - Human-readable diagnostic.
     * @param cause - Optional lower-level failure.
     */
    constructor(code, message, options) {
        super(`[${code}] ${message}`, options);
        this.code = code;
    }
}
/** Convert an unknown thrown value into one bounded diagnostic line. */
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message.slice(0, 2_000);
    return String(error).slice(0, 2_000);
}
//# sourceMappingURL=errors.js.map