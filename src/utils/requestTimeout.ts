export class RequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isRequestTimeoutError(value: unknown): value is RequestTimeoutError {
  return value instanceof RequestTimeoutError;
}

export async function runWithAbortTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(normalizedTimeoutMs));
    }, normalizedTimeoutMs);
  });

  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(parentSignal?.reason ?? new DOMException("Request cancelled", "AbortError"));
    };
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    if (parentSignal?.aborted) onAbort();
  });

  try {
    // Do not start an operation whose owner has already cancelled it.
    if (parentSignal?.aborted) return await cancelled;
    return await Promise.race([operation(controller.signal), timeout, cancelled]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (onAbort) parentSignal?.removeEventListener("abort", onAbort);
  }
}
