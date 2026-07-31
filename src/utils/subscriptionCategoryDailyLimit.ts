import type { ApiError, Booking } from "./apiClient";
import {
  EXERCISE_CATEGORY_GROUP_TRAINING,
  EXERCISE_CATEGORY_GROUP_TRAINING_TYPE_IDS,
  EXERCISE_CATEGORY_OPEN_GAME,
  EXERCISE_CATEGORY_OPEN_GAME_DIRECTION_IDS,
  EXERCISE_CATEGORY_OPEN_GAME_TYPE_IDS,
  EXERCISE_CATEGORY_TOURNAMENT,
  EXERCISE_CATEGORY_TOURNAMENT_DIRECTION_IDS,
  EXERCISE_CATEGORY_TOURNAMENT_TYPE_IDS,
  resolveExerciseCategoryFromValue,
  type ExerciseCategory,
} from "./exerciseCategory.ts";

export const SUBSCRIPTION_CATEGORY_DAILY_LIMIT_CODE = "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED";
export const SUBSCRIPTION_CATEGORY_DAILY_LIMIT_SHARED_FROM = "2026-08-01";

export const SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS = {
  friendship: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
  sport: "82caad6f-4d19-4d01-852b-932bdbb0f405",
  academy: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
  ra: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
} as const;

export const SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME = EXERCISE_CATEGORY_OPEN_GAME;
export const SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING = EXERCISE_CATEGORY_GROUP_TRAINING;
export const SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT = EXERCISE_CATEGORY_TOURNAMENT;

export type SubscriptionCategoryDailyLimitCategory =
  | typeof EXERCISE_CATEGORY_OPEN_GAME
  | typeof EXERCISE_CATEGORY_GROUP_TRAINING
  | typeof EXERCISE_CATEGORY_TOURNAMENT;

export type SubscriptionCategoryDailyLimitPlanKey = keyof typeof SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS;

export const SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME_DIRECTION_IDS = EXERCISE_CATEGORY_OPEN_GAME_DIRECTION_IDS;
export const SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME_TYPE_IDS = EXERCISE_CATEGORY_OPEN_GAME_TYPE_IDS;
export const SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING_TYPE_IDS = EXERCISE_CATEGORY_GROUP_TRAINING_TYPE_IDS;
export const SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT_DIRECTION_IDS = EXERCISE_CATEGORY_TOURNAMENT_DIRECTION_IDS;
export const SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT_TYPE_IDS = EXERCISE_CATEGORY_TOURNAMENT_TYPE_IDS;

const CATEGORY_LABELS: Record<SubscriptionCategoryDailyLimitCategory, string> = {
  open_game: "Игра",
  group_training: "Групповая тренировка",
  tournament: "турнир",
};

const CATEGORY_TITLE_LABELS: Record<SubscriptionCategoryDailyLimitCategory, string> = {
  open_game: "Открытая игра",
  group_training: "Групповая тренировка",
  tournament: "Турнир",
};

const PLAN_CATEGORIES: Record<SubscriptionCategoryDailyLimitPlanKey, readonly SubscriptionCategoryDailyLimitCategory[]> = {
  friendship: [SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME],
  sport: [SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME, SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT],
  academy: [SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME, SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING],
  ra: [
    SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
    SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
    SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
  ],
};

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

type UnknownRecord = Record<string, unknown>;

export interface SubscriptionCategoryDailyLimitEvent {
  bookingId: string | null;
  exerciseId: string | null;
  clientSubscriptionId: string | null;
  category: SubscriptionCategoryDailyLimitCategory;
  title: string | null;
  date: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  timeLabel: string | null;
  studioName: string | null;
  roomName: string | null;
}

export interface SubscriptionCategoryDailyLimitConflict {
  code: typeof SUBSCRIPTION_CATEGORY_DAILY_LIMIT_CODE;
  message: string;
  category: SubscriptionCategoryDailyLimitCategory;
  planKey: SubscriptionCategoryDailyLimitPlanKey;
  existingEvent: SubscriptionCategoryDailyLimitEvent;
}

const isRecord = (value: unknown): value is UnknownRecord => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const toStr = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const normalizeMarker = (value: unknown): string => (
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/g, "")
);

