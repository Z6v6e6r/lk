import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type {
  ManagedSubscriptionAction,
  ManagedSubscriptionPolicyDecision,
  ManagedSubscriptionPolicyEvaluationInput,
  ManagedSubscriptionResolvedTarget,
  ManagedSubscriptionRuntimeInstance,
  ManagedSubscriptionRuntimePolicy,
} from "../src/types/managedSubscriptionRuntime.ts";

const API_PREFIX = "/__dev/managed-subscriptions";
const EVALUATED_AT = "2026-08-15T10:00:00.000Z";
const TESTER_REF = "synthetic-3190";
const TESTER_LABEL = "+7 ••• •••-31-90";
const DEFAULT_CUP_BASE_URL = "http://127.0.0.1:3010";
const DEFAULT_TOURNAMENT_READ_BASE_URL = "https://lk-reserve.89-108-64-209.sslip.io/api";
const DEFAULT_TYPE_CODE = "annual-dev-ac6396e";
const MAX_BODY_BYTES = 16_384;

type JsonRecord = Record<string, unknown>;

export interface ManagedSubscriptionDevTarget {
  targetId: string;
  title: string;
  description: string;
  action: ManagedSubscriptionAction;
  courtPriceMinor?: number | null;
  participantCount?: number;
  target: ManagedSubscriptionResolvedTarget;
}

export interface ManagedSubscriptionDevReservation {
  reservationId: string;
  targetId: string;
  title: string;
  action: ManagedSubscriptionAction;
  status: "ACTIVE" | "RELEASED";
  startsAt: string;
  localDate: string;
  usageUnits: number;
  dailyUsageUnits: number;
  finalPriceMinor: number | null;
  createdAt: string;
  releasedAt: string | null;
  source: "SEED" | "USER";
}

export interface ManagedSubscriptionDevLedgerEvent {
  eventId: string;
  type:
    | "TEST_STATE_SEEDED"
    | "POLICY_PINNED"
    | "ELIGIBILITY_QUOTED"
    | "ELIGIBILITY_BLOCKED"
    | "FULL_PRICE_CONTINUATION_ALLOWED"
    | "ORDINARY_PAYMENT_ALLOWED"
    | "RESERVATION_CREATED"
    | "RESERVATION_RELEASED";
  occurredAt: string;
  operationId: string | null;
  targetId: string | null;
  reservationId: string | null;
  policyVersion: number | null;
  details: JsonRecord;
}

interface PolicySource {
  subscriptionTypeId: string;
  code: string;
  title: string;
  sourceStatus: string;
  sourceModelVersion: number | null;
  loadedAt: string;
  digest: string;
  policy: ManagedSubscriptionRuntimePolicy;
}

interface SubscriptionUsageShadowNewGameIntent {
  targetKind: "NEW_GAME";
  slotId: string;
  stationId: string;
  roomId: string;
  masterServiceId: string;
  subServiceIds: string[];
  startsAt: string;
  durationMinutes: 60 | 90 | 120;
}

interface SubscriptionUsageShadowGameIntent {
  targetKind: "GAME_AGGREGATE";
  gameId: string;
}

interface SubscriptionUsageShadowEventIntent {
  targetKind: "EVENT_AGGREGATE";
  eventId: string;
}

type SubscriptionUsageShadowIntent =
  | SubscriptionUsageShadowNewGameIntent
  | SubscriptionUsageShadowGameIntent
  | SubscriptionUsageShadowEventIntent;

interface SubscriptionUsageShadowJoinFixture {
  stationId: string;
  startsAt: string;
  durationMinutes: 60 | 90 | 120;
  courtPriceMinor: number;
}

interface SubscriptionUsageShadowEventFixture {
  action: "BOOK_GROUP_TRAINING" | "BOOK_TOURNAMENT";
  stationId: string;
  startsAt: string;
  durationMinutes: 60 | 90 | 120;
  basePriceMinor: number;
}

interface OperationReplay {
  fingerprint: string;
  response: unknown;
}

interface DevRuntimeOptions {
  policyLoader: () => Promise<PolicySource>;
}

class DevRuntimeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: JsonRecord | null;

  constructor(status: number, code: string, message: string, details: JsonRecord | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const evaluatorSource = readFileSync(
  new URL("./nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js", import.meta.url),
  "utf8",
);
const evaluator = new Function("msg", evaluatorSource) as (msg: JsonRecord) => unknown;

const asRecord = (value: unknown): JsonRecord => (
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}
);

const asNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asStringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : []
);

const stableDigest = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

const localDate = (iso: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
};

const clone = <T>(value: T): T => structuredClone(value);

const evaluatePolicy = (
  input: ManagedSubscriptionPolicyEvaluationInput,
): ManagedSubscriptionPolicyDecision => {
  const msg: JsonRecord = { _managedSubscriptionPolicyInput: clone(input) };
  evaluator(msg);
  return clone(msg._managedSubscriptionPolicyDecision as ManagedSubscriptionPolicyDecision);
};

