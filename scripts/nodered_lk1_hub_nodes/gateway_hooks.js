// HUB_HELPERS
const MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-09-01";

const MANAGED_ENFORCEMENT_PURCHASE_TIME_ZONE = "Europe/Moscow";

const isValidDateKey = (value) => {
  const matched = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const normalizePurchaseDateMoscow = (value) => {
  const text = toStr(value);
  const localDate = normalizeDate(text);
  if (!text || !localDate || !isValidDateKey(localDate)) return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const localTimestamp = text.match(
      /^\d{4}-\d{2}-\d{2}(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?$/,
    );
    if (!localTimestamp) return null;
    if (localTimestamp[1] === undefined) return localDate;
    const hour = Number(localTimestamp[1]);
    const minute = Number(localTimestamp[2]);
    const second = Number(localTimestamp[3]);
    return hour <= 23 && minute <= 59 && second <= 59 ? localDate : null;
  }
  const instant = new Date(text);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MANAGED_ENFORCEMENT_PURCHASE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const moscowDate = `${part("year")}-${part("month")}-${part("day")}`;
  return isValidDateKey(moscowDate) ? moscowDate : null;
};

const findOwnedSubscriptions = (exercise, clientSubscriptionId) => {
  const target = normalizeId(clientSubscriptionId);
  return findArrayForKey(exercise, "availableClientSubscriptions")
    .filter((item) => {
      if (!isObj(item)) return false;
      const explicitIds = [
        item.clientSubscriptionId,
        item.subscriptionId,
        item.clientSubId,
        item.clientSubscription?.id,
        item.clientSubscription?.clientSubscriptionId,
        item.clientSub?.id,
      ].map(normalizeId).filter(Boolean);
      if (explicitIds.length > 0) return explicitIds.includes(target);
      return [item.id, item.uuid].map(normalizeId).filter(Boolean).includes(target);
    });
};

const collectSubscriptionPurchaseDateEvidence = (value) => {
  const records = Array.isArray(value) ? value.filter(isObj) : isObj(value) ? [value] : [];
  const normalizedDates = records.flatMap((record) => {
    const aliases = [record.purchaseAt, record.purchaseDate]
      .filter((date) => date !== null && date !== undefined && String(date).trim());
    return aliases.length > 0
      ? aliases.map(normalizePurchaseDateMoscow)
      : [null];
  });
  return {
    dates: [...new Set(normalizedDates.filter(Boolean))].sort(),
    invalid: normalizedDates.some((date) => date === null),
  };
};

const exerciseRoomId = (exercise) => toStr(
  exercise?.room?.id || exercise?.roomId || exercise?.court?.id || exercise?.courtId,
);

const lk1MongoMatched = (value) => {
  const keys = ["acknowledged", "matchedCount", "modifiedCount", "upsertedCount", "upsertedId"];
  if (!isObj(value) || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))
    || value.acknowledged !== true || ![0, 1].includes(value.matchedCount)
    || ![0, 1].includes(value.modifiedCount) || value.modifiedCount > value.matchedCount
    || value.upsertedCount !== 0 || value.upsertedId !== null) return null;
  return value.matchedCount;
};

const lk1MongoInserted = (value, expectedId) => isObj(value)
  && Object.keys(value).length === 2 && value.acknowledged === true
  && typeof value.insertedId === "string" && value.insertedId === expectedId;

