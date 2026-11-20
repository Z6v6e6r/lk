/**
 * Order status of the opened group training after refresh, payment return or lost network (lk#459).
 *
 * Pure model, no I/O. The status comes from the server read of the player's own booking
 * (`apiFetchTournamentVivaMyRegistration`). The `groupPaymentSuccess/Failed` URL flag is only a
 * hint the payment page put into the return address: it never shows "paid" by itself.
 *
 * Duplicate-payment guard: a new payment may start only when the server read succeeded, found
 * no booking, and the player did not just come back from a successful payment page. Any other
 * state offers only an explicit re-check (or the provider's own pending payment link, on click).
 */
import type { TournamentRegistrationState } from "./tournamentSignupApi";

export type GroupSchedulePaymentReturnHint = "success" | "failed" | null;

export type GroupScheduleOrderStatusKind =
  | "LOADING"
  | "UNKNOWN"
  | "PAID"
  | "WAITLIST"
  | "PAYMENT_PENDING"
  | "PROCESSING"
  | "PAYMENT_FAILED"
  | "NONE";

export interface GroupScheduleOrderStatus {
  kind: GroupScheduleOrderStatusKind;
  /** Ordinary purchase options may be shown and may start a new payment. */
  allowNewPayment: boolean;
  /** The player may re-read the status from the server. */
  allowRecheck: boolean;
  message: string | null;
}

export type GroupScheduleRegistrationRead =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ok"; registration: Pick<TournamentRegistrationState, "status"> };

export function resolveGroupScheduleOrderStatus(params: {
  read: GroupScheduleRegistrationRead;
  returnHint: GroupSchedulePaymentReturnHint;
}): GroupScheduleOrderStatus {
  const { read, returnHint } = params;
  if (read.state === "loading") {
    return { kind: "LOADING", allowNewPayment: false, allowRecheck: false, message: "Проверяем статус записи…" };
  }
  if (read.state === "failed") {
    return {
      kind: "UNKNOWN",
      allowNewPayment: false,
      allowRecheck: true,
      message: "Статус заказа неизвестен. Не оплачивайте повторно — проверьте статус ещё раз.",
    };
  }
  switch (read.registration.status) {
    case "REGISTERED":
      return { kind: "PAID", allowNewPayment: false, allowRecheck: false, message: null };
    case "WAITLIST":
      return { kind: "WAITLIST", allowNewPayment: false, allowRecheck: false, message: null };
    case "PAYMENT_PENDING":
      return { kind: "PAYMENT_PENDING", allowNewPayment: false, allowRecheck: true, message: "Ожидает оплаты" };
    case "NONE":
      if (returnHint === "success") {
        return {
          kind: "PROCESSING",
          allowNewPayment: false,
          allowRecheck: true,
          message: "Оплата обрабатывается. Запись появится после подтверждения Viva — повторно оплачивать не нужно.",
        };
      }
      if (returnHint === "failed") {
        return { kind: "PAYMENT_FAILED", allowNewPayment: true, allowRecheck: true, message: "Оплата не завершена, записи нет. Можно попробовать снова." };
      }
      return { kind: "NONE", allowNewPayment: true, allowRecheck: false, message: null };
    default:
      return {
        kind: "UNKNOWN",
        allowNewPayment: false,
        allowRecheck: true,
        message: "Статус заказа неизвестен. Не оплачивайте повторно — проверьте статус ещё раз.",
      };
  }
}