export const compileDraftPolicy = (
  subscriptionType: JsonRecord,
  draftPolicy: JsonRecord,
  loadedAt = new Date().toISOString(),
): PolicySource => {
  const capabilities = asRecord(draftPolicy.capabilities);
  const lifecycle = asRecord(capabilities.lifecycle);
  const usage = asRecord(capabilities.usage);
  const version = asNumber(draftPolicy.version, 0);
  const subscriptionTypeId = String(
    draftPolicy.subscriptionTypeId || subscriptionType.subscriptionTypeId || "",
  ).trim();
  if (!subscriptionTypeId || !Number.isInteger(version) || version < 1) {
    throw new DevRuntimeError(
      503,
      "CUP_POLICY_INVALID",
      "DEV ЦУП вернул неподходящую версию правил",
    );
  }

  const activeLimit = asRecord(draftPolicy.activeServicesLimit);
  const bookingWindow = asRecord(draftPolicy.bookingWindow);
  const dailyUsagePolicy = asRecord(draftPolicy.dailyUsagePolicy);
  const hasDiscountDurations = Object.prototype.hasOwnProperty.call(
    dailyUsagePolicy,
    "discountDurationsMinutes",
  );
  if (hasDiscountDurations && !Array.isArray(dailyUsagePolicy.discountDurationsMinutes)) {
    throw new DevRuntimeError(
      503,
      "CUP_POLICY_INVALID",
      "DEV ЦУП вернул некорректный фильтр длительностей дневной скидки",
    );
  }
  const hasUsageDurations = Object.prototype.hasOwnProperty.call(
    dailyUsagePolicy,
    "usageDurationsMinutes",
  );
  const usageDurationsMinutes = asStringArray(dailyUsagePolicy.usageDurationsMinutes)
    .map(Number)
    .filter((duration): duration is 60 | 90 | 120 => [60, 90, 120].includes(duration));
  if (hasUsageDurations && (
    !Array.isArray(dailyUsagePolicy.usageDurationsMinutes)
    || usageDurationsMinutes.length === 0
    || usageDurationsMinutes.length !== dailyUsagePolicy.usageDurationsMinutes.length
    || new Set(usageDurationsMinutes).size !== usageDurationsMinutes.length
  )) {
    throw new DevRuntimeError(
      503,
      "CUP_POLICY_INVALID",
      "DEV ЦУП вернул некорректный фильтр длительностей дневного лимита",
    );
  }
  const createGame = asRecord(draftPolicy.createGame);
  const joinGame = asRecord(draftPolicy.joinGame);
  const policy: ManagedSubscriptionRuntimePolicy = {
    runtimeSchemaVersion: 1,
    subscriptionTypeId,
    policyVersion: version,
    // This promotion exists only inside the loopback DEV process. It is never written to CUP.
    status: "PUBLISHED",
    effectiveAt: String(draftPolicy.effectiveAt || EVALUATED_AT),
    timeZone: "Europe/Moscow",
    createGame: {
      enabled: createGame.enabled === true,
      durationsMinutes: asStringArray(createGame.durationsMinutes)
        .map(Number)
        .filter((duration): duration is 60 | 90 | 120 => [60, 90, 120].includes(duration)),
    },
    joinGame: {
      enabled: joinGame.enabled === true,
      minDurationMinutes: asNumber(joinGame.minDurationMinutes, 0),
      maxDurationMinutes: asNumber(joinGame.maxDurationMinutes, 0),
    },
    activeServicesLimit: {
      enabled: activeLimit.enabled === true,
      max: activeLimit.enabled === true ? asNullableNumber(activeLimit.max) : null,
      scope: activeLimit.scope === "ALL_BOOKINGS" ? "ALL_BOOKINGS" : "SUBSCRIPTION_BENEFIT_ONLY",
    },
    bookingWindow: {
      enabled: bookingWindow.enabled === true,
      days: bookingWindow.enabled === true ? asNullableNumber(bookingWindow.days) : null,
    },
    dailyUsageLimit: asNumber(draftPolicy.dailyUsageLimit, 0),
    dailyUsagePolicy: {
      actions: (asStringArray(dailyUsagePolicy.actions).length
        ? asStringArray(dailyUsagePolicy.actions)
        : [
          "CREATE_GAME",
          "JOIN_GAME",
          "BOOK_GROUP_TRAINING",
          "BOOK_TOURNAMENT",
          "PURCHASE_ADD_ON_PRODUCT",
        ]).filter((action): action is ManagedSubscriptionAction => [
        "CREATE_GAME",
        "JOIN_GAME",
        "BOOK_GROUP_TRAINING",
        "BOOK_TOURNAMENT",
        "PURCHASE_ADD_ON_PRODUCT",
      ].includes(action)),
      limitExceeded: dailyUsagePolicy.limitExceeded === "PERCENT_DISCOUNT"
        ? "PERCENT_DISCOUNT"
        : "BLOCK",
      percentage: dailyUsagePolicy.limitExceeded === "PERCENT_DISCOUNT"
        ? asNullableNumber(dailyUsagePolicy.percentage)
        : null,
      ...(hasUsageDurations ? {
        usageDurationsMinutes,
      } : {}),
      ...(hasDiscountDurations ? {
        discountDurationsMinutes: asStringArray(dailyUsagePolicy.discountDurationsMinutes)
          .map(Number)
          .filter((duration): duration is 60 | 90 | 120 => [60, 90, 120].includes(duration)),
      } : {}),
    },
    usageUnitsByDuration: {
      "60": asNumber(asRecord(draftPolicy.usageUnitsByDuration)["60"], 0),
      "90": asNumber(asRecord(draftPolicy.usageUnitsByDuration)["90"], 0),
      "120": asNumber(asRecord(draftPolicy.usageUnitsByDuration)["120"], 0),
    },
    stationAccessRules: clone(Array.isArray(draftPolicy.stationAccessRules)
      ? draftPolicy.stationAccessRules
      : []) as ManagedSubscriptionRuntimePolicy["stationAccessRules"],
    benefitRules: clone(Array.isArray(draftPolicy.benefitRules)
      ? draftPolicy.benefitRules
      : []) as ManagedSubscriptionRuntimePolicy["benefitRules"],
    lifecycle: {
      allowBookingsAfterExpiry: lifecycle.allowBookingsAfterExpiry === true,
    },
    usage: {
      weeklyUsageLimit: asNullableNumber(usage.weeklyUsageLimit),
      monthlyUsageLimit: asNullableNumber(usage.monthlyUsageLimit),
      maxFutureBookings: asNullableNumber(usage.maxFutureBookings),
      minHoursBetweenUses: asNumber(usage.minHoursBetweenUses, 0),
      blackoutDates: asStringArray(usage.blackoutDates),
    },
  };

  return {
    subscriptionTypeId,
    code: String(subscriptionType.code || "").trim(),
    title: String(subscriptionType.title || "DEV подписка").trim(),
    sourceStatus: String(draftPolicy.status || "DRAFT"),
    sourceModelVersion: asNullableNumber(draftPolicy.modelVersion),
    loadedAt,
    digest: stableDigest(policy),
    policy,
  };
};

export const buildAnnualShadowPolicySource = (stationIds: string[]): PolicySource => compileDraftPolicy(
  {
    subscriptionTypeId: "subscription_type:annual-shadow-fixture",
    code: "annual-shadow-fixture",
    title: "DEV fixture годовой подписки",
  },
  {
    subscriptionTypeId: "subscription_type:annual-shadow-fixture",
    version: 1,
    status: "DRAFT_FIXTURE",
    modelVersion: 1,
    effectiveAt: "2026-08-15T00:00:00.000Z",
    createGame: { enabled: true, durationsMinutes: [60, 90, 120] },
    joinGame: { enabled: true, minDurationMinutes: 60, maxDurationMinutes: 120 },
    activeServicesLimit: {
      enabled: true,
      max: 4,
      scope: "SUBSCRIPTION_BENEFIT_ONLY",
    },
    bookingWindow: { enabled: true, days: 14 },
    dailyUsageLimit: 1,
    dailyUsagePolicy: {
      actions: ["CREATE_GAME", "JOIN_GAME"],
      limitExceeded: "PERCENT_DISCOUNT",
      percentage: 30,
      usageDurationsMinutes: [60],
      discountDurationsMinutes: [90, 120],
    },
    usageUnitsByDuration: { "60": 1, "90": 1, "120": 1 },
    stationAccessRules: [{
      ruleId: "annual-shadow-all-stations",
      enabled: true,
      priority: 100,
      selector: { kind: "ALL_STATIONS", stationIds: [] },
      surcharge: { kind: "NONE", amountMinor: 0 },
    }],
    benefitRules: [
      ...[60, 90, 120].map((durationMinutes) => ({
        ruleId: `annual-shadow-game-${durationMinutes}`,
        enabled: true,
        category: "GAME",
        actions: ["CREATE_GAME", "JOIN_GAME"],
        externalEventTypeIds: ["dev-open-game"],
        productTypeIds: [],
        durationMinutes: [durationMinutes],
        stationIds,
        kind: durationMinutes === 60 ? "FREE_ENTITLEMENT" : "PERCENT_DISCOUNT",
        valueMinor: null,
        percentage: durationMinutes === 60 ? null : 30,
        partialPrice: null,
        priority: 100,
      })),
      {
        ruleId: "annual-shadow-group-training-50",
        enabled: true,
        category: "GROUP_TRAINING",
        actions: ["BOOK_GROUP_TRAINING"],
        externalEventTypeIds: ["dev-group-training"],
        productTypeIds: [],
        durationMinutes: [60, 90, 120],
        stationIds,
        kind: "PERCENT_DISCOUNT",
        valueMinor: null,
        percentage: 50,
        partialPrice: null,
        priority: 100,
      },
    ],
    capabilities: {
      lifecycle: { allowBookingsAfterExpiry: false },
      usage: {
        weeklyUsageLimit: null,
        monthlyUsageLimit: null,
        maxFutureBookings: null,
        minHoursBetweenUses: 0,
        blackoutDates: [],
      },
    },
  },
  EVALUATED_AT,
);

