export type BookingCancellationRefundMethod =
  | "CURRENCY"
  | "DEPOSIT"
  | "SERVICE"
  | "NONE";

export interface BookingCancellationMoneyOption {
  available?: boolean;
  refundSum?: number | null;
  refundMethod?: string | null;
  kkmCommandData?: unknown;
}

export interface BookingCancellationAmountOption {
  available?: boolean;
  refundSum?: number | null;
}

export interface BookingCancellationBooleanOption {
  available?: boolean;
}

export interface BookingCancellationOptions {
  money?: BookingCancellationMoneyOption | null;
  exercise?: BookingCancellationBooleanOption | null;
  cancellationOnly?: BookingCancellationBooleanOption | null;
  deposit?: BookingCancellationAmountOption | null;
  subscription?: BookingCancellationBooleanOption | null;
  settlementAccount?: BookingCancellationAmountOption | null;
  executor?: BookingCancellationAmountOption | null;
}

export interface BookingCancellationOptionsResponse {
  bookingId: string;
  cancellationOptions?: BookingCancellationOptions | null;
  canCancelExercise?: boolean;
}

export type BookingCancellationActionId = "card" | "deposit" | "subscription" | "none";

export interface BookingCancellationAction {
  id: BookingCancellationActionId;
  label: string;
  description: string;
  confirmLabel: string;
  successMessage: string;
  refundMethod: BookingCancellationRefundMethod | null;
  refundSumMinor: number | null;
}

export interface BookingCancellationPlan {
  mode: "selection" | "confirm" | "unsupported";
  promptTitle: string;
  promptText: string;
  actions: BookingCancellationAction[];
  unsupportedReason?: string;
}

export interface BookingCancellationVerificationRecord {
  id?: string | null;
  bookingId?: string | null;
  isCancelled?: boolean;
  cancelled?: boolean;
  cancellationDate?: string | null;
  cancelledAt?: string | null;
  bookingStatus?: string | null;
  status?: string | null;
}

export type BookingCancellationVerificationState = "cancelled" | "active" | "unverified";

export interface BookingCancellationVerification {
  bookingId: string;
  state: BookingCancellationVerificationState;
  record: BookingCancellationVerificationRecord | null;
}

const AUTOMATIC_ACTION_PRIORITY: BookingCancellationActionId[] = [
  "subscription",
  "card",
  "deposit",
  "none",
];

function isAvailable(value: { available?: boolean } | null | undefined): boolean {
  return value?.available === true;
}

function normalizeMinorAmount(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(Number(value)));
}

function normalizeComparableBookingId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isCancelledVerificationRecord(
  record: BookingCancellationVerificationRecord,
): boolean {
  if (record.isCancelled === true || record.cancelled === true) return true;
  if (String(record.cancellationDate || record.cancelledAt || "").trim()) return true;
  const status = String(record.bookingStatus || record.status || "").trim().toUpperCase();
  return status.includes("CANCEL");
}

export function resolveBookingCancellationVerification(
  bookingId: string,
  activeRecords: BookingCancellationVerificationRecord[],
  historyRecords: BookingCancellationVerificationRecord[],
): BookingCancellationVerification {
  const normalizedBookingId = normalizeComparableBookingId(bookingId);
  const matchingActiveRecords = activeRecords.filter((record) => (
    normalizeComparableBookingId(record.id || record.bookingId) === normalizedBookingId
  ));
  const activeRecord = matchingActiveRecords.find((record) => (
    !isCancelledVerificationRecord(record)
  )) ?? null;
  if (activeRecord) {
    return {
      bookingId,
      state: "active",
      record: activeRecord,
    };
  }

  const matchingRecords = [...historyRecords, ...matchingActiveRecords].filter((record) => (
    normalizeComparableBookingId(record.id || record.bookingId) === normalizedBookingId
  ));
  const cancelledRecord = matchingRecords.find(isCancelledVerificationRecord) ?? null;
  if (cancelledRecord) {
    return {
      bookingId,
      state: "cancelled",
      record: cancelledRecord,
    };
  }

  const unresolvedRecord = matchingRecords[0] ?? null;
  if (unresolvedRecord) {
    return {
      bookingId,
      state: "active",
      record: unresolvedRecord,
    };
  }

  return {
    bookingId,
    state: "unverified",
    record: null,
  };
}

