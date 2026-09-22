/**
 * Классификация отказов загрузки расписания.
 *
 * Нужна, чтобы в интерфейс не попадали сырые тексты браузера вида
 * «signal is aborted without reason» (это `AbortError` от нашего же таймаута),
 * а отмена запроса при размонтировании не показывалась как ошибка.
 */

export type AtlantyScheduleFailureKind = "timeout" | "aborted" | "http" | "network";

export type AtlantyScheduleFailure = {
  kind: AtlantyScheduleFailureKind;
  status?: number;
  /** Текст для пользователя; для `aborted` пустой — ошибку показывать не нужно. */
  message: string;
  /** Техническая причина для console.warn. */
  reason: string;
};

export const ATLANTY_SCHEDULE_FALLBACK_MESSAGE =
  "Не удалось загрузить расписание. Попробуйте обновить.";

export function formatAtlantyFailureMessage(
  kind: AtlantyScheduleFailureKind,
  status?: number,
): string {
  switch (kind) {
    case "timeout":
      return "Сервер расписания не ответил. Попробуйте обновить.";
    case "http":
      return status
        ? `Расписание временно недоступно (код ${status}). Попробуйте позже.`
        : "Расписание временно недоступно. Попробуйте позже.";
    case "network":
      return "Нет связи с сервером расписания. Проверьте интернет и попробуйте обновить.";
    case "aborted":
    default:
      return "";
  }
}

function readFailure(value: unknown): AtlantyScheduleFailure | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AtlantyScheduleFailure>;
  const kind = candidate.kind;
  if (
    kind !== "timeout"
    && kind !== "aborted"
    && kind !== "http"
    && kind !== "network"
  ) {
    return null;
  }
  return {
    kind,
    status: typeof candidate.status === "number" ? candidate.status : undefined,
    message: typeof candidate.message === "string" && candidate.message
      ? candidate.message
      : formatAtlantyFailureMessage(kind, candidate.status),
    reason: typeof candidate.reason === "string" ? candidate.reason : kind,
  };
}

export function createAtlantyFailure(
  kind: AtlantyScheduleFailureKind,
  reason: string,
  status?: number,
): AtlantyScheduleFailure {
  return {
    kind,
    status,
    message: formatAtlantyFailureMessage(kind, status),
    reason,
  };
}

export function isAtlantyAbortError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === "object"
    && (error as { name?: string }).name === "AbortError";
}

/**
 * Приводит любую ошибку загрузки к понятному виду.
 *
 * `AbortError` бывает трёх разных причин: наш таймаут, отмена вызывающей
 * стороной (размонтирование/смена конфига) и неожиданный обрыв на стороне
 * браузера. Показывать ошибку нужно только в первом и третьем случае,
 * а третий ещё и повторять — иначе витрина молча останется в скелетоне.
 */
export function classifyAtlantyFetchError(
  error: unknown,
  options: { timedOut?: boolean; callerAborted?: boolean } = {},
): AtlantyScheduleFailure {
  const known = readFailure(error);
  if (known) return known;

  if (isAtlantyAbortError(error)) {
    if (options.callerAborted) {
      return createAtlantyFailure("aborted", "request aborted by caller");
    }
    if (options.timedOut) {
      return createAtlantyFailure("timeout", "request timed out");
    }
    return createAtlantyFailure("network", "abort signal without caller abort");
  }

  const status = (error as { status?: number } | null)?.status;
  if (typeof status === "number") {
    return createAtlantyFailure("http", `http ${status}`, status);
  }

  const reason = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error ?? "unknown error");
  return createAtlantyFailure("network", reason);
}

/** Повторяем только то, что может пройти со второй попытки. */
export function shouldRetryAtlantyFailure(kind: AtlantyScheduleFailureKind): boolean {
  return kind === "timeout" || kind === "network";
}
