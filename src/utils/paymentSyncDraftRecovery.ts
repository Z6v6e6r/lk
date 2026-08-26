import type {
  PadelGameRecord,
  PadelGameRecordPayload,
} from "./apiClient";

export interface RecoveredPendingPaidGameDraft {
  paymentRef: string;
  payload: PadelGameRecordPayload;
  bookingIds: string[];
  createdAt: string;
  updatedAt: string;
}

function toStringSafe(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function parseStringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return Array.from(new Set(values
    .map((item) => toStringSafe(item))
    .filter((item): item is string => Boolean(item))));
}

function getExistingBookingIdsFromRecord(record: PadelGameRecord): string[] {
  const metadata = record.metadata && typeof record.metadata === "object"
    ? record.metadata
    : {};
  return Array.from(new Set([
    ...parseStringList(metadata.bookingIds),
    ...parseStringList(record.booking?.bookingIds),
    ...parseStringList(record.booking?.bookingId),
  ]));
}

export function resolvePaymentSyncExpectedGameId(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = toStringSafe(value);
    if (normalized) return normalized;
  }
  return null;
}

export function isConfirmedPaymentReadbackBound(
  record: PadelGameRecord,
  expected: { paymentRef: string; gameId: string; bookingIds: string[] },
): boolean {
  const metadata = record.metadata && typeof record.metadata === "object"
    ? record.metadata as Record<string, unknown>
    : {};
  const splitPayment = metadata.splitPayment && typeof metadata.splitPayment === "object"
    ? metadata.splitPayment as Record<string, unknown>
    : {};
  const payments = Array.isArray(splitPayment.payments)
    ? splitPayment.payments as Array<Record<string, unknown>>
    : [];
  const payment = record.payment && typeof record.payment === "object"
    ? record.payment as Record<string, unknown>
    : {};
  const paymentRefs = parseStringList([
    metadata.paymentRef,
    splitPayment.paymentRef,
    payment.paymentRef,
    ...payments.map((item) => item?.paymentRef),
  ]);
  const recordBookingIds = parseStringList([
    record.booking?.bookingId,
    ...(record.booking?.bookingIds ?? []),
    ...parseStringList(metadata.bookingIds),
    ...parseStringList(payment.bookingIds),
    ...payments.flatMap((item) => parseStringList(item?.bookingId ?? item?.bookingIds)),
  ]);
  const expectedBookingIds = parseStringList(expected.bookingIds);
  return (
    record.id === expected.gameId
    && paymentRefs.includes(expected.paymentRef)
    && expectedBookingIds.length > 0
    && expectedBookingIds.every((bookingId) => recordBookingIds.includes(bookingId))
  );
}

export function isPersistedGamePaymentTerminal(record: PadelGameRecord): boolean {
  const status = toStringSafe(record.status)?.toUpperCase() ?? "";
  if (["CANCELLED", "CANCELED", "FAILED", "EXPIRED", "REJECTED"].includes(status)) return false;
  if (record.payment?.paid === true) return true;
  return status === "PAID" || status === "PAYED";
}

export function isPersistedGamePaymentFailedTerminal(record: PadelGameRecord): boolean {
  const status = toStringSafe(record.status)?.toUpperCase() ?? "";
  return ["CANCELLED", "CANCELED", "FAILED", "EXPIRED", "REJECTED"].includes(status);
}

export function buildPendingPaidGameDraftFromRecord(
  record: PadelGameRecord,
  paymentRefRaw: string,
): RecoveredPendingPaidGameDraft | null {
  const paymentRef = paymentRefRaw.trim();
  const organizer = record.organizer;
  const booking = record.booking;
  const studioId = toStringSafe(booking?.studioId);
  const roomId = toStringSafe(booking?.roomId);
  const date = toStringSafe(booking?.date);
  const timeFrom = toStringSafe(booking?.timeFrom);
  const timeTo = toStringSafe(booking?.timeTo);
  const durationMinutes = booking?.durationMinutes;
  if (
    !record.id
    || !paymentRef
    || !organizer
    || !studioId
    || !roomId
    || !date
    || !timeFrom
    || !timeTo
    || !Number.isFinite(durationMinutes)
  ) {
    return null;
  }

  const metadata = record.metadata && typeof record.metadata === "object"
    ? record.metadata
    : {};
  const bookingIds = getExistingBookingIdsFromRecord(record);
  const exerciseId = toStringSafe(booking?.exerciseId ?? booking?.vivaExerciseId);
  const nowIso = new Date().toISOString();

  return {
    paymentRef,
    bookingIds,
    createdAt: toStringSafe(record.createdAt) ?? nowIso,
    updatedAt: toStringSafe(record.updatedAt) ?? nowIso,
    payload: {
      gameId: record.id,
      paymentRef,
      status: "PAYMENT_PENDING",
      organizer: {
        id: organizer.id ?? null,
        name: organizer.name ?? null,
        phone: organizer.phone ?? null,
        photo: organizer.photo ?? null,
        rating: organizer.rating ?? null,
        ratingNumeric: organizer.ratingNumeric ?? null,
      },
      booking: {
        studioId,
        studioName: booking?.studioName ?? "",
        masterServiceId: booking?.masterServiceId ?? null,
        subServiceIds: booking?.subServiceIds ?? [],
        roomId,
        roomName: booking?.roomName ?? "",
        date,
        timeFrom,
        timeTo,
        timeFromIso: `${date}T${timeFrom}:00+03:00`,
        timeToIso: `${date}T${timeTo}:00+03:00`,
        durationMinutes: durationMinutes as number,
        slotId: null,
        bookingIds,
        exerciseId,
        vivaExerciseId: exerciseId,
      },
      payment: {
        amount: record.payment?.amount ?? null,
        paymentUrl: record.payment?.paymentUrl ?? null,
        paymentMethod: "WIDGET",
        paid: false,
        paymentRef,
        bookingIds,
      },
      settings: {
        ratingGame: record.settings?.ratingGame ?? false,
        minRating: record.settings?.minRating ?? null,
        maxRating: record.settings?.maxRating ?? null,
        isPrivate: record.settings?.isPrivate ?? false,
        payMode: record.settings?.payMode === "self" ? "self" : "split",
      },
      invite: {
        inviteUrl: record.inviteUrl,
        waitlistEnabled: record.invite?.waitlistEnabled ?? true,
        maxPlayers: record.invite?.maxPlayers ?? undefined,
      },
      participants: record.participants ?? [],
      waitlist: record.waitlist ?? [],
      metadata: {
        ...metadata,
        paymentRef,
        bookingIds,
        ...(exerciseId ? { exerciseId, vivaExerciseId: exerciseId } : {}),
      },
    },
  };
}
