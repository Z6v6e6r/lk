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
): Promise<T> {
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(normalizedTimeoutMs));
    }, normalizedTimeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
