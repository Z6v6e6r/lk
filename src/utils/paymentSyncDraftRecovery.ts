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

export function isPersistedGamePaymentTerminal(record: PadelGameRecord): boolean {
  if (record.payment?.paid === true) return true;
  const status = toStringSafe(record.status)?.toUpperCase() ?? "";
  return status === "PAID" || status === "PAYED" || status === "CANCELLED";
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
