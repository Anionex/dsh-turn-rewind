/** Stable error carrying a machine-readable change-ledger code. */
export class ChangeLedgerError extends Error {
  override readonly name = 'ChangeLedgerError'

  /**
   * @param code - Stable error category.
   * @param message - Human-readable diagnostic.
   * @param cause - Optional lower-level failure.
   */
  constructor(
    readonly code: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`[${code}] ${message}`, options)
  }
}

/** Convert an unknown thrown value into one bounded diagnostic line. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2_000)
  return String(error).slice(0, 2_000)
}
