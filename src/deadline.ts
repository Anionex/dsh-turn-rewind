export interface Deadline {
  readonly signal: AbortSignal
  cancel(): void
}

/** Create a cancellable timeout whose timer keeps Node alive until it fires. */
export function createDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`deadline exceeded after ${String(timeoutMs)} ms`, 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer)
    },
  }
}