export const loadPolicyFromCup = async (options: {
  baseUrl?: string;
  typeCode?: string;
  policyVersion?: number | string;
  fetchImpl?: typeof fetch;
} = {}): Promise<PolicySource> => {
  const baseUrl = String(options.baseUrl || DEFAULT_CUP_BASE_URL).replace(/\/+$/, "");
  const typeCode = String(options.typeCode || DEFAULT_TYPE_CODE).trim();
  const requestedVersion = options.policyVersion === undefined || options.policyVersion === ""
    ? null
    : Number(options.policyVersion);
  if (requestedVersion !== null && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) {
    throw new DevRuntimeError(
      503,
      "CUP_POLICY_VERSION_INVALID",
      "Некорректно задана версия правил для DEV runtime",
    );
  }
  const fetchImpl = options.fetchImpl || fetch;
  const headers = {
    "X-User-Id": "lk-managed-subscriptions-dev-runtime",
    "X-User-Role": "SUPER_ADMIN",
  };

  try {
    const typesResponse = await fetchImpl(`${baseUrl}/api/v1/admin/subscription-types`, {
      headers,
      signal: AbortSignal.timeout(4_000),
    });
    if (!typesResponse.ok) throw new Error(`types:${typesResponse.status}`);
    const typesPayload = asRecord(await typesResponse.json());
    const types = Array.isArray(typesPayload.items) ? typesPayload.items.map(asRecord) : [];
    const subscriptionType = types.find((item) => item.code === typeCode);
    if (!subscriptionType) {
      throw new DevRuntimeError(
        503,
        "CUP_TYPE_NOT_FOUND",
        `В DEV ЦУП не найден тип ${typeCode}`,
      );
    }
    const typeId = encodeURIComponent(String(subscriptionType.subscriptionTypeId));
    const policiesResponse = await fetchImpl(
      `${baseUrl}/api/v1/admin/subscription-types/${typeId}/policy-versions`,
      { headers, signal: AbortSignal.timeout(4_000) },
    );
    if (!policiesResponse.ok) throw new Error(`policies:${policiesResponse.status}`);
    const policiesPayload = await policiesResponse.json();
    const policies = Array.isArray(policiesPayload) ? policiesPayload.map(asRecord) : [];
    const drafts = policies
      .filter((item) => item.status === "DRAFT")
      .sort((left, right) => asNumber(right.version, 0) - asNumber(left.version, 0));
    const draft = requestedVersion === null
      ? drafts[0]
      : drafts.find((item) => asNumber(item.version, 0) === requestedVersion);
    if (!draft) {
      throw new DevRuntimeError(
        503,
        "CUP_DRAFT_POLICY_NOT_FOUND",
        requestedVersion === null
          ? "У выбранного DEV-типа нет DRAFT-версии правил"
          : `У выбранного DEV-типа нет DRAFT-версии ${requestedVersion}`,
      );
    }
    return compileDraftPolicy(subscriptionType, draft);
  } catch (error) {
    if (error instanceof DevRuntimeError) throw error;
    throw new DevRuntimeError(
      503,
      "CUP_DEV_UNAVAILABLE",
      "DEV ЦУП недоступен: проверьте порт 3010 и SSH-туннель",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
};

export const buildDevTargets = (): ManagedSubscriptionDevTarget[] => [
  {
    targetId: "create-station-a-60-aug18",
    title: "Создать игру 60 минут",
    description: "Первая игровая услуга дня · 1 час бесплатно",
    action: "CREATE_GAME",
    courtPriceMinor: 600_000,
    participantCount: 4,
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-a",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-create-a-60-aug18",
      durationMinutes: 60,
      startsAt: "2026-08-18T06:00:00.000Z",
      basePriceMinor: 150_000,
      currency: "RUB",
    },
  },
  {
    targetId: "create-station-a-90-aug18",
    title: "Создать игру 90 минут",
    description: "Игра 90 минут · скидка 30% от полной цены",
    action: "CREATE_GAME",
    courtPriceMinor: 900_000,
    participantCount: 4,
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-a",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-create-a-90-aug18",
      durationMinutes: 90,
      startsAt: "2026-08-18T08:00:00.000Z",
      basePriceMinor: 225_000,
      currency: "RUB",
    },
  },
  {
    targetId: "create-home-120-aug18",
    title: "Создать игру 120 минут",
    description: "Игра 120 минут · скидка 30% от полной цены",
    action: "CREATE_GAME",
    courtPriceMinor: 1_200_000,
    participantCount: 4,
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-home",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-create-home-120-aug18",
      durationMinutes: 120,
      startsAt: "2026-08-18T10:00:00.000Z",
      basePriceMinor: 300_000,
      currency: "RUB",
    },
  },
  {
    targetId: "join-station-b-60-aug18",
    title: "Присоединиться к игре",
    description: "Первая игровая услуга дня бесплатно; сверх дневного лимита — скидка 30%",
    action: "JOIN_GAME",
    courtPriceMinor: 600_000,
    participantCount: 4,
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-b",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-join-b-60-aug18",
      durationMinutes: 60,
      startsAt: "2026-08-18T12:00:00.000Z",
      basePriceMinor: 150_000,
      currency: "RUB",
    },
  },
  {
    targetId: "join-station-b-90-aug18",
    title: "Присоединиться к игре 90 минут",
    description: "Игра 90 минут · скидка 30% от полной цены",
    action: "JOIN_GAME",
    courtPriceMinor: 900_000,
    participantCount: 4,
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-b",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-join-b-90-aug18",
      durationMinutes: 90,
      startsAt: "2026-08-18T13:00:00.000Z",
      basePriceMinor: 225_000,
      currency: "RUB",
    },
  },
  {
    targetId: "join-station-b-120-aug18",
    title: "Присоединиться к игре 120 минут",
    description: "Игра 120 минут · скидка 30% от полной цены",
    action: "JOIN_GAME",
    courtPriceMinor: 1_200_000,
    participantCount: 4,
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-b",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-join-b-120-aug18",
      durationMinutes: 120,
      startsAt: "2026-08-18T15:00:00.000Z",
      basePriceMinor: 300_000,
      currency: "RUB",
    },
  },
  {
    targetId: "create-station-a-60-aug22",
    title: "Создать игру 22 августа",
    description: "Проверка окна записи · станция A · 60 минут",
    action: "CREATE_GAME",
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-a",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-create-a-60-aug22",
      durationMinutes: 60,
      startsAt: "2026-08-22T06:00:00.000Z",
      basePriceMinor: 400_000,
      currency: "RUB",
    },
  },
  {
    targetId: "create-unknown-station-60-aug18",
    title: "Создать игру на другой станции",
    description: "Станция не включена в правила подписки",
    action: "CREATE_GAME",
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-unknown",
      category: "GAME",
      externalEventTypeId: "dev-open-game",
      productTypeId: null,
      eventId: "dev-event-create-unknown-60-aug18",
      durationMinutes: 60,
      startsAt: "2026-08-18T14:00:00.000Z",
      basePriceMinor: 400_000,
      currency: "RUB",
    },
  },
  {
    targetId: "addon-racket-station-a-aug18",
    title: "Добавить аренду ракетки",
    description: "Доппродукт · станция A · базовая цена 1 000 ₽",
    action: "PURCHASE_ADD_ON_PRODUCT",
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-a",
      category: "ADD_ON_PRODUCT",
      externalEventTypeId: "dev-rental-event",
      productTypeId: "dev-racket-rental",
      eventId: "dev-event-addon-racket-aug18",
      durationMinutes: 60,
      startsAt: "2026-08-18T16:00:00.000Z",
      basePriceMinor: 100_000,
      currency: "RUB",
    },
  },
  {
    targetId: "group-station-a-60-aug18",
    title: "Записаться на групповую",
    description: "Скидка 50%; не расходует бесплатную игровую услугу дня",
    action: "BOOK_GROUP_TRAINING",
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-a",
      category: "GROUP_TRAINING",
      externalEventTypeId: "dev-group-training",
      productTypeId: null,
      eventId: "dev-event-group-a-60-aug18",
      durationMinutes: 60,
      startsAt: "2026-08-18T17:00:00.000Z",
      basePriceMinor: 300_000,
      currency: "RUB",
    },
  },
  {
    targetId: "tournament-station-a-120-aug18",
    title: "Записаться на турнир",
    description: "Без точного provider mapping формат остаётся недоступным",
    action: "BOOK_TOURNAMENT",
    target: {
      resolutionSource: "SERVER",
      stationId: "dev-station-a",
      category: "TOURNAMENT",
      externalEventTypeId: "dev-tournament",
      productTypeId: null,
      eventId: "dev-event-tournament-a-120-aug18",
      durationMinutes: 120,
      startsAt: "2026-08-18T18:00:00.000Z",
      basePriceMinor: 500_000,
      currency: "RUB",
    },
  },
];

