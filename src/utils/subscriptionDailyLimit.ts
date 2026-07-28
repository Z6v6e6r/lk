import type { ApiError, Booking } from "./apiClient";

export const SUBSCRIPTION_DAILY_LIMIT_CODE = "SUBSCRIPTION_DAILY_LIMIT_REACHED";
const ENERGY5_DIRECT_PRODUCT_ID = "dfa72adf-233b-4285-8d69-e5eab4234fbe";

export interface SubscriptionDailyLimitEvent {
  bookingId: string | null;
  exerciseId: string | null;
  clientSubscriptionId: string | null;
  title: string | null;
  date: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  timeLabel: string | null;
  studioName: string | null;
  roomName: string | null;
}

export interface SubscriptionDailyLimitConflict {
  code: typeof SUBSCRIPTION_DAILY_LIMIT_CODE;
  message: string;
  existingEvent: SubscriptionDailyLimitEvent;
}

type UnknownRecord = Record<string, unknown>;

const CANCELLED_STATUSES = new Set([
  "ARCHIVED",
  "CANCEL",
  "CANCELLED",
  "CANCELED",
  "DELETED",
  "EXPIRED",
  "PLAYER_LEFT",
  "REFUNDED",
]);

const isRecord = (value: unknown): value is UnknownRecord => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const toStr = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const normalizeComparableId = (value: unknown): string | null => {
  const text = toStr(value);
  return text ? text.toLowerCase() : null;
};

const normalizeEnergy5Text = (value: unknown): string => (
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/g, "")
);

const collectEnergy5Markers = (value: unknown, seen = new Set<unknown>()): string[] => {
  if (value === null || value === undefined || seen.has(value)) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (!isRecord(value) && !Array.isArray(value)) return [];

  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectEnergy5Markers(item, seen));
  }

  const keys = [
    "id",
    "uuid",
    "productId",
    "subscriptionId",
    "clientSubscriptionId",
    "counterKey",
    "name",
    "title",
    "label",
    "productName",
    "subscriptionName",
  ];
  const result = keys.flatMap((key) => collectEnergy5Markers(value[key], seen));
  ["raw", "subscription", "clientSubscription", "clientSub", "product"].forEach((key) => {
    result.push(...collectEnergy5Markers(value[key], seen));
  });
  return result;
};

export function isUnlimitedEnergy5SubscriptionProduct(value: unknown): boolean {
  const directEnergy5ProductId = normalizeComparableId(ENERGY5_DIRECT_PRODUCT_ID);
  return collectEnergy5Markers(value).some((marker) => {
    const comparable = normalizeComparableId(marker);
    if (directEnergy5ProductId && comparable === directEnergy5ProductId) return true;

    const normalized = normalizeEnergy5Text(marker);
    return (
      normalized === "energy5"
      || normalized === "энергия5"
      || normalized.includes("energy5")
      || normalized.includes("энергия5")
    );
  });
}

export function normalizeSubscriptionDailyLimitDate(value: unknown): string | null {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
}

const pickRecord = (value: UnknownRecord, keys: string[]): UnknownRecord | null => {
  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) return candidate;
  }
  return null;
};

const pickString = (value: UnknownRecord | null | undefined, keys: string[]): string | null => {
  if (!value) return null;
  for (const key of keys) {
    const text = toStr(value[key]);
    if (text) return text;
  }
  return null;
};

const formatTime = (value: unknown): string | null => {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/T?(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!matched) return null;
  return `${matched[1].padStart(2, "0")}:${matched[2]}`;
};

const buildTimeLabel = (timeFrom: string | null, timeTo: string | null): string | null => {
  if (timeFrom && timeTo) return `${timeFrom}-${timeTo}`;
  return timeFrom || timeTo;
};

const formatDateRu = (date: string | null): string | null => {
  const matched = toStr(date)?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return matched ? `${matched[3]}.${matched[2]}.${matched[1]}` : null;
};

const firstEventDate = (value: UnknownRecord | null): string | null => {
  if (!value) return null;
  const direct = pickString(value, [
    "date",
    "bookingDate",
    "serviceDate",
    "visitDate",
    "startsAt",
    "startAt",
    "timeFrom",
    "fromTime",
  ]);
  const directDate = normalizeSubscriptionDailyLimitDate(direct);
  if (directDate) return directDate;

  const exercise = pickRecord(value, ["exercise", "event", "tournament"]);
  return firstEventDate(exercise);
};

export function resolveSubscriptionDailyLimitDateFromEvent(value: unknown): string | null {
  return isRecord(value) ? firstEventDate(value) : normalizeSubscriptionDailyLimitDate(value);
}

const getBookingExercise = (booking: UnknownRecord): UnknownRecord | null => (
  pickRecord(booking, ["exercise", "event", "tournament"])
);