// HUB_COURT_WINDOW
// The club co-pay of «Дружба Топократы» (directions 6233 training and 6180 game) is charged
// against the HOURLY court price (owner decision 2026-10-05). The only server-owned money a
// booking can prove is the whole total of a station+room+window master-service price lookup,
// so the hub performs the same lookup the split game already performs for its ordinary share
// and keeps the verified window total. `lk1Quote` derives the hourly price from it
// (`total x 60 / durationMinutes`), never from the exercise one-time tariff. A station whose
// master service is not resolvable stays unresolved and the club charge fails closed with
// `LK1_COURT_PRICE_UNRESOLVED`; nothing here falls back to the tariff that produced the 500 P
// co-pay. A static station table (the same one the onboarding node publishes) answers in one
// request and the resolved pair is cached per station, because the mapping is static.
const lk1CourtMasterServices = Object.freeze({
  "6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1": { masterServiceId: "2f4155ad-7bc0-4a15-a12c-da7fce15c37a", subServiceId: "415edff9-b4ad-4d88-8709-75f1ab7d4081" },
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab": { masterServiceId: "e2caa535-6660-479a-bd32-3638ba7f6b89", subServiceId: "96d2179a-5a96-41bd-a0c9-1df9e5890e16" },
  "6b2d7e60-caff-4b22-89f6-6f19d7d311ab": { masterServiceId: "22b928b2-1ba6-4491-bc43-756676fcd723", subServiceId: "4d1df04c-774f-46ff-93bd-fd1cca0cb1c4" },
  "42c6d4df-833d-480a-bdc8-986716569884": { masterServiceId: "1c54e3b4-0421-482e-8faf-0c1cd5fdaf3d", subServiceId: "59fdd182-ce16-4c37-a814-a45cb026d24d" },
  "588b6151-f4f5-47d9-9449-80edf8cbc748": { masterServiceId: "d9a5061a-e027-4960-9029-4bf5ec8a0c64", subServiceId: "2689586b-e7f6-4389-bdd2-5c1a35d4c0e7" },
  "3656cbaa-6426-490f-a44f-915404cbdd2b": { masterServiceId: "cf54da75-52dd-48bb-861e-c6d53abc052a", subServiceId: "8fd8fe7b-9563-4b56-836c-1b63fe4698f5" },
  "1ea77cbf-bc36-49a1-96d6-f35c216a409b": { masterServiceId: "899db365-5286-43f6-a3a4-efcf406a28eb", subServiceId: "6a16a7a8-db84-422d-b5f8-5fd00fe0d54c" },
  "233c1405-1eac-40de-8ec6-1cf7e24c9276": { masterServiceId: "86e13da6-2282-4daf-9239-c0cd3ddefaf7", subServiceId: "50d7e7a0-39ea-4ccd-a912-a6ddb77fa3ed" },
});
const LK1_COURT_WINDOW_CACHE_PREFIX = "subscriptions_lk1_court_service:";
const lk1CourtWindowClubProductId = "14692232-12be-4218-9fa1-2d5b79b62035";
const lk1CourtWindowClubDirections = [6233, 6180];
const lk1CourtWindowId = (value) => {
  const text = toStr(value);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(text) ? text : null;
};
// The master service is answered from the reviewed table so the hub needs no extra round trip;
// `global` only allows a future station to be resolved once without a code change. An unknown
// station stays unresolved: the price is never guessed from the event tariff.
const lk1CourtWindowService = (stationId, roomId) => {
  const mapped = stationId ? lk1CourtMasterServices[toStr(stationId)] || null : null;
  if (mapped && lk1CourtWindowId(mapped.masterServiceId) && lk1CourtWindowId(mapped.subServiceId)) {
    return { masterServiceId: mapped.masterServiceId, subServiceIds: [mapped.subServiceId] };
  }
  try {
    const raw = global.get(`${LK1_COURT_WINDOW_CACHE_PREFIX}${toStr(stationId)}`);
    const cached = typeof raw === "string" ? JSON.parse(raw) : null;
    if (isObj(cached) && cached.roomId === toStr(roomId) && lk1CourtWindowId(cached.masterServiceId)
      && Array.isArray(cached.subServiceIds) && cached.subServiceIds.length === 1
      && lk1CourtWindowId(cached.subServiceIds[0])) {
      return { masterServiceId: cached.masterServiceId, subServiceIds: [cached.subServiceIds[0]] };
    }
  } catch (_) { /* unresolved */ }
  return { masterServiceId: null, subServiceIds: [] };
};
const lk1CourtWindowTime = (exercise, kind) => {
  const text = toStr(kind === "from" ? exercise?.timeFrom : exercise?.timeTo);
  const clock = text && text.length >= 16 && text[10] === "T" ? text.slice(11, 16) : null;
  return clock && /^([01]\d|2[0-3]):[0-5]\d$/.test(clock) ? clock : null;
};
const lk1CourtWindowDate = (exercise) => {
  const text = toStr(exercise?.timeFrom);
  return text && text.length >= 10 ? text.slice(0, 10) : null;
};
const lk1CourtWindowUrl = (service, stationId, roomId, exercise) => {
  const date = lk1CourtWindowDate(exercise);
  const fromTime = lk1CourtWindowTime(exercise, "from");
  const toTime = lk1CourtWindowTime(exercise, "to");
  if (!service.masterServiceId || !service.subServiceIds.length || !date || !fromTime || !toTime) return null;
  return `${VIVA_API_BASE}/api/v1/studios/${encodeURIComponent(stationId)}`
    + `/rooms/${encodeURIComponent(roomId)}/sub-services/${encodeURIComponent(service.subServiceIds[0])}/price`
    + `?fromDate=${encodeURIComponent(date)}&fromTime=${encodeURIComponent(fromTime)}`
    + `&toTime=${encodeURIComponent(toTime)}&size=100`;
};
// The club co-pay needs the hour of court for the training direction 6233 and for the club
// game direction 6180 alike (owner decision 2026-10-05), and only for those directions: a club
// tournament keeps its configured discount and must not pay for a court hour. The price is
// fetched once per request: a target that already carries the hour (or a proof that already
// carries the whole window) is left alone, so a resumed request is priced from the same evidence.
const lk1CourtWindowNeeded = (ctx) => {
  if (!ctx.lk1 || !ctx.lk1TariffProof) return false;
  if (toStr(ctx.lk1.rule?.productId)?.toLowerCase() !== lk1CourtWindowClubProductId) return false;
  if (!["GROUP_TRAINING", "GAME"].includes(ctx.lk1.target?.category)) return false;
  if (!lk1CourtWindowClubDirections.includes(Number(ctx.lk1.target?.directionId))) return false;
  if (Number.isSafeInteger(ctx.lk1.target?.hourlyCourtPriceMinor)
    && ctx.lk1.target.hourlyCourtPriceMinor > 0) return false;
  return !(Number.isSafeInteger(ctx.lk1TariffProof.windowTotalMinor)
    && ctx.lk1TariffProof.windowTotalMinor > 0);
};
// Viva's master-service total is in rubles, as in the exact split price contract. Convert once
// to minor units before deriving the court hour. The response is not repeated against identity:
// request URL already binds station, room and window, and the step that consumes this payload
// has proved the URL it answered. The ceiling keeps a malformed or promotional payload from
// entering the shared arithmetic as an absurd amount.
const lk1CourtWindowTotal = (payload) => {
  if (!isObj(payload)) return null;
  const amount = payload.total;
  if (!((typeof amount === "number" && Number.isFinite(amount))
    || (typeof amount === "string" && /^\d+(?:\.\d{1,2})?$/.test(amount)))) return null;
  const rubles = Number(amount);
  const total = Math.round(rubles * 100);
  if (Math.abs(rubles * 100 - total) > 1e-7) return null;
  if (!Number.isSafeInteger(total) || total <= 0 || total > 10_000_000) return null;
  return total;
};