export function withSubscriptionCategoryDailyLimitResolvedName(
  subscription: unknown,
  resolvedName: unknown,
): unknown {
  const name = toStr(resolvedName);
  if (!name || !isRecord(subscription)) return subscription;

  const product = isRecord(subscription.product) ? subscription.product : null;
  return {
    ...subscription,
    name: toStr(subscription.name) || name,
    title: toStr(subscription.title) || name,
    productName: toStr(subscription.productName) || name,
    subscriptionName: toStr(subscription.subscriptionName) || name,
    subscriptionProductName: toStr(subscription.subscriptionProductName) || name,
    product: {
      ...(product ?? {}),
      name: toStr(product?.name) || name,
      title: toStr(product?.title) || name,
    },
  };
}

const normalizeComparableId = (value: unknown): string | null => {
  const text = toStr(value);
  return text ? text.toLowerCase() : null;
};

const pickRecord = (value: UnknownRecord | null | undefined, keys: string[]): UnknownRecord | null => {
  if (!value) return null;
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

const collectMarkers = (value: unknown, seen = new Set<unknown>()): string[] => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (seen.has(value)) return [];
  if (Array.isArray(value)) {
    seen.add(value);
    return value.flatMap((item) => collectMarkers(item, seen));
  }
  if (!isRecord(value)) return [];

  seen.add(value);
  const keys = [
    "id",
    "uuid",
    "productId",
    "subscriptionProductId",
    "subscriptionId",
    "clientSubscriptionId",
    "counterKey",
    "planKey",
    "name",
    "title",
    "label",
    "productName",
    "subscriptionName",
    "subscriptionProductName",
  ];
  const result = keys.flatMap((key) => collectMarkers(value[key], seen));
  ["raw", "subscription", "clientSubscription", "clientSub", "product"].forEach((key) => {
    result.push(...collectMarkers(value[key], seen));
  });
  return result;
};

export function resolveSubscriptionCategoryDailyLimitPlanKey(
  value: unknown,
): SubscriptionCategoryDailyLimitPlanKey | null {
  const markers = collectMarkers(value);
  const comparableProductIds = Object.entries(SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS)
    .map(([key, productId]) => [key, normalizeComparableId(productId)] as const);

  for (const marker of markers) {
    const comparable = normalizeComparableId(marker);
    const matchedById = comparableProductIds.find(([, productId]) => productId && comparable === productId);
    if (matchedById) return matchedById[0] as SubscriptionCategoryDailyLimitPlanKey;
  }

  const normalizedMarkers = markers.map(normalizeMarker).filter(Boolean);
  if (normalizedMarkers.some((marker) => (
    marker.includes("friendship") || marker.includes("дружба") || marker.includes("druzhba")
  ))) {
    return "friendship";
  }
  if (normalizedMarkers.some((marker) => marker.includes("sport") || marker.includes("спорт"))) {
    return "sport";
  }
  if (normalizedMarkers.some((marker) => marker.includes("academy") || marker.includes("академ"))) {
    return "academy";
  }
  if (normalizedMarkers.some((marker) => (
    marker === "ра"
    || marker === "ra"
    || marker.includes("летопаделра")
    || marker.includes("padelra")
  ))) {
    return "ra";
  }

  return null;
}

export function subscriptionPlanAllowsDailyLimitCategory(
  value: unknown,
  category: SubscriptionCategoryDailyLimitCategory | null | undefined,
): boolean {
  if (!category) return false;
  const planKey = resolveSubscriptionCategoryDailyLimitPlanKey(value);
  return Boolean(planKey && PLAN_CATEGORIES[planKey].includes(category));
}

export function normalizeSubscriptionCategoryDailyLimitDate(value: unknown): string | null {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
}

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
  const directDate = normalizeSubscriptionCategoryDailyLimitDate(direct);
  if (directDate) return directDate;

  const exercise = pickRecord(value, ["exercise", "event", "tournament"]);
  return firstEventDate(exercise);
};