const getBookingId = (booking: UnknownRecord): string | null => (
  pickString(booking, ["id", "uuid", "bookingId"])
);

const getExerciseId = (booking: UnknownRecord, exercise: UnknownRecord | null): string | null => (
  pickString(exercise, ["id", "uuid", "exerciseId"])
  || pickString(booking, ["exerciseId", "vivaExerciseId", "eventId"])
);

const getClientSubscriptionId = (booking: UnknownRecord): string | null => {
  const subscription = pickRecord(booking, ["subscription", "clientSubscription", "clientSub"]);
  return (
    pickString(booking, ["clientSubscriptionId", "subscriptionId", "clientSubId"])
    || pickString(subscription, ["id", "uuid", "subscriptionId", "clientSubscriptionId"])
  );
};

const getStatusValues = (booking: UnknownRecord, exercise: UnknownRecord | null): string[] => [
  booking.status,
  booking.state,
  booking.cancellationReason,
  exercise?.status,
  exercise?.state,
].map((value) => String(value || "").trim().toUpperCase()).filter(Boolean);

const isBookingActive = (booking: UnknownRecord, exercise: UnknownRecord | null): boolean => {
  if (
    booking.isCancelled === true
    || booking.cancelled === true
    || booking.canceled === true
    || booking.archived === true
    || exercise?.isCancelled === true
    || exercise?.cancelled === true
    || exercise?.canceled === true
    || exercise?.archived === true
  ) {
    return false;
  }
  return !getStatusValues(booking, exercise).some((status) => CANCELLED_STATUSES.has(status));
};

const isSubscriptionBooking = (booking: UnknownRecord): boolean => {
  const paymentType = String(booking.paymentType || booking.paymentMethod || "").trim().toUpperCase();
  if (paymentType === "SUBSCRIPTION") return true;
  return Boolean(
    toStr(booking.clientSubscriptionId)
    || toStr(booking.subscriptionId)
    || toStr(booking.clientSubId)
    || toStr(booking.subscription),
  );
};

const normalizeEvent = (booking: UnknownRecord): SubscriptionDailyLimitEvent => {
  const exercise = getBookingExercise(booking);
  const studio = pickRecord(exercise || {}, ["studio"]) || pickRecord(booking, ["studio"]);
  const room = pickRecord(exercise || {}, ["room"]) || pickRecord(booking, ["room"]);
  const type = pickRecord(exercise || {}, ["type"]);
  const direction = pickRecord(exercise || {}, ["direction"]);
  const timeFrom = formatTime(
    pickString(exercise, ["timeFrom", "startsAt", "startAt"])
    || pickString(booking, ["timeFrom", "fromTime", "startsAt", "startAt"]),
  );
  const timeTo = formatTime(
    pickString(exercise, ["timeTo", "endsAt", "endAt"])
    || pickString(booking, ["timeTo", "toTime", "endsAt", "endAt"]),
  );

  return {
    bookingId: getBookingId(booking),
    exerciseId: getExerciseId(booking, exercise),
    clientSubscriptionId: getClientSubscriptionId(booking),
    title:
      pickString(type, ["name", "title"])
      || pickString(direction, ["name", "title"])
      || pickString(exercise, ["name", "title"])
      || pickString(booking, ["serviceName", "title", "name"]),
    date: firstEventDate(booking),
    timeFrom,
    timeTo,
    timeLabel: buildTimeLabel(timeFrom, timeTo),
    studioName:
      pickString(studio, ["name", "title"])
      || pickString(exercise, ["studioName"])
      || pickString(booking, ["studioName", "stationName"]),
    roomName:
      pickString(room, ["name", "title"])
      || pickString(exercise, ["roomName"])
      || pickString(booking, ["roomName"]),
  };
};

export function formatSubscriptionDailyLimitMessage(
  existingEvent: Partial<SubscriptionDailyLimitEvent> | null | undefined,
): string {
  const eventTitle = toStr(existingEvent?.title) || "событие";
  const studioName = toStr(existingEvent?.studioName);
  const timeLabel = toStr(existingEvent?.timeLabel)
    || buildTimeLabel(formatTime(existingEvent?.timeFrom), formatTime(existingEvent?.timeTo));
  const locationPart = studioName ? ` на станции ${studioName}` : "";
  const timePart = timeLabel ? ` в ${timeLabel}` : "";
  return `Вы уже записаны на ${eventTitle}${locationPart}${timePart}. Подписка позволяет создавать или присоединяться к событию 1 раз в день. Создайте игру или присоединитесь к тренировке на завтра.`;
}