export function formatMinorCurrency(value: number | null | undefined): string {
  const minor = normalizeMinorAmount(value) ?? 0;
  const rubles = minor / 100;
  const hasFraction = minor % 100 !== 0;
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(rubles).replace(/\u00a0/g, " ")} ₽`;
}

function buildCardAction(refundSumMinor: number | null): BookingCancellationAction {
  const amountLabel = formatMinorCurrency(refundSumMinor);
  return {
    id: "card",
    label: `На карту · ${amountLabel}`,
    description: `Возврат будет оформлен на карту: ${amountLabel}.`,
    confirmLabel: `Оформить возврат на карту · ${amountLabel}`,
    successMessage: `Возврат оформлен на карту: ${amountLabel}.`,
    refundMethod: "CURRENCY",
    refundSumMinor,
  };
}

function buildDepositAction(refundSumMinor: number | null): BookingCancellationAction {
  const amountLabel = formatMinorCurrency(refundSumMinor);
  return {
    id: "deposit",
    label: `На депозит · ${amountLabel}`,
    description: `Возврат будет оформлен на депозит: ${amountLabel}.`,
    confirmLabel: `Оформить возврат на депозит · ${amountLabel}`,
    successMessage: `Возврат оформлен на депозит: ${amountLabel}.`,
    refundMethod: "DEPOSIT",
    refundSumMinor,
  };
}

function buildSubscriptionAction(): BookingCancellationAction {
  return {
    id: "subscription",
    label: "Вернуть занятие на абонемент",
    description: "Будет возвращено 1 занятие на абонемент.",
    confirmLabel: "Вернуть занятие на абонемент",
    successMessage: "Вернули 1 занятие на абонемент.",
    refundMethod: "SERVICE",
    refundSumMinor: null,
  };
}

function buildNoneAction(): BookingCancellationAction {
  return {
    id: "none",
    label: "Отменить без возврата",
    description: "Возврат недоступен. Запись будет отменена без возврата средств.",
    confirmLabel: "Отменить без возврата",
    successMessage: "Запись отменена без возврата средств.",
    refundMethod: "NONE",
    refundSumMinor: null,
  };
}

export function resolveBookingCancellationPlan(
  response: BookingCancellationOptionsResponse,
): BookingCancellationPlan {
  const options = response.cancellationOptions ?? {};
  const moneyAvailable = isAvailable(options.money);
  const depositAvailable = isAvailable(options.deposit);
  const subscriptionAvailable = isAvailable(options.subscription);
  const cancellationOnlyAvailable = isAvailable(options.cancellationOnly);
  const settlementAvailable = isAvailable(options.settlementAccount);
  const exerciseAvailable = isAvailable(options.exercise);

  if (subscriptionAvailable && !moneyAvailable && !depositAvailable) {
    const action = buildSubscriptionAction();
    return {
      mode: "confirm",
      promptTitle: "Возврат на абонемент",
      promptText: action.description,
      actions: [action],
    };
  }

  const moneyAction = moneyAvailable ? buildCardAction(normalizeMinorAmount(options.money?.refundSum)) : null;
  const depositAction = depositAvailable ? buildDepositAction(normalizeMinorAmount(options.deposit?.refundSum)) : null;
  const monetaryActions = [moneyAction, depositAction].filter((item): item is BookingCancellationAction => Boolean(item));

  if (monetaryActions.length > 1) {
    return {
      mode: "selection",
      promptTitle: "Куда оформить возврат",
      promptText: "Выберите, куда оформить возврат.",
      actions: monetaryActions,
    };
  }

  if (monetaryActions.length === 1) {
    return {
      mode: "confirm",
      promptTitle: "Подтвердите возврат",
      promptText: monetaryActions[0].description,
      actions: monetaryActions,
    };
  }

  if (cancellationOnlyAvailable) {
    const action = buildNoneAction();
    return {
      mode: "confirm",
      promptTitle: "Подтвердите отмену",
      promptText: action.description,
      actions: [action],
    };
  }

  if (settlementAvailable && !exerciseAvailable) {
    return {
      mode: "unsupported",
      promptTitle: "Возврат недоступен",
      promptText: "",
      actions: [],
      unsupportedReason: "Для этой записи Viva предлагает возврат только на лицевой счет. Этот сценарий пока не поддержан в ЛК. Обратитесь в поддержку.",
    };
  }

  if (exerciseAvailable) {
    return {
      mode: "unsupported",
      promptTitle: "Возврат недоступен",
      promptText: "",
      actions: [],
      unsupportedReason: "Для этой записи Viva предлагает возврат только в виде услуги. Этот сценарий пока не поддержан в ЛК. Обратитесь в поддержку.",
    };
  }

  return {
    mode: "unsupported",
    promptTitle: "Возврат недоступен",
    promptText: "",
    actions: [],
    unsupportedReason: "Для этой записи нет поддержанного сценария возврата в ЛК. Обратитесь в поддержку.",
  };
}

export function findBookingCancellationActionByRefundMethod(
  plan: BookingCancellationPlan,
  refundMethod: BookingCancellationRefundMethod | null | undefined,
): BookingCancellationAction | null {
  if (!refundMethod) return null;
  return plan.actions.find((action) => action.refundMethod === refundMethod) ?? null;
}

export function pickAutomaticBookingCancellationAction(
  plan: BookingCancellationPlan,
  preferredRefundMethod?: BookingCancellationRefundMethod | null,
): BookingCancellationAction | null {
  const preferred = findBookingCancellationActionByRefundMethod(plan, preferredRefundMethod);
  if (preferred) return preferred;

  for (const actionId of AUTOMATIC_ACTION_PRIORITY) {
    const match = plan.actions.find((action) => action.id === actionId);
    if (match) return match;
  }

  return plan.actions[0] ?? null;
}

export function buildBookingCancellationPayload(
  action: BookingCancellationAction,
): Record<string, string | boolean> | null {
  return buildBookingCancellationPayloadForRefundMethod(action.refundMethod);
}

export function buildBookingCancellationPayloadForRefundMethod(
  refundMethod: BookingCancellationRefundMethod | null | undefined,
): Record<string, string | boolean> | null {
  if (!refundMethod) return null;
  if (refundMethod === "SERVICE" || refundMethod === "NONE") return {};
  return { refundMethod };
}
