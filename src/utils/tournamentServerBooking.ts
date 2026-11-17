/**
 * LK1 side of the CUP server-owned tournament booking (`POST /tournaments/:id/server-booking`).
 * Behind VITE_TOURNAMENT_SERVER_BOOKING_ENABLED (default off). LK1 never books in Viva itself for
 * these tournaments and never sends a level or a price; it renders the CUP result.
 */
import {
  normalizeTournamentLevelDecision,
  resolveTournamentLevelGate,
  describeTournamentLevelGate,
  type TournamentLevelGateState,
} from "./tournamentLevelDecision.ts";

export type TournamentServerBookingState =
  | "ADMITTED" | "BOOKING" | "BOOKING_UNKNOWN" | "BOOKED" | "PAYMENT_CREATING" | "PAYMENT_UNKNOWN"
  | "PAYMENT_PENDING" | "CONFIRMED" | "REJECTED" | "FAILED";

const STATES: readonly TournamentServerBookingState[] = [
  "ADMITTED", "BOOKING", "BOOKING_UNKNOWN", "BOOKED", "PAYMENT_CREATING", "PAYMENT_UNKNOWN",
  "PAYMENT_PENDING", "CONFIRMED", "REJECTED", "FAILED",
];

export interface TournamentServerBookingView {
  state: TournamentServerBookingState;
  bookingId: string | null;
  paymentUrl: string | null;
  toPayMinor: number | null;
  errorCode: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function normalizeTournamentServerBookingView(value: unknown): TournamentServerBookingView | null {
  if (!isRecord(value)) return null;
  const state = STATES.find((item) => item === value.state);
  if (!state) return null;
  const paymentUrl = text(value.paymentUrl);
  return {
    state,
    bookingId: text(value.bookingId),
    paymentUrl: paymentUrl && /^https:\/\//i.test(paymentUrl) ? paymentUrl : null,
    toPayMinor: typeof value.toPayMinor === "number" && Number.isFinite(value.toPayMinor) ? value.toPayMinor : null,
    errorCode: text(value.errorCode),
  };
}

/** Server booking replaces only the paid one-time path; subscription bookings keep their gateway. */
export function shouldUseTournamentServerBooking(input: {
  enabled: boolean;
  gate: TournamentLevelGateState;
  productSource: string;
}): boolean {
  return input.enabled
    && input.gate.kind === "ALLOWED"
    && (input.productSource === "one-time" || input.productSource === "client-one-time");
}

export function createTournamentServerBookingKey(random: () => string = () => crypto.randomUUID()): string {
  return `lk1-${random()}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
}

export type TournamentServerBookingOutcome =
  | { kind: "PAY"; bookingId: string | null; paymentUrl: string }
  | { kind: "CONFIRMED" }
  | { kind: "PROCESSING"; message: string }
  | { kind: "FAILED"; message: string; retryWithNewKey: boolean }
  | { kind: "REFUSED"; gate: TournamentLevelGateState; message: string };

const PROCESSING = "Запись обрабатывается. Обновите страницу через минуту — статус появится автоматически.";

/** Maps the CUP answer (or failure) to what the signup screen does next. */
export function resolveTournamentServerBookingOutcome(result: {
  data: unknown;
  status: number | null;
  error: { message?: string; raw?: unknown } | null;
}): TournamentServerBookingOutcome {
  if (result.error || !result.data) {
    const raw = isRecord(result.error?.raw) ? result.error!.raw as Record<string, unknown> : {};
    const decision = normalizeTournamentLevelDecision(raw.levelDecision);
    if (decision && !decision.allowed) {
      const gate = resolveTournamentLevelGate({ decision, requestFailed: false, notFound: false, levelRestrictedHint: true });
      return { kind: "REFUSED", gate, message: describeTournamentLevelGate(gate)?.statusLine ?? decision.message ?? "Запись недоступна." };
    }
    const code = text(raw.code);
    if (code === "SERVER_BOOKING_IN_PROGRESS") return { kind: "PROCESSING", message: PROCESSING };
    // Transport failure or 5xx: the attempt may exist; retry with the same key.
    return {
      kind: "FAILED",
      message: text(result.error?.message) ?? "Не удалось записаться. Попробуйте ещё раз.",
      retryWithNewKey: typeof result.status === "number" && result.status >= 400 && result.status < 500,
    };
  }
  const view = normalizeTournamentServerBookingView(result.data);
  if (!view) return { kind: "FAILED", message: "Не удалось прочитать ответ записи. Попробуйте ещё раз.", retryWithNewKey: false };
  if (view.state === "PAYMENT_PENDING" && view.paymentUrl) return { kind: "PAY", bookingId: view.bookingId, paymentUrl: view.paymentUrl };
  if (view.state === "CONFIRMED") return { kind: "CONFIRMED" };
  if (view.state === "REJECTED" || view.state === "FAILED") {
    return {
      kind: "FAILED",
      message: view.errorCode === "LEVEL_NOT_ALLOWED"
        ? "Ваш уровень больше не подходит для этого турнира."
        : "Не удалось записаться на турнир. Попробуйте ещё раз или обратитесь к организатору.",
      retryWithNewKey: true,
    };
  }
  return { kind: "PROCESSING", message: PROCESSING };
}