export function resolveSubscriptionDailyLimitConflictFromBookings(
  bookings: Booking[] | unknown[] | null | undefined,
  options: {
    targetDate: string | null | undefined;
    currentClientSubscriptionId?: string | null;
    currentExerciseId?: string | null;
    currentBookingId?: string | null;
  },
): SubscriptionDailyLimitConflict | null {
  const targetDate = normalizeSubscriptionDailyLimitDate(options.targetDate);
  if (!targetDate || !Array.isArray(bookings)) return null;
  const currentClientSubscriptionId = normalizeComparableId(options.currentClientSubscriptionId);
  const currentExerciseId = normalizeComparableId(options.currentExerciseId);
  const currentBookingId = normalizeComparableId(options.currentBookingId);

  for (const item of bookings) {
    if (!isRecord(item)) continue;
    const exercise = getBookingExercise(item);
    if (!isBookingActive(item, exercise) || !isSubscriptionBooking(item)) continue;
    if (isUnlimitedEnergy5SubscriptionProduct(item)) continue;
    const bookingDate = firstEventDate(item);
    if (bookingDate !== targetDate) continue;

    const bookingId = normalizeComparableId(getBookingId(item));
    const exerciseId = normalizeComparableId(getExerciseId(item, exercise));
    const bookingClientSubscriptionId = normalizeComparableId(getClientSubscriptionId(item));
    if (currentBookingId && bookingId === currentBookingId) continue;
    if (currentExerciseId && exerciseId === currentExerciseId) continue;
    if (
      currentClientSubscriptionId
      && bookingClientSubscriptionId
      && bookingClientSubscriptionId !== currentClientSubscriptionId
    ) {
      continue;
    }

    const existingEvent = normalizeEvent(item);
    return {
      code: SUBSCRIPTION_DAILY_LIMIT_CODE,
      existingEvent,
      message: formatSubscriptionDailyLimitMessage(existingEvent),
    };
  }

  return null;
}

const candidateStrings = (value: unknown, seen = new Set<unknown>()): string[] => {
  const text = toStr(value);
  if (!text || seen.has(value)) return text ? [text] : [];
  if (!isRecord(value) && !Array.isArray(value)) return [text];
  seen.add(value);

  const result = [text];
  if (Array.isArray(value)) {
    value.forEach((item) => result.push(...candidateStrings(item, seen)));
    return result;
  }

  ["code", "error", "message", "details", "raw", "existingEvent"].forEach((key) => {
    result.push(...candidateStrings(value[key], seen));
  });
  return result;
};

const findDailyLimitPayload = (value: unknown): UnknownRecord | null => {
  if (!isRecord(value)) return null;
  const code = toStr(value.code);
  if (code === SUBSCRIPTION_DAILY_LIMIT_CODE) return value;
  const details = isRecord(value.details) ? findDailyLimitPayload(value.details) : null;
  if (details) return details;
  const raw = isRecord(value.raw) ? findDailyLimitPayload(value.raw) : null;
  if (raw) return raw;
  return null;
};

export function isSubscriptionDailyLimitError(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  if (findDailyLimitPayload(error.raw)) return true;
  return candidateStrings(error).some((text) => (
    text === SUBSCRIPTION_DAILY_LIMIT_CODE
    || /1\s*раз\s*в\s*день/i.test(text)
    || /одн[ао]\s+.*в\s+день/i.test(text)
    || /daily.+subscription.+limit/i.test(text)
  ));
}

export function resolveSubscriptionDailyLimitErrorMessage(
  error: ApiError | null | undefined,
): string | null {
  if (!error || !isSubscriptionDailyLimitError(error)) return null;
  const payload = findDailyLimitPayload(error.raw);
  const existingEvent = isRecord(payload?.existingEvent)
    ? payload.existingEvent as Partial<SubscriptionDailyLimitEvent>
    : null;
  const payloadMessage = toStr(payload?.message);
  if (payloadMessage) return payloadMessage;
  if (existingEvent) return formatSubscriptionDailyLimitMessage(existingEvent);
  return toStr(error.message) || formatSubscriptionDailyLimitMessage(existingEvent);
}

export function buildSubscriptionDailyLimitApiError(
  conflict: SubscriptionDailyLimitConflict,
  status = 409,
): ApiError {
  return {
    status,
    message: conflict.message,
    raw: {
      code: conflict.code,
      message: conflict.message,
      existingEvent: conflict.existingEvent,
    },
  };
}

export function formatSubscriptionDailyLimitConflictSummary(conflict: SubscriptionDailyLimitConflict): string {
  const dateLabel = formatDateRu(conflict.existingEvent.date);
  return [
    conflict.existingEvent.title,
    conflict.existingEvent.studioName,
    conflict.existingEvent.timeLabel,
    dateLabel,
  ].filter(Boolean).join(" / ");
}