export const createManagedSubscriptionDevRuntime = (options: DevRuntimeOptions) => {
  const targets = buildDevTargets();
  const targetById = new Map(targets.map((target) => [target.targetId, target]));
  const reservations = new Map<string, ManagedSubscriptionDevReservation>();
  const operations = new Map<string, OperationReplay>();
  const ledger: ManagedSubscriptionDevLedgerEvent[] = [];
  let policySource: PolicySource | null = null;
  let instance: ManagedSubscriptionRuntimeInstance | null = null;
  let mutationTail: Promise<void> = Promise.resolve();

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const execution = mutationTail.then(operation, operation);
    mutationTail = execution.then(() => undefined, () => undefined);
    return execution;
  };

  const appendEvent = (
    type: ManagedSubscriptionDevLedgerEvent["type"],
    data: Partial<ManagedSubscriptionDevLedgerEvent> = {},
  ) => {
    ledger.unshift({
      eventId: `dev-event:${randomUUID()}`,
      type,
      occurredAt: new Date().toISOString(),
      operationId: data.operationId || null,
      targetId: data.targetId || null,
      reservationId: data.reservationId || null,
      policyVersion: data.policyVersion ?? policySource?.policy.policyVersion ?? null,
      details: clone(data.details || {}),
    });
    if (ledger.length > 100) ledger.length = 100;
  };

  const pinPolicy = async () => {
    policySource = await options.policyLoader();
    instance = {
      subscriptionInstanceId: "dev-instance:synthetic-3190",
      subscriptionTypeId: policySource.subscriptionTypeId,
      policyVersion: policySource.policy.policyVersion,
      state: "ACTIVE",
      activeFrom: "2026-08-15T00:00:00.000Z",
      activeTo: "2027-08-14T20:59:59.999Z",
      homeStationId: "dev-station-home",
      frozenUntil: null,
      noShowBlockedUntil: null,
    };
    appendEvent("POLICY_PINNED", {
      details: { digest: policySource.digest, sourceStatus: policySource.sourceStatus },
    });
  };

  const requireContext = async () => {
    if (!policySource || !instance) await pinPolicy();
    return { policySource: policySource as PolicySource, instance: instance as ManagedSubscriptionRuntimeInstance };
  };

  const activeReservations = () => [...reservations.values()]
    .filter((reservation) => reservation.status === "ACTIVE");

  const usageFor = (target: ManagedSubscriptionDevTarget, policy: ManagedSubscriptionRuntimePolicy) => {
    const active = activeReservations();
    const bucketDate = localDate(target.target.startsAt);
    const dailyActions = policy.dailyUsagePolicy?.actions ?? [
      "CREATE_GAME",
      "JOIN_GAME",
      "BOOK_GROUP_TRAINING",
      "BOOK_TOURNAMENT",
      "PURCHASE_ADD_ON_PRODUCT",
    ];
    const daily = active.filter((reservation) => (
      reservation.localDate === bucketDate && dailyActions.includes(reservation.action)
    ));
    return {
      activeServiceScope: policy.activeServicesLimit.scope,
      dailyBucketLocalDate: bucketDate,
      activeServices: policy.activeServicesLimit.enabled ? active.length : null,
      dailyUsed: daily.reduce((sum, reservation) => sum + reservation.dailyUsageUnits, 0),
      weeklyUsed: active.reduce((sum, reservation) => sum + reservation.usageUnits, 0),
      monthlyUsed: active.reduce((sum, reservation) => sum + reservation.usageUnits, 0),
      futureBookings: active.length,
      activeServiceStartsAt: active.map((reservation) => reservation.startsAt),
    };
  };

  const targetOrThrow = (targetId: unknown): ManagedSubscriptionDevTarget => {
    const normalized = String(targetId || "").trim();
    const target = targetById.get(normalized);
    if (!target) {
      throw new DevRuntimeError(
        400,
        "DEV_TARGET_NOT_FOUND",
        "Тестовое событие не найдено в серверном каталоге",
      );
    }
    return target;
  };

  const decisionFor = async (targetId: unknown): Promise<{
    target: ManagedSubscriptionDevTarget;
    decision: ManagedSubscriptionPolicyDecision;
  }> => {
    const context = await requireContext();
    const target = targetOrThrow(targetId);
    const input: ManagedSubscriptionPolicyEvaluationInput = {
      evaluatedAt: EVALUATED_AT,
      action: target.action,
      policy: clone(context.policySource.policy),
      instance: clone(context.instance),
      target: clone(target.target),
      usage: usageFor(target, context.policySource.policy),
    };
    return { target, decision: evaluatePolicy(input) };
  };

  const decisionForResolvedTarget = async (
    target: ManagedSubscriptionDevTarget,
    usage: { activeServices: number; dailyGameUsage: number },
  ): Promise<ManagedSubscriptionPolicyDecision> => {
    const context = await requireContext();
    const bucketDate = localDate(target.target.startsAt);
    return evaluatePolicy({
      evaluatedAt: EVALUATED_AT,
      action: target.action,
      policy: clone(context.policySource.policy),
      instance: clone(context.instance),
      target: clone(target.target),
      usage: {
        activeServiceScope: context.policySource.policy.activeServicesLimit.scope,
        dailyBucketLocalDate: bucketDate,
        activeServices: usage.activeServices,
        dailyUsed: usage.dailyGameUsage,
        weeklyUsed: usage.dailyGameUsage,
        monthlyUsed: usage.dailyGameUsage,
        futureBookings: usage.activeServices,
        activeServiceStartsAt: [],
      },
    });
  };

  const seedUnlocked = async (count: number) => {
    await requireContext();
    if (!Number.isInteger(count) || count < 0 || count > 4) {
      throw new DevRuntimeError(400, "DEV_SEED_INVALID", "Допустимо от 0 до 4 активных услуг");
    }
    reservations.clear();
    operations.clear();
    const seedDates = [
      "2026-08-15T06:00:00.000Z",
      "2026-08-16T06:00:00.000Z",
      "2026-08-17T06:00:00.000Z",
      "2026-08-19T06:00:00.000Z",
    ];
    for (let index = 0; index < count; index += 1) {
      const startsAt = seedDates[index];
      if (!startsAt) continue;
      const reservationId = `dev-seed:${index + 1}`;
      reservations.set(reservationId, {
        reservationId,
        targetId: `seed-active-${index + 1}`,
        title: `Тестовая активная услуга ${index + 1}`,
        action: "CREATE_GAME",
        status: "ACTIVE",
        startsAt,
        localDate: localDate(startsAt),
        usageUnits: 1,
        dailyUsageUnits: 1,
        finalPriceMinor: 0,
        createdAt: EVALUATED_AT,
        releasedAt: null,
        source: "SEED",
      });
    }
    appendEvent("TEST_STATE_SEEDED", { details: { activeServices: count } });
    return snapshot();
  };

  const snapshot = async () => {
    const context = await requireContext();
    return {
      mode: "DEV_SHADOW",
      testOnly: true,
      providerMode: "FAKE_NO_VIVA",
      evaluatedAt: EVALUATED_AT,
      tester: { testerRef: TESTER_REF, displayPhone: TESTER_LABEL },
      policySource: {
        subscriptionTypeId: context.policySource.subscriptionTypeId,
        code: context.policySource.code,
        title: context.policySource.title,
        sourceStatus: context.policySource.sourceStatus,
        runtimeStatus: context.policySource.policy.status,
        sourceModelVersion: context.policySource.sourceModelVersion,
        version: context.policySource.policy.policyVersion,
        digest: context.policySource.digest,
        loadedAt: context.policySource.loadedAt,
      },
      limits: {
        activeServices: activeReservations().length,
        activeServicesEnabled: context.policySource.policy.activeServicesLimit.enabled,
        maxActiveServices: context.policySource.policy.activeServicesLimit.max,
        bookingWindowEnabled: context.policySource.policy.bookingWindow.enabled,
        bookingWindowDays: context.policySource.policy.bookingWindow.days,
        dailyUsageLimit: context.policySource.policy.dailyUsageLimit,
        dailyUsageActions: clone(context.policySource.policy.dailyUsagePolicy?.actions ?? []),
        dailyUsageDurationsMinutes: clone(
          context.policySource.policy.dailyUsagePolicy?.usageDurationsMinutes ?? null,
        ),
        dailyLimitExceeded: context.policySource.policy.dailyUsagePolicy?.limitExceeded ?? "BLOCK",
        dailyLimitExceededPercentage: context.policySource.policy.dailyUsagePolicy?.percentage ?? null,
      },
      instance: clone(context.instance),
      targets: clone(targets),
      reservations: clone([...reservations.values()]),
      ledger: clone(ledger.slice(0, 20)),
    };
  };

  return {
    async initialize() {
      if (!policySource) {
        await mutate(async () => {
          if (policySource) return;
          await pinPolicy();
          await seedUnlocked(2);
        });
      }
      return snapshot();
    },
    snapshot,
    async quote(targetId: unknown) {
      const result = await decisionFor(targetId);
      const bookingOutcome = buildShadowBookingOutcome(result.target, result.decision);
      const eventType = result.decision.eligible
        ? "ELIGIBILITY_QUOTED"
        : bookingOutcome.allowed ? "FULL_PRICE_CONTINUATION_ALLOWED" : "ELIGIBILITY_BLOCKED";
      appendEvent(eventType, {
        targetId: result.target.targetId,
        details: {
          blockerCodes: result.decision.blockers.map((blocker) => blocker.code),
          finalPriceMinor: result.decision.benefit?.finalPriceMinor ?? null,
          pricingMode: bookingOutcome.pricingMode,
        },
      });
      return {
        target: clone(result.target),
        decision: result.decision,
        bookingOutcome,
        snapshot: await snapshot(),
      };
    },
    ordinary(targetId: unknown, operationId: unknown) {
      return mutate(async () => {
        const normalizedOperationId = String(operationId || "").trim();
        if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(normalizedOperationId)) {
          throw new DevRuntimeError(400, "IDEMPOTENCY_KEY_INVALID", "Некорректный operationId");
        }
        const target = targetOrThrow(targetId);
        const fingerprint = stableDigest({ action: "ordinary", targetId: target.targetId });
        const replay = operations.get(normalizedOperationId);
        if (replay) {
          if (replay.fingerprint !== fingerprint) {
            throw new DevRuntimeError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "operationId уже использован для другого тестового действия",
            );
          }
          return { ...(clone(replay.response) as JsonRecord), replayed: true };
        }
        const context = await requireContext();
        const decision: ManagedSubscriptionPolicyDecision = {
          eligible: false,
          policyVersion: context.policySource.policy.policyVersion,
          blockers: [{
            code: "NO_ACTIVE_SUBSCRIPTION",
            message: "Активной подписки нет — доступна обычная оплата",
            details: null,
          }],
          usageUnits: 0,
          activeServices: activeReservations().length,
          maxActiveServices: context.policySource.policy.activeServicesLimit.max,
          dailyUsed: 0,
          dailyLimit: context.policySource.policy.dailyUsageLimit,
          benefit: null,
          evaluatedAt: EVALUATED_AT,
        };
        const bookingOutcome = {
          allowed: true,
          subscriptionApplied: false,
          pricingMode: "FULL_PRICE_WITHOUT_SUBSCRIPTION" as const,
          finalPriceMinor: target.target.basePriceMinor,
          reasonCodes: ["NO_ACTIVE_SUBSCRIPTION"],
        };
        appendEvent("ORDINARY_PAYMENT_ALLOWED", {
          operationId: normalizedOperationId,
          targetId: target.targetId,
          details: {
            subscriptionApplied: false,
            finalPriceMinor: bookingOutcome.finalPriceMinor,
            providerCalls: 0,
          },
        });
        const response = {
          target: clone(target),
          decision,
          bookingOutcome,
          reservation: null,
          snapshot: await snapshot(),
          replayed: false,
        };
        operations.set(normalizedOperationId, { fingerprint, response: clone(response) });
        return response;
      });
    },
    async quoteResolved(
      target: ManagedSubscriptionDevTarget,
      usage: { activeServices: number; dailyGameUsage: number },
    ) {
      const decision = await decisionForResolvedTarget(target, usage);
      appendEvent(decision.eligible ? "ELIGIBILITY_QUOTED" : "ELIGIBILITY_BLOCKED", {
        targetId: target.targetId,
        details: {
          blockerCodes: decision.blockers.map((blocker) => blocker.code),
          finalPriceMinor: decision.benefit?.finalPriceMinor ?? null,
          resolutionSource: "SERVER_FIXTURE",
        },
      });
      return { target: clone(target), decision };
    },
    reserve(targetId: unknown, operationId: unknown) {
      return mutate(async () => {
        const normalizedOperationId = String(operationId || "").trim();
        if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(normalizedOperationId)) {
          throw new DevRuntimeError(400, "IDEMPOTENCY_KEY_INVALID", "Некорректный operationId");
        }
        const target = targetOrThrow(targetId);
        const fingerprint = stableDigest({ action: "reserve", targetId: target.targetId });
        const replay = operations.get(normalizedOperationId);
        if (replay) {
          if (replay.fingerprint !== fingerprint) {
            throw new DevRuntimeError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "operationId уже использован для другого тестового действия",
            );
          }
          return { ...(clone(replay.response) as JsonRecord), replayed: true };
        }

        // All reserve/release/seed mutations use one in-process queue. The final
        // evaluation and write therefore share one atomic DEV-only boundary.
        const result = await decisionFor(target.targetId);
        const bookingOutcome = buildShadowBookingOutcome(result.target, result.decision);
        if (!bookingOutcome.allowed) {
          appendEvent("ELIGIBILITY_BLOCKED", {
            operationId: normalizedOperationId,
            targetId: target.targetId,
            details: { blockerCodes: result.decision.blockers.map((blocker) => blocker.code) },
          });
          throw new DevRuntimeError(
            409,
            "MANAGED_SUBSCRIPTION_BLOCKED",
            result.decision.blockers[0]?.message || "Действие заблокировано правилами подписки",
            { decision: result.decision },
          );
        }
        if (!bookingOutcome.subscriptionApplied) {
          appendEvent("FULL_PRICE_CONTINUATION_ALLOWED", {
            operationId: normalizedOperationId,
            targetId: target.targetId,
            details: {
              blockerCodes: bookingOutcome.reasonCodes,
              finalPriceMinor: bookingOutcome.finalPriceMinor,
            },
          });
          const response = {
            reservation: null,
            decision: result.decision,
            bookingOutcome,
            snapshot: await snapshot(),
            replayed: false,
          };
          operations.set(normalizedOperationId, { fingerprint, response: clone(response) });
          return response;
        }
        const reservationId = `dev-reservation:${randomUUID()}`;
        const reservation: ManagedSubscriptionDevReservation = {
          reservationId,
          targetId: target.targetId,
          title: target.title,
          action: target.action,
          status: "ACTIVE",
          startsAt: target.target.startsAt,
          localDate: localDate(target.target.startsAt),
          usageUnits: result.decision.usageUnits || 0,
          dailyUsageUnits: !policySource?.policy.dailyUsagePolicy?.usageDurationsMinutes
            || policySource.policy.dailyUsagePolicy.usageDurationsMinutes.includes(
              target.target.durationMinutes as 60 | 90 | 120,
            )
            ? result.decision.usageUnits || 0
            : 0,
          finalPriceMinor: bookingOutcome.finalPriceMinor,
          createdAt: new Date().toISOString(),
          releasedAt: null,
          source: "USER",
        };
        reservations.set(reservationId, reservation);
        appendEvent("RESERVATION_CREATED", {
          operationId: normalizedOperationId,
          targetId: target.targetId,
          reservationId,
          details: { finalPriceMinor: reservation.finalPriceMinor, usageUnits: reservation.usageUnits },
        });
        const response = {
          reservation: clone(reservation),
          decision: result.decision,
          bookingOutcome,
          snapshot: await snapshot(),
          replayed: false,
        };
        operations.set(normalizedOperationId, { fingerprint, response: clone(response) });
        return response;
      });
    },
    release(reservationId: unknown, operationId: unknown) {
      return mutate(async () => {
        const normalizedReservationId = String(reservationId || "").trim();
        const normalizedOperationId = String(operationId || "").trim();
        if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(normalizedOperationId)) {
          throw new DevRuntimeError(400, "IDEMPOTENCY_KEY_INVALID", "Некорректный operationId");
        }
        const fingerprint = stableDigest({ action: "release", reservationId: normalizedReservationId });
        const replay = operations.get(normalizedOperationId);
        if (replay) {
          if (replay.fingerprint !== fingerprint) {
            throw new DevRuntimeError(409, "IDEMPOTENCY_CONFLICT", "operationId уже использован");
          }
          return { ...(clone(replay.response) as JsonRecord), replayed: true };
        }
        const reservation = reservations.get(normalizedReservationId);
        if (!reservation) {
          throw new DevRuntimeError(404, "RESERVATION_NOT_FOUND", "Тестовый резерв не найден");
        }
        if (reservation.status === "ACTIVE") {
          reservation.status = "RELEASED";
          reservation.releasedAt = new Date().toISOString();
          appendEvent("RESERVATION_RELEASED", {
            operationId: normalizedOperationId,
            targetId: reservation.targetId,
            reservationId: reservation.reservationId,
            details: { usageUnits: reservation.usageUnits },
          });
        }
        const response = { reservation: clone(reservation), snapshot: await snapshot(), replayed: false };
        operations.set(normalizedOperationId, { fingerprint, response: clone(response) });
        return response;
      });
    },
    seed(count: number) {
      return mutate(() => seedUnlocked(count));
    },
    reset() {
      return mutate(async () => {
        reservations.clear();
        operations.clear();
        policySource = null;
        instance = null;
        await pinPolicy();
        return seedUnlocked(2);
      });
    },
  };
};