// HUB_PROFILE
// HTTP and split ingress rebuild server contexts from explicit allowlists.
// Never honor a client-supplied skip/read-complete marker at profile entry.
delete ctx.lk1IngressReplay;
delete ctx.lk1Rejoin;
const split = msg._splitCtx;
const approval = split?.lk1ReadOnlyApproval;
const internalCreate = ctx.lk1BeforeCreate === true || ctx.lk1CreateBinding !== undefined
  || (ctx.caller === "split" && approval !== undefined);
if (internalCreate) {
  const key = `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`;
  const common = ctx.caller === "split" && ctx.managedAction === "CREATE_GAME"
    && split?.action === "create" && split.subscriptionCreatePreflightDone === true
    && split.operationId === ctx.operationId && split.clientSubscriptionId === ctx.clientSubscriptionId
    && approval?.operationId === ctx.operationId && approval.actorClientId === ctx.actorClientId
    && approval.clientSubscriptionId === ctx.clientSubscriptionId
    && JSON.stringify(approval.createPayload) === JSON.stringify(ctx.lk1CreatePayload);
  const before = common && ctx.lk1BeforeCreate === true
    && split.step === "subscription_create_preflight_complete"
    && ctx.lk1ApprovedActor === ctx.actorClientId && !split.exerciseId && split.ownsExercise !== true
    && !ctx.lk1CreateBinding && !split.lk1CreateBinding && ctx.exerciseId === `preflight:${ctx.operationId}`;
  const after = common && ctx.lk1BeforeCreate !== true && split.step === "create_exercise"
    && split.ownsExercise === true && split.lk1CreateDispatchUsed === true
    && ctx.exerciseId === split.exerciseId && typeof ctx.exerciseId === "string"
    && !ctx.exerciseId.startsWith("preflight:") && ctx.lk1CreateBinding?.operationKey === key
    && split.lk1CreateBinding?.operationKey === key
    && typeof ctx.lk1CreateBinding.fingerprint === "string"
    && ctx.lk1CreateBinding.fingerprint === split.lk1CreateBinding.fingerprint;
  if (!before && !after) return lk1Stop(ctx, "LK1_CREATE_CONTINUATION_UNBOUND");
} else if (ctx.action !== "release") {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(ctx.operationId || "")
    || typeof ctx.tenantKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(ctx.tenantKey)) {
    return lk1Stop(ctx, "LK1_REQUEST_IDENTITY_INVALID");
  }
  ctx.lk1IngressReplay = true;
  return lk1Find(ctx, "lk1_ingress_operation_find", {
    _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`,
  });
}
ctx.step = "lk1_profile_continue";
// The club co-pay needs one more server-owned number than the event tariff: the whole price
// of the event's court window. It is proved before the ownership readback, so every later
// step (including the stored fingerprint) prices the same target.
if (ctx.lk1 && ctx.actorClientId && lk1CourtWindowNeeded(ctx)) {
  return startLk1CourtWindowFetch(ctx);
}

// HUB_COURT_WINDOW_RESPONSE
// The court-window proof sits beside the tariff steps because it is the same kind of evidence:
// one server GET, bound to the event's station, room and window and consumed through
// `lk1Quote`. A club game already proves its window through the split master-service price
// lookup (`lk1TariffProof.windowTotalMinor`), so only a club event without that proof fetches
// here. Every failed or ambiguous answer refuses with `LK1_COURT_PRICE_UNRESOLVED`.
const lk1CourtWindowEndTime = (exercise) => {
  const clock = lk1CourtWindowTime(exercise, "from");
  const duration = Number(exercise?.durationMinutes);
  if (!clock || !Number.isInteger(duration) || duration <= 0) return null;
  const [hour, minute] = clock.split(":").map(Number);
  const end = hour * 60 + minute + duration;
  const endHour = String(Math.floor(end / 60) % 24).padStart(2, "0");
  const endMinute = String(end % 60).padStart(2, "0");
  return `${endHour}:${endMinute}`;
};
function startLk1CourtWindowFetch(ctx) {
  const proof = isObj(ctx.lk1TariffProof) ? ctx.lk1TariffProof : null;
  const exercise = ctx.lk1CourtExercise || (proof
    ? { id: ctx.exerciseId, timeFrom: proof.startsAt, timeTo: lk1CourtWindowEndTime(proof),
      durationMinutes: proof.durationMinutes, roomId: proof.roomId, studioId: proof.stationId }
    : null);
  const stationId = toStr(ctx.studioId || exercise?.studioId);
  const roomId = toStr(ctx.roomId || exercise?.roomId || exerciseRoomId(exercise));
  const service = lk1CourtWindowService(stationId, roomId);
  const url = service.masterServiceId && service.subServiceIds.length && exercise
    ? lk1CourtWindowUrl(service, stationId, roomId, exercise) : null;
  if (!lk1CourtWindowId(stationId) || !lk1CourtWindowId(roomId) || !url) {
    return lk1Stop(ctx, "LK1_COURT_PRICE_UNRESOLVED");
  }
  ctx.lk1CourtExercise = exercise;
  ctx.lk1CourtService = service;
  ctx.step = "lk1_court_window";
  return prepareAdminGet(ctx, "lk1_court_window", url);
}
if (ctx.step === "lk1_court_window") {
  const exercise = ctx.lk1CourtExercise;
  const service = isObj(ctx.lk1CourtService) ? ctx.lk1CourtService
    : lk1CourtWindowService(ctx.studioId, ctx.roomId);
  const requestedUrl = lk1CourtWindowUrl(service, toStr(ctx.studioId), toStr(ctx.roomId), exercise);
  if (!isHttpOk(msg.statusCode) || !requestedUrl
    || (msg.url !== undefined && msg.url !== requestedUrl)
    || (msg.responseUrl !== undefined && msg.responseUrl !== requestedUrl)) {
    return lk1Stop(ctx, "LK1_COURT_PRICE_UNRESOLVED");
  }
  const total = lk1CourtWindowTotal(msg.payload);
  if (total === null) return lk1Stop(ctx, "LK1_COURT_PRICE_UNRESOLVED");
  return lk1CourtWindowStoreProof(ctx, exercise, total);
}
function lk1CourtWindowStoreProof(ctx, exercise, total) {
  const durationMinutes = eventDurationMinutes(exercise);
  const startsAt = eventStartsAt(exercise);
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(durationMinutes)
    || durationMinutes <= 0 || !startsAt || !Number.isFinite(Date.parse(startsAt))) {
    return lk1Stop(ctx, "LK1_COURT_PRICE_UNRESOLVED");
  }
  ctx.lk1TariffProof = { ...(isObj(ctx.lk1TariffProof) ? ctx.lk1TariffProof : {}),
    source: "VIVA_EXISTING_TARIFF", windowTotalMinor: total,
    stationId: toStr(ctx.studioId), roomId: toStr(ctx.roomId),
    durationMinutes, startsAt, observedAt: Date.now() };
  delete ctx.lk1CourtExercise;
  delete ctx.lk1CourtService;
  ctx.step = "profile";
  return false;
}

// HUB_EXERCISE
// Resolve the instance first. PRO monetary eligibility is checked only after fresh
// actor-bound ownership below, since Viva may omit it from visit eligibility.
const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
const proTrainingEnergyAllowed = selectedOwned.length === 1
  && isProTrainingEnergyPack(selectedOwned[0]);
// A Topokraty event is outside every non-club subscription. Viva scopes a sold plan to its
// own directions and exercise types, so carrying «РА», «Академия» or «Дружба» to direction
// 6180 «Топократы игра» or 6233 «Топократы тренировка» is refused by the provider with
// 400 BAD_REQUEST after the contour has already promised the benefit. The club product
// «Дружба Топократы» keeps its own plan rule (the club game visit mechanism and the
// quarter-of-court co-pay on the training) and is therefore the only owned row allowed here;
// every other attempt is refused before the write and the event stays bookable as a one-off.
// The gate covers both categories: the club game direction resolves to `open_game`, not
// `group_training`, so it is matched explicitly instead of relying on the category alone.
if (["group_training", "open_game"].includes(resolveCategory(exercise))
  && isTopokratyExercise(exercise)
  && !(selectedOwned.length === 1 && isTopokratyClubPack(selectedOwned[0]))) {
  return finishError(ctx, 409,
    "На занятия Топократов общие подписки не действуют: доступна разовая оплата или клубная подписка «Дружба Топократы»", {
      code: "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE",
    });
}
// The selected instance is resolved first: it carries the product identity and the
// sale date of the concrete subscription, not of a sibling the client also owns.
// The booking target's station is part of the contour verdict: an excluded station keeps
// the pre-rollout path and must not enter the managed branch below.
const selectedRule = lk1Config(selectedOwned, exercise?.studio?.id || exercise?.studioId || null);
const enforcedRule = selectedRule.matched && !selectedRule.legacy;
// The product identity was confirmed by the server before this exercise read.
// Every Patriots money benefit needs a fresh general-list ownership and rule read,
// even when Viva does not offer the subscription for visit redemption here.
const patriotsMoneyOnlyIdentity = ctx.caller === "http"
  && ["group_training", "tournament"].includes(resolveCategory(exercise))
  && String(ctx.lk1ProductIdentity?.productId || "").trim().toLowerCase() === "37ab3713-4431-4815-96ba-d7ece76a9241"
  && identityBound(ctx);
let ruleConfigured = false;
try { ruleConfigured = Boolean(lk1ReadPlanRules() || global.get(LK1_PRODUCT_POLICY_GLOBAL)); } catch (_) { /* absent */ }
if (ctx.caller === "http" && ["group_training", "tournament"].includes(resolveCategory(exercise))
    && (patriotsMoneyOnlyIdentity || ruleConfigured) && ctx.lk1MoneyReadbackPhase !== "exercise"
    && (patriotsMoneyOnlyIdentity || selectedOwned.length === 0 || enforcedRule)) {
    ctx.lk1MoneyExercise = exercise;
    ctx.lk1MoneyReturnStep = "exercise";
    return prepareUserGet(ctx, "lk1_money_owned_subscriptions",
      `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
  }
const ownedSubscriptions = lk1QuoteOwned(ctx, exercise);
if (ownedSubscriptions.length === 0) {
    return finishError(ctx, 409, "Выбранный абонемент недоступен этому пользователю для упражнения", {
      code: "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE",
    });
  }
const productRule = lk1Config(ownedSubscriptions, exercise?.studio?.id || exercise?.studioId || null);
if (resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)
  && !proTrainingEnergyAllowed
  && !(productRule.matched && !productRule.legacy && !productRule.code
    && isProTrainingDiscountRule(productRule.rule))) {
  return finishError(ctx, 409, "На ПРО-тренировки доступна скидка 50% по РА или Академии, разовая оплата или Энергия 5/25", {
    code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE",
  });
}
// A legacy cohort is not a rule change: it stays out of the managed contour.
if ((ctx.lk1BeforeCreate === true || ctx.lk1CreateBinding) && !productRule.matched
  && !productRule.legacy) {
  return lk1Stop(ctx, "LK1_PRODUCT_RULE_CHANGED");
}
if (productRule.matched && !productRule.legacy) {
    ctx.managedAction = managedActionForTarget({ ...ctx, category: resolveCategory(exercise) });
    const quote = lk1Quote(ctx, exercise, ownedSubscriptions);
    if ((ctx.lk1BeforeCreate === true || ctx.lk1CreateBinding) && quote.legacy === true) {
      return lk1Stop(ctx, "LK1_CREATE_COHORT_CHANGED");
    }
    if (quote.code === "LK1_EVENT_TARIFF_UNVERIFIED" && !ctx.lk1TariffProof
      && ctx.caller === "http" && ["BOOK_GROUP_TRAINING", "BOOK_TOURNAMENT"].includes(ctx.managedAction)) {
      ctx.lk1TariffExercise = exercise;
      return prepareUserGet(ctx, "lk1_event_tariff",
        `/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`);
    }
    if (quote.code === "LK1_EVENT_TARIFF_UNVERIFIED" && !ctx.lk1TariffProof
      && ["split", "split_create_readonly_preflight"].includes(ctx.caller)) {
      // Product ownership and sale cohort have been established, but no write
      // may precede the existing authenticated master-service price pipeline.
      ctx.step = "lk1_tariff_required";
      msg.statusCode = 200;
      msg.payload = { state: "LK1_TARIFF_REQUIRED", operationId: ctx.operationId };
      return emit(OUTPUT_FINAL);
    }
    if (quote.code) {
      // The money-evidence refusal is the one stop that can mean "the mandate was not
      // proven in this pass" (for example a resumed operation whose readback phase is
      // already recorded). Name the state instead of only the code; the verdict is the
      // same and every other code keeps the previous `{ code }` body.
      const observed = quote.code === "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN"
        ? { stage: "money_evidence",
          evidencePresent: isObj(ctx.lk1MoneyOwnership),
          readbackPhase: typeof ctx.lk1MoneyReadbackPhase === "string" ? ctx.lk1MoneyReadbackPhase.slice(0, 32) : null,
          selectedOwned: selectedOwned.length,
          eventCategory: resolveCategory(exercise) }
        : undefined;
      return lk1Stop(ctx, quote.code, observed);
    }
    if (!quote.legacy) {
      if (ctx.caller === "split_create_readonly_preflight") {
        // Advisory only. Durable allowance is resolved by the mutating detour.
        ctx.lk1ReadOnlyQuote = quote;
        return prepareOperationFind(ctx);
      }
      ctx.lk1 = quote;
      ctx.serviceDate = eventDate(exercise);
      ctx.category = resolveCategory(exercise);
      ctx.studioId = quote.target.stationId;
      ctx.managedAction = managedActionForTarget(ctx);
      ctx.managedEnforcement = { enabled: false };
      ctx.planKey = "friendship";
      if (!ctx.managedAction || !/^[A-Za-z0-9._:-]{8,200}$/.test(ctx.operationId || "")) {
        return lk1Stop(ctx, "LK1_REQUEST_IDENTITY_INVALID");
      }
      // Per-request identity: never overwrite a former booking's minutes or
      // transaction when another booking shares its subscription/day.
      ctx.operationKey = `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`;
      return lk1Find(ctx, "lk1_operation_find", { _id: ctx.operationKey });
    }
  }

