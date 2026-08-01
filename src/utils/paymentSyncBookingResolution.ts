export interface PaymentSyncBookingLike {
  id?: unknown;
  isCancelled?: unknown;
  cancelled?: unknown;
  canceled?: unknown;
  cancellationDate?: unknown;
  cancelledAt?: unknown;
  bookingStatus?: unknown;
  status?: unknown;
  exerciseId?: unknown;
  exercise_id?: unknown;
  vivaExerciseId?: unknown;
  viva_exercise_id?: unknown;
  exercise?: object | null;
}

export type PaymentSyncBookingResolutionCode =
  | "BOOKING_IDS_MISSING"
  | "BOOKING_NOT_FOUND"
  | "BOOKING_CANCELLED"
  | "EXERCISE_ID_MISSING"
  | "EXERCISE_ID_MISMATCH";

export type PaymentSyncBookingResolution =
  | {
    ok: true;
    exerciseId: string;
    bookingIds: string[];
  }
  | {
    ok: false;
    code: PaymentSyncBookingResolutionCode;
    message: string;
    bookingIds: string[];
    exerciseIds: string[];
  };

export interface PaymentSyncGamePayloadLike {
  booking?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export const GAME_EXERCISE_ID_MISSING_CODE = "GAME_EXERCISE_ID_MISSING";

interface BookingFetchResult {
  data: { content: PaymentSyncBookingLike[] } | null;
  error: { status: number | null; message: string } | null;
  status: number | null;
}

export type PaymentSyncBookingFetcher = (
  includeCanceled: boolean,
  options: { size: number },
) => Promise<BookingFetchResult>;

export type GameExerciseIdRecoveryResult =
  | {
    ok: true;
    exerciseId: string;
    bookingIds: string[];
    source: "payload" | "viva_bookings";
  }
  | {
    ok: false;
    code: PaymentSyncBookingResolutionCode | "BOOKING_LOOKUP_FAILED";
    message: string;
    status: number | null;
  };

function toStringSafe(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function unique(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function normalizeBookingIds(values: string[]): string[] {
  return unique(values.map(toStringSafe));
}

function readMachineCode(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const direct = toStringSafe(record.code);
  if (direct) return direct.toUpperCase();
  return readMachineCode(record.error) || readMachineCode(record.data);
}

export function isGameExerciseIdMissingGuard(
  status: unknown,
  raw: unknown,
): boolean {
  return Number(status) === 409 && readMachineCode(raw) === GAME_EXERCISE_ID_MISSING_CODE;
}

export function collectPaymentSyncBookingExerciseIds(
  booking: PaymentSyncBookingLike,
): string[] {
  const exercise = booking.exercise && typeof booking.exercise === "object"
    ? booking.exercise as Record<string, unknown>
    : {};
  return unique([
    toStringSafe(booking.exerciseId),
    toStringSafe(booking.exercise_id),
    toStringSafe(booking.vivaExerciseId),
    toStringSafe(booking.viva_exercise_id),
    toStringSafe(exercise.id),
    toStringSafe(exercise.exerciseId),
    toStringSafe(exercise.exercise_id),
    toStringSafe(exercise.vivaExerciseId),
    toStringSafe(exercise.viva_exercise_id),
  ]);
}

export function collectPaymentSyncPayloadExerciseIds(
  payload: PaymentSyncGamePayloadLike,
): string[] {
  const booking = payload.booking && typeof payload.booking === "object" ? payload.booking : {};
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const splitPayment = metadata.splitPayment && typeof metadata.splitPayment === "object"
    ? metadata.splitPayment as Record<string, unknown>
    : {};
  return unique([
    toStringSafe(booking.exerciseId),
    toStringSafe(booking.vivaExerciseId),
    toStringSafe(metadata.exerciseId),
    toStringSafe(metadata.vivaExerciseId),
    toStringSafe(splitPayment.exerciseId),
    toStringSafe(splitPayment.vivaExerciseId),
  ]);
}

export function attachPaymentSyncExerciseId<T extends PaymentSyncGamePayloadLike>(
  payload: T,
  exerciseIdRaw: string,
): T {
  const exerciseId = toStringSafe(exerciseIdRaw);
  if (!exerciseId) return payload;
  const booking = payload.booking && typeof payload.booking === "object" ? payload.booking : {};
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  return {
    ...payload,
    booking: {
      ...booking,
      exerciseId,
      vivaExerciseId: exerciseId,
    },
    metadata: {
      ...metadata,
      exerciseId,
      vivaExerciseId: exerciseId,
    },
  };
}

export function isPaymentSyncBookingCancelled(booking: PaymentSyncBookingLike): boolean {
  if (booking.isCancelled === true || booking.cancelled === true || booking.canceled === true) {
    return true;
  }
  if (toStringSafe(booking.cancellationDate) || toStringSafe(booking.cancelledAt)) {
    return true;
  }

  const exercise = booking.exercise && typeof booking.exercise === "object"
    ? booking.exercise as Record<string, unknown>
    : {};
  if (
    exercise.isCancelled === true
    || exercise.cancelled === true
    || exercise.canceled === true
    || exercise.archived === true
  ) {
    return true;
  }

  const statuses = [
    booking.bookingStatus,
    booking.status,
    exercise.status,
    exercise.state,
  ]
    .map(toStringSafe)
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toUpperCase());
  return statuses.some((status) => (
    status.includes("CANCEL")
    || status.includes("DELETE")
    || status.includes("ARCHIVE")
    || status.includes("VOID")
  ));
}

export function resolvePaymentSyncExerciseIdFromBookings(
  bookingIdsRaw: string[],
  activeBookings: PaymentSyncBookingLike[],
  historyBookings: PaymentSyncBookingLike[],
): PaymentSyncBookingResolution {
  const bookingIds = normalizeBookingIds(bookingIdsRaw);
  if (bookingIds.length === 0) {
    return {
      ok: false,
      code: "BOOKING_IDS_MISSING",
      message: "Нельзя восстановить exerciseId: bookingIds отсутствуют",
      bookingIds,
      exerciseIds: [],
    };
  }

  const recordsByBookingId = new Map<string, PaymentSyncBookingLike[]>();
  [...activeBookings, ...historyBookings].forEach((booking) => {
    const bookingId = toStringSafe(booking.id);
    if (!bookingId || !bookingIds.includes(bookingId)) return;
    const bucket = recordsByBookingId.get(bookingId) ?? [];
    bucket.push(booking);
    recordsByBookingId.set(bookingId, bucket);
  });

  const missingBookingIds = bookingIds.filter((bookingId) => !recordsByBookingId.has(bookingId));
  if (missingBookingIds.length > 0) {
    return {
      ok: false,
      code: "BOOKING_NOT_FOUND",
      message: `Viva не вернула bookingIds: ${missingBookingIds.join(", ")}`,
      bookingIds,
      exerciseIds: [],
    };
  }

  const cancelledBookingIds = bookingIds.filter((bookingId) => (
    (recordsByBookingId.get(bookingId) ?? []).some(isPaymentSyncBookingCancelled)
  ));
  if (cancelledBookingIds.length > 0) {
    return {
      ok: false,
      code: "BOOKING_CANCELLED",
      message: `Нельзя подтвердить игру: бронь отменена (${cancelledBookingIds.join(", ")})`,
      bookingIds,
      exerciseIds: [],
    };
  }

  const exerciseIdsByBookingId = new Map<string, string[]>();
  bookingIds.forEach((bookingId) => {
    const ids = unique(
      (recordsByBookingId.get(bookingId) ?? [])
        .flatMap(collectPaymentSyncBookingExerciseIds),
    );
    exerciseIdsByBookingId.set(bookingId, ids);
  });

  const withoutExerciseId = bookingIds.filter(
    (bookingId) => (exerciseIdsByBookingId.get(bookingId) ?? []).length === 0,
  );
  if (withoutExerciseId.length > 0) {
    return {
      ok: false,
      code: "EXERCISE_ID_MISSING",
      message: `Viva booking не содержит exerciseId: ${withoutExerciseId.join(", ")}`,
      bookingIds,
      exerciseIds: [],
    };
  }

  const exerciseIds = unique(
    bookingIds.flatMap((bookingId) => exerciseIdsByBookingId.get(bookingId) ?? []),
  );
  const ambiguousBookingIds = bookingIds.filter(
    (bookingId) => (exerciseIdsByBookingId.get(bookingId) ?? []).length !== 1,
  );
  if (exerciseIds.length !== 1 || ambiguousBookingIds.length > 0) {
    return {
      ok: false,
      code: "EXERCISE_ID_MISMATCH",
      message: "bookingIds относятся к разным или неоднозначным Viva exercises",
      bookingIds,
      exerciseIds,
    };
  }

  return {
    ok: true,
    exerciseId: exerciseIds[0],
    bookingIds,
  };
}

export async function recoverGameExerciseIdWithFetcher(options: {
  exerciseIds?: Array<string | null | undefined>;
  bookingIds: string[];
  fetchBookings: PaymentSyncBookingFetcher;
}): Promise<GameExerciseIdRecoveryResult> {
  const exerciseIds = normalizeBookingIds(
    (options.exerciseIds ?? []).map((value) => String(value || "")),
  );
  const bookingIds = normalizeBookingIds(options.bookingIds);
  if (exerciseIds.length > 1) {
    return {
      ok: false,
      code: "EXERCISE_ID_MISMATCH",
      message: "Данные оплаты содержат неоднозначный Viva exerciseId",
      status: 409,
    };
  }
  if (exerciseIds.length === 1) {
    return {
      ok: true,
      exerciseId: exerciseIds[0],
      bookingIds,
      source: "payload",
    };
  }
  if (bookingIds.length === 0) {
    return {
      ok: false,
      code: "BOOKING_IDS_MISSING",
      message: "Viva не вернула bookingIds для восстановления exerciseId",
      status: 409,
    };
  }

  const [activeResult, historyResult] = await Promise.all([
    options.fetchBookings(false, { size: 1000 }),
    options.fetchBookings(true, { size: 1000 }),
  ]);
  const lookupError = activeResult.error || historyResult.error;
  if (lookupError) {
    return {
      ok: false,
      code: "BOOKING_LOOKUP_FAILED",
      message: lookupError.message || "Не удалось проверить Viva booking",
      status: lookupError.status ?? activeResult.status ?? historyResult.status,
    };
  }

  const resolution = resolvePaymentSyncExerciseIdFromBookings(
    bookingIds,
    activeResult.data?.content ?? [],
    historyResult.data?.content ?? [],
  );
  if (!resolution.ok) {
    return {
      ok: false,
      code: resolution.code,
      message: resolution.message,
      status: 409,
    };
  }
  return {
    ok: true,
    exerciseId: resolution.exerciseId,
    bookingIds: resolution.bookingIds,
    source: "viva_bookings",
  };
}