const readJsonBody = async (request: IncomingMessage): Promise<JsonRecord> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new DevRuntimeError(413, "REQUEST_TOO_LARGE", "Слишком большой DEV-запрос");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new DevRuntimeError(400, "REQUEST_JSON_INVALID", "Некорректный JSON");
  }
};

const sendJson = (response: ServerResponse, status: number, payload: unknown) => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
};

export const buildTournamentReadUpstreamUrl = (
  requestUrl: URL,
  baseUrlRaw?: string,
): URL => {
  const prefix = `${API_PREFIX}/tournament-read`;
  const relativePath = requestUrl.pathname.slice(prefix.length);
  if (!/^\/tournaments(?:\/[a-zA-Z0-9-]{1,64})?$/.test(relativePath)) {
    throw new DevRuntimeError(
      404,
      "DEV_TOURNAMENT_READ_PATH_DENIED",
      "DEV read-прокси разрешает только список и детали турнира",
    );
  }
  const allowedQueryKeys = new Set(["date", "from", "to"]);
  if ([...requestUrl.searchParams.keys()].some((key) => !allowedQueryKeys.has(key))) {
    throw new DevRuntimeError(
      400,
      "DEV_TOURNAMENT_READ_QUERY_DENIED",
      "DEV read-прокси отклонил небезопасный параметр турнира",
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw || DEFAULT_TOURNAMENT_READ_BASE_URL);
  } catch {
    throw new DevRuntimeError(503, "DEV_TOURNAMENT_READ_BASE_INVALID", "DEV read-прокси настроен неверно");
  }
  if (baseUrl.protocol !== "https:"
    || baseUrl.origin !== "https://lk-reserve.89-108-64-209.sslip.io"
    || baseUrl.pathname.replace(/\/+$/, "") !== "/api"
    || baseUrl.search
    || baseUrl.hash) {
    throw new DevRuntimeError(
      503,
      "DEV_TOURNAMENT_READ_BASE_DENIED",
      "DEV read-прокси не относится к изолированному backend",
    );
  }
  const upstreamUrl = new URL(`${baseUrl.origin}/api${relativePath}`);
  requestUrl.searchParams.forEach((value, key) => upstreamUrl.searchParams.set(key, value));
  return upstreamUrl;
};

