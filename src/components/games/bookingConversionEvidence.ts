type Row = Record<string, unknown>;

export const BOOKING_CONVERSION_UNVERIFIED =
  "Не удалось проверить бронь и состав игры. Обновите записи и повторите попытку.";
export const BOOKING_CONVERSION_SUBSCRIPTION =
  "Эту бронь нельзя опубликовать как обычную игру: она связана с подпиской. Обратитесь в поддержку для восстановления игры по подписке. Новую бронь создавать не нужно.";

const row = (value: unknown): Row | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const id = (value: unknown): string | null => text(row(value)?.id);
const tokens = (booking: Row): string[] => [
  booking.paymentType, booking.detailedPaymentType, booking.bookingPaymentType,
].map((value) => text(value)?.toUpperCase()).filter((value): value is string => Boolean(value));

function hasSubscription(booking: Row): boolean {
  return [booking.clientSubscriptionId, booking.subscriptionId, booking.clientSubscription, booking.subscription]
    .some((value) => value !== null && value !== undefined && value !== "")
    || tokens(booking).some((value) => /SUBSCRIPTION|ABON/.test(value));
}

function cancellation(booking: Row): "active" | "cancelled" | "unknown" {
  const flags = [booking.isCancelled, booking.cancelled, booking.canceled];
  if (flags.some((value) => value !== undefined && value !== null && typeof value !== "boolean")) return "unknown";
  const cancelled = flags.some((value) => value === true)
    || [booking.status, booking.state, booking.bookingStatus].some((value) => /^(CANCELLED|CANCELED)$/i.test(text(value) ?? ""))
    || Boolean(booking.cancelledAt || booking.cancellationDate);
  if (cancelled && flags.some((value) => value === false)) return "unknown";
  if (cancelled) return "cancelled";
  return flags.some((value) => value === false) ? "active" : "unknown";
}

function completeRows(value: unknown): Row[] | null {
  const wrapper = row(value);
  const rows = Array.isArray(value) ? value : wrapper?.content;
  if (!Array.isArray(rows) || rows.some((value) => !row(value))) return null;
  if (wrapper && (
    !Number.isInteger(wrapper.totalElements) || wrapper.totalElements !== rows.length
    || wrapper.last === false
    || (wrapper.totalPages !== undefined && wrapper.totalPages !== 0 && wrapper.totalPages !== 1)
    || (row(wrapper.pageable)?.pageNumber !== undefined && row(wrapper.pageable)?.pageNumber !== 0)
  )) return null;
  return rows as Row[];
}

function identityMatches(booking: Row, actorId: string, exerciseId: string): boolean {
  // Self-bookings legitimately omit owner aliases; reject conflicting echoes.
  if ([booking.client, booking.exercise].some((value) => value !== null && value !== undefined && !id(value))) return false;
  return [id(booking.client), booking.clientId, booking.userId]
    .every((value) => value === null || value === undefined || text(value) === actorId)
    && [id(booking.exercise), booking.exerciseId, booking.vivaExerciseId]
      .every((value) => value === null || value === undefined || value === exerciseId);
}

function nonSubscriptionPayment(booking: Row): string | null {
  if (!paymentAliasesValid(booking)) return null;
  const values = tokens(booking);
  if (values.length === 0 || new Set(values).size !== 1) return null;
  return ["ONE_TIME", "ON_PLACE", "DEPOSIT"].includes(values[0]) ? values[0] : null;
}

function paymentAliasesValid(booking: Row): boolean {
  return [booking.paymentType, booking.detailedPaymentType, booking.bookingPaymentType]
    .every((value) => value === null || value === undefined || text(value) !== null);
}

export type BookingConversionEvidence =
  | { allowed: false; message: string }
  | { allowed: true; booking: Row; roster: Row[] };

/** Only fresh authenticated self-bookings and direct Viva exercise bookings belong here. */
export function evaluateBookingConversionEvidence(input: {
  actorId: string;
  bookingId: string;
  exerciseId: string;
  studioId: string;
  roomId: string;
  timeFromIso: string;
  timeToIso: string;
  selfBookings: unknown;
  exerciseBookings: unknown;
}): BookingConversionEvidence {
  const blocked: BookingConversionEvidence = { allowed: false, message: BOOKING_CONVERSION_UNVERIFIED };
  const self = completeRows(input.selfBookings);
  const roster = completeRows(input.exerciseBookings);
  if (!input.actorId || !input.bookingId || !input.exerciseId || !self || !roster) return blocked;
  const own = self.filter((value) => text(value.id) === input.bookingId);
  const joined = roster.filter((value) => text(value.id) === input.bookingId);
  if (own.length !== 1 || joined.length !== 1) return blocked;
  const booking = own[0];
  const exercise = row(booking.exercise);
  if (!exercise || id(booking.exercise) !== input.exerciseId
    || id(exercise.studio) !== input.studioId || id(exercise.room) !== input.roomId
    || !Number.isFinite(Date.parse(input.timeFromIso)) || !Number.isFinite(Date.parse(input.timeToIso))
    || Date.parse(String(exercise.timeFrom)) !== Date.parse(input.timeFromIso)
    || Date.parse(String(exercise.timeTo)) !== Date.parse(input.timeToIso)
    || Date.parse(input.timeToIso) <= Date.parse(input.timeFromIso)
    || cancellation(booking) !== "active" || cancellation(joined[0]) !== "active"
    || [exercise.isCancelled, exercise.cancelled, exercise.canceled].some((value) => value !== undefined && value !== null && value !== false)
    || Boolean(exercise.cancelledAt || exercise.cancellationDate || exercise.archived)
    || [exercise.status, exercise.state].some((value) => /^(CANCELLED|CANCELED)$/i.test(text(value) ?? ""))
    || !identityMatches(booking, input.actorId, input.exerciseId)
    || !identityMatches(joined[0], input.actorId, input.exerciseId)) return blocked;

  const active: Row[] = [];
  const seen = new Set<string>();
  for (const entry of roster) {
    const bookingId = text(entry.id);
    if (!bookingId || seen.has(bookingId) || cancellation(entry) === "unknown") return blocked;
    seen.add(bookingId);
    if (cancellation(entry) === "active") active.push(entry);
  }
  if ([booking, ...active].some(hasSubscription)) {
    return { allowed: false, message: BOOKING_CONVERSION_SUBSCRIPTION };
  }
  const ownPayment = nonSubscriptionPayment(booking);
  if (!ownPayment || active.some((entry) => {
    // The self endpoint can supply payment type when the exact roster row omits it.
    const payment = paymentAliasesValid(entry) && tokens(entry).length === 0 && entry === joined[0]
      ? ownPayment : nonSubscriptionPayment(entry);
    return !payment || (entry === joined[0] && payment !== ownPayment);
  })) return blocked;
  return { allowed: true, booking, roster: active };
}
