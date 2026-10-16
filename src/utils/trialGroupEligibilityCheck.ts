export type TrialGroupEligibilityDecision = {
  status: "allowed" | "denied" | "error";
  message: string | null;
};

type EligibilityResult = {
  status: number | null;
  error: { raw?: unknown } | null;
  data: unknown;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function resolveTrialGroupEligibilityCheck(result: EligibilityResult): TrialGroupEligibilityDecision {
  const raw = result.error?.raw;
  const details = record(raw) && record(raw.details) ? raw.details : null;
  if (result.status === 409 && details?.code === "TRIAL_TRAINING_VISIT_LIMIT_EXCEEDED") {
    return {
      status: "denied",
      message: "Пробная тренировка доступна при не более двух подтверждённых посещений за последние шесть месяцев.",
    };
  }
  const data = result.data;
  if (!result.error && result.status === 200 && record(data)
    && data.eligible === true && data.mode === "enforce"
    && Number.isSafeInteger(data.count) && Number(data.count) >= 0 && Number(data.count) <= 2) {
    return { status: "allowed", message: null };
  }
  return { status: "error", message: "Не удалось проверить возможность пробной тренировки. Попробуйте ещё раз позже." };
}