// HUB_RECHECK
if (ctx.lk1) {
    if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, "LK1_PREWRITE_READ_UNAVAILABLE");
    const exercise = unwrapRecord(msg.payload);
    if (ctx.lk1MoneyOwnership && ctx.lk1MoneyReadbackPhase !== "exercise_recheck") {
      ctx.lk1MoneyExercise = exercise;
      ctx.lk1MoneyReturnStep = "exercise_recheck";
      return prepareUserGet(ctx, "lk1_money_owned_subscriptions",
        `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
    }
    const quote = exercise && lk1Quote(ctx, exercise, lk1QuoteOwned(ctx, exercise));
    if (!quote || quote.code || quote.fingerprint !== ctx.lk1.fingerprint) {
      return lk1Stop(ctx, "LK1_RULE_PRICE_OR_TARGET_CHANGED_BEFORE_WRITE");
    }
    if (ctx.lk1TariffProof?.kind === "EVENT_ONE_TIME") {
      ctx.lk1TariffExercise = exercise;
      ctx.lk1TariffRecheck = true;
      return prepareUserGet(ctx, "lk1_event_tariff",
        `/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`);
    }
    return prepareBookingCreate(ctx);
  }

// HUB_HISTORY
if (ctx.lk1 && ctx.action !== "release") {
    if (bookings.some((booking) => !isObj(booking) || !bookingId(booking)
      || (bookingClientId(booking) && normalizeId(bookingClientId(booking)) !== normalizeId(ctx.actorClientId)))) {
      return lk1Stop(ctx, "LK1_ACTOR_BOOKINGS_UNRESOLVED");
    }
    ctx.lk1.bookings = bookings;
    ctx.lk1.activeBookings = mergeBookings(activeBookingsPayload, []).filter((booking) => !isInactiveBooking(booking));
    return lk1Find(ctx, "lk1_usage_operations", { tenantKey: ctx.tenantKey,
      actorClientId: ctx.actorClientId,
      "lk1.rule.productId": ctx.lk1.rule.productId });
  }

// HUB_CONFIRMATION
if (ctx.lk1) {
    if (!lk1BookingSelfReadback(ctx)) return lk1Stop(ctx, "LK1_BOOKING_READBACK_UNVERIFIED");
    if (!isHttpOk(msg.statusCode) || !hasCompleteBookingList(msg.payload)) return lk1Stop(ctx, "LK1_BOOKING_READBACK_UNAVAILABLE");
    const expectedBookingId = ctx.immediateBookingId || ctx.confirmedBookingId;
    if (!expectedBookingId) return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
    const matches = extractItems(msg.payload).filter((booking) => isObj(booking)
      && normalizeId(bookingId(booking)) === normalizeId(expectedBookingId)
      && !isInactiveBooking(booking) && normalizeId(bookingExerciseId(booking)) === normalizeId(ctx.exerciseId)
      && lk1BookingOwnerMatches(booking, ctx.actorClientId)
      && (!lk1EventMoneyBooking(ctx) || lk1BookingUnpaidOnPlace(booking))
      && (ctx.lk1.decision.subscriptionVisitCount === 1
        && (ctx.managedAction !== "JOIN_GAME" || ctx.lk1.decision.benefit.finalPriceMinor === 0)
        ? normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId)
          && isSubscriptionBooking(booking) && (booking.count === undefined || booking.count === 1)
        : !isSubscriptionBooking(booking)
          && String(booking.paymentType || booking.paymentMethod || "").trim().toUpperCase() === "ON_PLACE"));
    if (matches.length !== 1 || !bookingId(matches[0])) {
      return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
    }
    return lk1NeedsVisitJob(ctx) ? prepareVisitConfirmedUpdate(ctx, matches[0]) : prepareConfirmedUpdate(ctx, matches[0]);
  }

// HUB_PREACCEPT
if (ctx.lk1 && ctx.lk1BeforeCreate === true) {
    ctx.lk1.createAttemptedAt = now.toISOString();
    return prepareMongoUpdate(ctx, "lk1_create_attempt_saved", {
      _id: ctx.operationKey, operationId: ctx.operationId, state: "PREPARED",
      "lk1.createAttemptedAt": { $exists: false },
    }, { $set: { state: "PENDING_CONFIRMATION", "lk1.createAttemptedAt": ctx.lk1.createAttemptedAt,
      updatedAt: now.toISOString() }, $unset: { leaseUntil: "" }, $inc: { attempts: 1 } });
  }

// HUB_BOOKING
if (ctx.lk1 && (ctx.lk1.decision.subscriptionVisitCount === 0
    || (ctx.managedAction === "JOIN_GAME" && ctx.lk1.decision.benefit.finalPriceMinor > 0))) {
    payload.paymentType = "ON_PLACE";
    delete payload.clientSubscriptionId;
  }