export function resolveSubscriptionCategoryDailyLimitDateFromEvent(value: unknown): string | null {
  return isRecord(value) ? firstEventDate(value) : normalizeSubscriptionCategoryDailyLimitDate(value);
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
  booking.bookingStatus,
  booking.cancellationReason,
  pickRecord(booking, ["transactionStatus"])?.transactionStatus,
  pickRecord(pickRecord(booking, ["transactionStatus"]) || {}, ["cardPaymentStatus"])?.status,
  pickRecord(pickRecord(booking, ["transactionStatus"]) || {}, ["cardPaymentStatus"])?.originalStatus,
  exercise?.status,
  exercise?.state,
].map((value) => String(value || "").trim().toUpperCase()).filter(Boolean);

const isBookingActive = (booking: UnknownRecord, exercise: UnknownRecord | null): boolean => {
  if (
    booking.isCancelled === true
    || booking.cancelled === true
    || booking.canceled === true
    || booking.archived === true
    || Boolean(toStr(booking.cancellationDate))
    || Boolean(toStr(booking.cancelledAt))
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

export function resolveSubscriptionCategoryDailyLimitCategoryFromEvent(
  value: unknown,
): SubscriptionCategoryDailyLimitCategory | null {
  const category: ExerciseCategory | null = resolveExerciseCategoryFromValue(value);
  if (
    category === EXERCISE_CATEGORY_OPEN_GAME
    || category === EXERCISE_CATEGORY_GROUP_TRAINING
    || category === EXERCISE_CATEGORY_TOURNAMENT
  ) {
    return category;
  }
  return null;
}

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

const formatDateRu = (date: unknown): string | null => {
  const matched = toStr(date)?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return matched ? `${matched[3]}.${matched[2]}.${matched[1]}` : null;
};

const normalizeEvent = (
  booking: UnknownRecord,
  category: SubscriptionCategoryDailyLimitCategory,
): SubscriptionCategoryDailyLimitEvent => {
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
    category,
    title:
      pickString(type, ["name", "title"])
      || pickString(direction, ["name", "title"])
      || pickString(exercise, ["name", "title"])
      || pickString(booking, ["serviceName", "title", "name"])
      || CATEGORY_TITLE_LABELS[category],
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

export function formatSubscriptionCategoryDailyLimitMessage(
  existingEvent: Partial<SubscriptionCategoryDailyLimitEvent> | null | undefined,
  options: {
    category: SubscriptionCategoryDailyLimitCategory;
    planKey: SubscriptionCategoryDailyLimitPlanKey;
  },
): string {
  const eventTitle = toStr(existingEvent?.title) || CATEGORY_TITLE_LABELS[options.category];
  const studioName = toStr(existingEvent?.studioName);
  const timeLabel = toStr(existingEvent?.timeLabel)
    || buildTimeLabel(formatTime(existingEvent?.timeFrom), formatTime(existingEvent?.timeTo));
  const dateLabel = formatDateRu(existingEvent?.date);
  const locationPart = studioName ? ` на станции ${studioName}` : "";
  const timePart = timeLabel ? ` в ${timeLabel}` : "";
  const datePart = dateLabel ? ` на ${dateLabel}` : "";
  const eventDate = normalizeSubscriptionCategoryDailyLimitDate(existingEvent?.date);
  if (eventDate && eventDate >= SUBSCRIPTION_CATEGORY_DAILY_LIMIT_SHARED_FROM) {
    return `По этому абонементу доступно одно списание в день. У вас уже есть ${CATEGORY_LABELS[existingEvent?.category ?? options.category]}: ${eventTitle}${locationPart}${timePart}${datePart}. Выберите другую дату.`;
  }
  return `Вам доступно использование абонемента на одно событие данной категории, у вас уже есть ${CATEGORY_LABELS[options.category]}: ${eventTitle}${locationPart}${timePart}${datePart}. Выберите другую дату или другую категорию записи.`;
}

export function resolveSubscriptionCategoryDailyLimitConflictFromBookings(
  bookings: Booking[] | unknown[] | null | undefined,
  options: {
    targetDate: string | null | undefined;
    category: SubscriptionCategoryDailyLimitCategory | null | undefined;
    currentSubscription: unknown;
    currentClientSubscriptionId?: string | null;
    currentExerciseId?: string | null;
    currentBookingId?: string | null;
  },
): SubscriptionCategoryDailyLimitConflict | null {
  const targetDate = normalizeSubscriptionCategoryDailyLimitDate(options.targetDate);
  const category = options.category ?? null;
  const planKey = resolveSubscriptionCategoryDailyLimitPlanKey(options.currentSubscription);
  const planCategories = planKey ? PLAN_CATEGORIES[planKey] : [];
  if (!targetDate || !category || !planKey || !planCategories.includes(category) || !Array.isArray(bookings)) {
    return null;
  }
  const hasSharedDailyLimit = targetDate >= SUBSCRIPTION_CATEGORY_DAILY_LIMIT_SHARED_FROM;

  const currentClientSubscriptionId = normalizeComparableId(options.currentClientSubscriptionId);
  const currentExerciseId = normalizeComparableId(options.currentExerciseId);
  const currentBookingId = normalizeComparableId(options.currentBookingId);

  for (const item of bookings) {
    if (!isRecord(item)) continue;
    const exercise = getBookingExercise(item);
    if (!isBookingActive(item, exercise) || !isSubscriptionBooking(item)) continue;
    const bookingDate = firstEventDate(item);
    if (bookingDate !== targetDate) continue;

    const bookingId = normalizeComparableId(getBookingId(item));
    const exerciseId = normalizeComparableId(getExerciseId(item, exercise));
    const bookingClientSubscriptionId = normalizeComparableId(getClientSubscriptionId(item));
    if (currentBookingId && bookingId === currentBookingId) continue;
    if (currentExerciseId && exerciseId === currentExerciseId) continue;
    if (currentClientSubscriptionId && bookingClientSubscriptionId !== currentClientSubscriptionId) {
      continue;
    }

    const bookingCategory = resolveSubscriptionCategoryDailyLimitCategoryFromEvent(item);
    if (!bookingCategory) continue;
    if (hasSharedDailyLimit ? !planCategories.includes(bookingCategory) : bookingCategory !== category) continue;

    const existingEvent = normalizeEvent(item, bookingCategory);
    return {
      code: SUBSCRIPTION_CATEGORY_DAILY_LIMIT_CODE,
      category,
      planKey,
      existingEvent,
      message: formatSubscriptionCategoryDailyLimitMessage(existingEvent, { category, planKey }),
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
  if (code === SUBSCRIPTION_CATEGORY_DAILY_LIMIT_CODE) return value;
  const details = isRecord(value.details) ? findDailyLimitPayload(value.details) : null;
  if (details) return details;
  const raw = isRecord(value.raw) ? findDailyLimitPayload(value.raw) : null;
  if (raw) return raw;
  return null;
};

export function isSubscriptionCategoryDailyLimitError(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  if (findDailyLimitPayload(error.raw)) return true;
  return candidateStrings(error).some((text) => (
    text === SUBSCRIPTION_CATEGORY_DAILY_LIMIT_CODE
    || /абонемент.+1\s*раз\s*в\s*день/i.test(text)
    || /subscription.+category.+daily.+limit/i.test(text)
  ));
}

export function resolveSubscriptionCategoryDailyLimitErrorMessage(
  error: ApiError | null | undefined,
): string | null {
  if (!error || !isSubscriptionCategoryDailyLimitError(error)) return null;
  const payload = findDailyLimitPayload(error.raw);
  const category = toStr(payload?.category) as SubscriptionCategoryDailyLimitCategory | null;
  const planKey = toStr(payload?.planKey) as SubscriptionCategoryDailyLimitPlanKey | null;
  const payloadMessage = toStr(payload?.message);
  if (payloadMessage) return payloadMessage;
  if (
    category
    && planKey
    && CATEGORY_LABELS[category]
    && isRecord(payload?.existingEvent)
  ) {
    return formatSubscriptionCategoryDailyLimitMessage(
      payload.existingEvent as Partial<SubscriptionCategoryDailyLimitEvent>,
      { category, planKey },
    );
  }
  return toStr(error.message);
}

export function buildSubscriptionCategoryDailyLimitApiError(
  conflict: SubscriptionCategoryDailyLimitConflict,
  status = 409,
): ApiError {
  return {
    status,
    message: conflict.message,
    raw: {
      code: conflict.code,
      category: conflict.category,
      planKey: conflict.planKey,
      message: conflict.message,
      existingEvent: conflict.existingEvent,
    },
  };
}