const proxyTournamentRead = async (
  requestUrl: URL,
  response: ServerResponse,
  baseUrlRaw: string | undefined,
) => {
  const upstreamUrl = buildTournamentReadUpstreamUrl(requestUrl, baseUrlRaw);
  const upstream = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      "X-PadlHub-Auth-Source": "lk-keycloak",
      "X-PadlHub-Tenant-Key": "iSkq6G",
    },
    signal: AbortSignal.timeout(5_000),
  });
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    throw new DevRuntimeError(502, "DEV_TOURNAMENT_READ_RESPONSE_INVALID", "DEV backend вернул неверный ответ");
  }
  sendJson(response, upstream.status, payload);
};

const assertLocalOrigin = (request: IncomingMessage) => {
  const origin = String(request.headers.origin || "");
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    throw new DevRuntimeError(403, "DEV_ORIGIN_FORBIDDEN", "DEV runtime доступен только локально");
  }
};

const normalizeShadowCounter = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(4, Math.max(0, Math.floor(parsed)));
};

const parseShadowStationIds = (value: unknown): string[] => (
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const ANNUAL_SHADOW_DEFAULT_STATION_IDS = [
  "dev-station-home",
  "dev-station-a",
  "dev-station-b",
] as const;

export const resolveAnnualShadowStationIds = (
  configuredStationIds: readonly string[],
  annualShadowFixture: boolean,
): string[] => (
  configuredStationIds.length > 0 || !annualShadowFixture
    ? [...configuredStationIds]
    : [...ANNUAL_SHADOW_DEFAULT_STATION_IDS]
);

const parseShadowJoinFixtures = (
  value: unknown,
): Map<string, SubscriptionUsageShadowJoinFixture> => {
  if (!value) return new Map();
  try {
    const parsed = asRecord(JSON.parse(String(value)));
    const fixtures = new Map<string, SubscriptionUsageShadowJoinFixture>();
    for (const [gameId, rawFixture] of Object.entries(parsed)) {
      const fixture = asRecord(rawFixture);
      const stationId = String(fixture.stationId || "").trim();
      const startsAt = String(fixture.startsAt || "").trim();
      const durationMinutes = Number(fixture.durationMinutes);
      const courtPriceMinor = Number(fixture.courtPriceMinor);
      if (!gameId.trim() || !stationId || !Number.isFinite(Date.parse(startsAt))
        || ![60, 90, 120].includes(durationMinutes)
        || !Number.isInteger(courtPriceMinor) || courtPriceMinor <= 0) {
        throw new Error(`invalid fixture ${gameId}`);
      }
      fixtures.set(gameId.trim(), {
        stationId,
        startsAt,
        durationMinutes: durationMinutes as 60 | 90 | 120,
        courtPriceMinor,
      });
    }
    return fixtures;
  } catch {
    throw new DevRuntimeError(
      503,
      "DEV_SHADOW_JOIN_CATALOG_INVALID",
      "Серверный fixture-каталог игр настроен некорректно",
    );
  }
};

const parseShadowEventFixtures = (
  value: unknown,
): Map<string, SubscriptionUsageShadowEventFixture> => {
  if (!value) return new Map();
  try {
    const parsed = asRecord(JSON.parse(String(value)));
    const fixtures = new Map<string, SubscriptionUsageShadowEventFixture>();
    for (const [eventId, rawFixture] of Object.entries(parsed)) {
      const fixture = asRecord(rawFixture);
      const action = String(fixture.action || "").trim();
      const stationId = String(fixture.stationId || "").trim();
      const startsAt = String(fixture.startsAt || "").trim();
      const durationMinutes = Number(fixture.durationMinutes);
      const basePriceMinor = Number(fixture.basePriceMinor);
      if (!eventId.trim()
        || !(["BOOK_GROUP_TRAINING", "BOOK_TOURNAMENT"] as string[]).includes(action)
        || !stationId
        || !Number.isFinite(Date.parse(startsAt))
        || ![60, 90, 120].includes(durationMinutes)
        || !Number.isInteger(basePriceMinor)
        || basePriceMinor <= 0) {
        throw new Error(`invalid fixture ${eventId}`);
      }
      fixtures.set(eventId.trim(), {
        action: action as SubscriptionUsageShadowEventFixture["action"],
        stationId,
        startsAt,
        durationMinutes: durationMinutes as 60 | 90 | 120,
        basePriceMinor,
      });
    }
    return fixtures;
  } catch {
    throw new DevRuntimeError(
      503,
      "DEV_SHADOW_EVENT_CATALOG_INVALID",
      "Серверный fixture-каталог событий настроен некорректно",
    );
  }
};

const shadowCreateFixtureKey = (intent: SubscriptionUsageShadowNewGameIntent): string => [
  intent.stationId.trim(),
  intent.roomId.trim(),
  intent.startsAt,
  String(intent.durationMinutes),
].join("|");

const parseShadowCreateFixtures = (value: unknown): Map<string, number> => {
  if (!value) return new Map();
  try {
    const parsed = asRecord(JSON.parse(String(value)));
    const fixtures = new Map<string, number>();
    for (const [key, rawPrice] of Object.entries(parsed)) {
      const courtPriceMinor = Number(rawPrice);
      if (!key.trim() || !Number.isInteger(courtPriceMinor) || courtPriceMinor <= 0) {
        throw new Error(`invalid fixture ${key}`);
      }
      fixtures.set(key.trim(), courtPriceMinor);
    }
    return fixtures;
  } catch {
    throw new DevRuntimeError(
      503,
      "DEV_SHADOW_CREATE_CATALOG_INVALID",
      "Серверный fixture-каталог слотов настроен некорректно",
    );
  }
};

export const resolveShadowIntent = ({
  action,
  intent,
  createFixtures = new Map(),
  eventFixtures = new Map(),
  stationIds,
  joinFixtures,
}: {
  action: ManagedSubscriptionAction;
  intent: SubscriptionUsageShadowIntent;
  createFixtures?: Map<string, number>;
  eventFixtures?: Map<string, SubscriptionUsageShadowEventFixture>;
  stationIds: string[];
  joinFixtures: Map<string, SubscriptionUsageShadowJoinFixture>;
}): ManagedSubscriptionDevTarget => {
  const allowedStationIds = new Set(stationIds);
  let stationId: string;
  let startsAt: string;
  let durationMinutes: 60 | 90 | 120;
  let courtPriceMinor: number;
  let targetId: string;

  if (action === "CREATE_GAME" && intent.targetKind === "NEW_GAME") {
    const identifiers = [
      intent.slotId,
      intent.stationId,
      intent.roomId,
      intent.masterServiceId,
    ];
    if (identifiers.some((value) => !String(value || "").trim())
      || !Array.isArray(intent.subServiceIds)
      || intent.subServiceIds.length === 0
      || intent.subServiceIds.length > 8
      || intent.subServiceIds.some((value) => !String(value || "").trim())
      || ![60, 90, 120].includes(Number(intent.durationMinutes))
      || !Number.isFinite(Date.parse(intent.startsAt))) {
      throw new DevRuntimeError(
        400,
        "DEV_SHADOW_TARGET_INVALID",
        "Идентификаторы выбранного слота неполны",
      );
    }
    stationId = intent.stationId.trim();
    startsAt = intent.startsAt;
    durationMinutes = intent.durationMinutes;
    const fixturePrice = createFixtures.get(shadowCreateFixtureKey(intent));
    if (fixturePrice !== undefined) {
      courtPriceMinor = fixturePrice;
    } else {
      throw new DevRuntimeError(
        404,
        "DEV_SHADOW_SLOT_PRICE_NOT_RESOLVED",
        "Цена выбранного слота отсутствует в серверном DEV-каталоге",
      );
    }
    targetId = `server-new:${stableDigest(intent).slice(0, 24)}`;
  } else if (action === "JOIN_GAME" && intent.targetKind === "GAME_AGGREGATE") {
    const gameId = String(intent.gameId || "").trim();
    const fixture = joinFixtures.get(gameId);
    if (!gameId || !fixture) {
      throw new DevRuntimeError(
        404,
        "DEV_SHADOW_GAME_NOT_RESOLVED",
        "Игра не найдена в серверном DEV-каталоге",
      );
    }
    stationId = fixture.stationId;
    startsAt = fixture.startsAt;
    durationMinutes = fixture.durationMinutes;
    courtPriceMinor = fixture.courtPriceMinor;
    targetId = `server-game:${stableDigest(gameId).slice(0, 24)}`;
  } else if ((action === "BOOK_GROUP_TRAINING" || action === "BOOK_TOURNAMENT")
    && intent.targetKind === "EVENT_AGGREGATE") {
    const eventId = String(intent.eventId || "").trim();
    const fixture = eventFixtures.get(eventId);
    if (!eventId || !fixture) {
      throw new DevRuntimeError(
        404,
        "DEV_SHADOW_EVENT_NOT_RESOLVED",
        "Событие не найдено в серверном DEV-каталоге",
      );
    }
    if (fixture.action !== action) {
      throw new DevRuntimeError(
        400,
        "DEV_SHADOW_EVENT_ACTION_MISMATCH",
        "Серверный fixture события не соответствует выбранному действию",
      );
    }
    stationId = fixture.stationId;
    startsAt = fixture.startsAt;
    durationMinutes = fixture.durationMinutes;
    courtPriceMinor = fixture.basePriceMinor;
    targetId = `server-event:${stableDigest({ action, eventId }).slice(0, 24)}`;
  } else {
    throw new DevRuntimeError(
      400,
      "DEV_SHADOW_ACTION_TARGET_MISMATCH",
      "Тип серверной цели не совпадает с действием",
    );
  }

  if (!allowedStationIds.has(stationId)) {
    throw new DevRuntimeError(
      403,
      "DEV_SHADOW_STATION_DENIED",
      "Станция не включена в серверный DEV fixture",
    );
  }
  const isGameAction = action === "CREATE_GAME" || action === "JOIN_GAME";
  const basePriceMinor = isGameAction ? Math.round(courtPriceMinor / 4) : courtPriceMinor;
  const title = action === "CREATE_GAME"
    ? `Создать игру на ${durationMinutes} минут`
    : action === "JOIN_GAME"
      ? `Присоединиться к игре на ${durationMinutes} минут`
      : action === "BOOK_GROUP_TRAINING"
        ? "Записаться на групповую тренировку"
        : "Записаться на турнир";
  return {
    targetId,
    title,
    description: "Цена и цель разрешены локальным серверным fixture-каталогом",
    action,
    courtPriceMinor,
    participantCount: isGameAction ? 4 : undefined,
    target: {
      resolutionSource: "SERVER",
      stationId,
      category: action === "BOOK_GROUP_TRAINING"
        ? "GROUP_TRAINING"
        : action === "BOOK_TOURNAMENT"
          ? "TOURNAMENT"
          : "GAME",
      externalEventTypeId: action === "BOOK_GROUP_TRAINING"
        ? "dev-group-training"
        : action === "BOOK_TOURNAMENT"
          ? "dev-tournament"
          : "dev-open-game",
      productTypeId: null,
      eventId: targetId,
      durationMinutes,
      startsAt,
      basePriceMinor,
      currency: "RUB",
    },
  };
};

export const buildShadowBookingOutcome = (
  target: ManagedSubscriptionDevTarget,
  decision: ManagedSubscriptionPolicyDecision,
) => {
  const reasonCodes = decision.blockers.map((blocker) => blocker.code);
  if (decision.eligible) {
    return {
      allowed: true,
      subscriptionApplied: true,
      pricingMode: "SUBSCRIPTION",
      finalPriceMinor: decision.benefit?.finalPriceMinor ?? target.target.basePriceMinor,
      reasonCodes,
    };
  }
  const fullPriceFallbackCodes = new Set([
    "ACTIVE_SERVICES_LIMIT_REACHED",
    "FUTURE_BOOKINGS_LIMIT_REACHED",
  ]);
  if (reasonCodes.length > 0 && reasonCodes.every((code) => fullPriceFallbackCodes.has(code))) {
    return {
      allowed: true,
      subscriptionApplied: false,
      pricingMode: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
      finalPriceMinor: target.target.basePriceMinor,
      reasonCodes,
    };
  }
  return {
    allowed: false,
    subscriptionApplied: false,
    pricingMode: "BLOCKED",
    finalPriceMinor: null,
    reasonCodes,
  };
};

export const managedSubscriptionDevPlugin = (options: {
  enabled: boolean;
  cupBaseUrl?: string;
  typeCode?: string;
  policyVersion?: number | string;
  annualShadowFixture?: boolean;
  shadowCreateFixturesJson?: string;
  shadowEventFixturesJson?: string;
  shadowStationIds?: string;
  shadowJoinFixturesJson?: string;
  tournamentReadBaseUrl?: string;
}): Plugin => ({
  name: "managed-subscription-dev-runtime",
  apply: "serve",
  configureServer(server) {
    if (!options.enabled) return;
    const shadowStationIds = resolveAnnualShadowStationIds(
      parseShadowStationIds(options.shadowStationIds),
      options.annualShadowFixture === true,
    );
    const shadowCreateFixtures = parseShadowCreateFixtures(options.shadowCreateFixturesJson);
    const shadowEventFixtures = parseShadowEventFixtures(options.shadowEventFixturesJson);
    const shadowJoinFixtures = parseShadowJoinFixtures(options.shadowJoinFixturesJson);
    const runtime = createManagedSubscriptionDevRuntime({
      policyLoader: options.annualShadowFixture
        ? async () => buildAnnualShadowPolicySource(shadowStationIds)
        : () => loadPolicyFromCup({
          baseUrl: options.cupBaseUrl,
          typeCode: options.typeCode,
          policyVersion: options.policyVersion,
        }),
    });

    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(API_PREFIX)) {
        next();
        return;
      }
      try {
        assertLocalOrigin(request);
        if (request.method === "GET"
          && url.pathname.startsWith(`${API_PREFIX}/tournament-read`)) {
          if (!options.annualShadowFixture) {
            throw new DevRuntimeError(
              503,
              "DEV_TOURNAMENT_READ_DISABLED",
              "DEV read-прокси турниров выключен",
            );
          }
          await proxyTournamentRead(url, response, options.tournamentReadBaseUrl);
          return;
        }
        if (request.method === "GET" && url.pathname === `${API_PREFIX}/session`) {
          sendJson(response, 200, await runtime.initialize());
          return;
        }
        if (request.method !== "POST") {
          throw new DevRuntimeError(405, "METHOD_NOT_ALLOWED", "Метод не поддерживается");
        }
        const body = await readJsonBody(request);
        if (url.pathname === `${API_PREFIX}/shadow-quote`) {
          if (!options.annualShadowFixture
            || shadowStationIds.length === 0) {
            throw new DevRuntimeError(
              503,
              "DEV_SHADOW_FIXTURE_DISABLED",
              "Локальный server-resolved fixture не настроен",
            );
          }
          const action = String(body.action || "") as ManagedSubscriptionAction;
          if (!([
            "CREATE_GAME",
            "JOIN_GAME",
            "BOOK_GROUP_TRAINING",
            "BOOK_TOURNAMENT",
          ] as string[]).includes(action)) {
            throw new DevRuntimeError(400, "DEV_SHADOW_ACTION_INVALID", "Действие не поддерживается");
          }
          const target = resolveShadowIntent({
            action,
            intent: asRecord(body.target) as unknown as SubscriptionUsageShadowIntent,
            createFixtures: shadowCreateFixtures,
            eventFixtures: shadowEventFixtures,
            stationIds: shadowStationIds,
            joinFixtures: shadowJoinFixtures,
          });
          const result = await runtime.quoteResolved(target, {
            activeServices: normalizeShadowCounter(body.activeServices),
            dailyGameUsage: normalizeShadowCounter(body.dailyGameUsage),
          });
          sendJson(response, 200, {
            ...result,
            bookingOutcome: buildShadowBookingOutcome(result.target, result.decision),
            resolution: {
              source: "SERVER_FIXTURE",
              providerCalls: 0,
              browserPriceAccepted: false,
            },
          });
          return;
        }
        if (url.pathname === `${API_PREFIX}/quote`) {
          sendJson(response, 200, await runtime.quote(body.targetId));
          return;
        }
        if (url.pathname === `${API_PREFIX}/reserve`) {
          sendJson(response, 200, await runtime.reserve(body.targetId, body.operationId));
          return;
        }
        if (url.pathname === `${API_PREFIX}/ordinary`) {
          sendJson(response, 200, await runtime.ordinary(body.targetId, body.operationId));
          return;
        }
        if (url.pathname === `${API_PREFIX}/release`) {
          sendJson(response, 200, await runtime.release(body.reservationId, body.operationId));
          return;
        }
        if (url.pathname === `${API_PREFIX}/seed`) {
          sendJson(response, 200, await runtime.seed(Number(body.activeServices)));
          return;
        }
        if (url.pathname === `${API_PREFIX}/reset`) {
          sendJson(response, 200, await runtime.reset());
          return;
        }
        throw new DevRuntimeError(404, "DEV_ROUTE_NOT_FOUND", "DEV-маршрут не найден");
      } catch (error) {
        const safeError = error instanceof DevRuntimeError
          ? error
          : new DevRuntimeError(500, "DEV_RUNTIME_ERROR", "DEV runtime временно недоступен");
        sendJson(response, safeError.status, {
          error: {
            code: safeError.code,
            message: safeError.message,
            details: safeError.details,
          },
        });
      }
    });
  },
});
