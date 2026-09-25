const isObj = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const toNonNegativeInt = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};
const toFiniteDate = (value) => {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
};
// The product of the matched rule arrives from the resolver; this node only
// validates its shape and never recognises a particular HUB/plan product itself.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const floorRatio = (amount, numerator, denominator) => {
  const normalizedAmount = toNonNegativeInt(amount);
  const normalizedNumerator = toNonNegativeInt(numerator);
  const normalizedDenominator = toNonNegativeInt(denominator);
  if (normalizedAmount === null || normalizedNumerator === null
    || !normalizedDenominator) return null;
  const result = BigInt(normalizedAmount) * BigInt(normalizedNumerator)
    / BigInt(normalizedDenominator);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
};

// «Дружба Топократы» (Viva product `14692232-…`) carries the five standard friendship
// numbers, and its club training direction 6233 is covered like an open game: the shared
// free hour of the day (60 minutes) is spent first and one visit is consumed, while the
// minutes above it are charged at a quarter of the event's court price, pro rata to the
// event duration. When no free hour is available — the day's 60 minutes are already spent
// or the active-booking cap is reached — the training is paid at its full one-time price
// and consumes no visit (owner decision 2026-09-26).
const TOPOKRATY_FRIENDSHIP_PRODUCT_ID = "14692232-12be-4218-9fa1-2d5b79b62035";
const TOPOKRATY_TRAINING_DIRECTION_IDS = [6233];
const TOPOKRATY_TRAINING_COURT_PAY_PERCENT = 25;
const TOPOKRATY_TRAINING_DISCOUNT_PERCENT = 100 - TOPOKRATY_TRAINING_COURT_PAY_PERCENT;
// The rule is bound to the product that owns the selected instance, never to the client's
// payload: the resolver's `policyProductId` is the only product identity this node trusts.
// The direction is read through the aliases the booking target and the raw Viva exercise
// both use, so a generation that carries the exercise instead of the resolved target cannot
// silently fall back to the ordinary discount.
const topokratyDirectionId = (target) => {
  const rawDirection = target?.direction ?? target?.exerciseDirection;
  const nested = isObj(rawDirection) ? rawDirection : null;
  const value = nested ? (nested.id ?? nested.directionId) : rawDirection;
  return toNonNegativeInt(value ?? target?.directionId ?? target?.exerciseDirectionId);
};
const isTopokratyTrainingBenefit = (binding, target) => {
  if (!isObj(binding)
    || toStr(binding.policyProductId)?.toLowerCase() !== TOPOKRATY_FRIENDSHIP_PRODUCT_ID) return false;
  return TOPOKRATY_TRAINING_DIRECTION_IDS.includes(topokratyDirectionId(target));
};
// The subscription's free-minute bucket is a Moscow calendar day, exactly as for a game.
const moscowLocalDate = (value) => {
  const date = toFiniteDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

const input = isObj(msg._managedSubscriptionPolicyInput)
  ? msg._managedSubscriptionPolicyInput
  : null;
const policy = isObj(input?.policy) ? input.policy : null;
const instance = isObj(input?.instance) ? input.instance : null;
const target = isObj(input?.target) ? input.target : null;
const usage = isObj(input?.usage) ? input.usage : null;
const blockers = [];
const blockerCodes = new Set();

const block = (code, message, details = null) => {
  if (blockerCodes.has(code)) return;
  blockerCodes.add(code);
  blockers.push({ code, message, details: isObj(details) ? details : null });
};

const evaluatedAt = toFiniteDate(input?.evaluatedAt);
const decision = {
  eligible: false,
  policyVersion: toNonNegativeInt(policy?.policyVersion),
  blockers,
  usageUnits: null,
  activeServices: toNonNegativeInt(usage?.activeServices),
  maxActiveServices: policy?.activeServicesLimit?.enabled === true
    ? toNonNegativeInt(policy?.activeServicesLimit?.max)
    : null,
  dailyUsed: toNonNegativeInt(usage?.dailyUsed),
  dailyLimit: toNonNegativeInt(policy?.dailyUsageLimit),
  aboveActiveLimit: false,
  benefit: null,
  evaluatedAt: evaluatedAt?.toISOString() || new Date(0).toISOString(),
};

const finish = () => {
  decision.eligible = blockers.length === 0;
  msg._managedSubscriptionPolicyDecision = decision;
  return decision.eligible ? [msg, null] : [null, msg];
};

const selectBenefit = () => {
if (input && Object.prototype.hasOwnProperty.call(input, "lk1Policy")) {
  if (!isObj(input.lk1Policy)) {
    block("LK1_POLICY_INVALID", "Пять полей правила подписки должны быть настроены корректно");
    return { selectedRule: null, surchargeMinor: 0, category: null };
  }
  const rule = input.lk1Policy;
  const category = toStr(target?.category);
  const duration = toNonNegativeInt(target?.durationMinutes);
  const fields = ["maxActiveBookings", "freeGameMinutesPerDay",
    "gameOverageDiscountPercent", "groupTrainingDiscountPercent", "tournamentDiscountPercent"];
  if (fields.some((key) => !Number.isSafeInteger(rule[key]) || rule[key] < 0)
    || rule.maxActiveBookings < 1
    || fields.slice(2).some((key) => rule[key] > 100)) {
    block("LK1_POLICY_INVALID", "Пять полей правила подписки должны быть настроены корректно");
    return { selectedRule: null, surchargeMinor: 0, category };
  }
  const expectedCategory = { CREATE_GAME: "GAME", JOIN_GAME: "GAME",
    BOOK_GROUP_TRAINING: "GROUP_TRAINING", BOOK_TOURNAMENT: "TOURNAMENT" }[input.action];
  if (!expectedCategory || category !== expectedCategory || !duration
    || target?.resolutionSource !== "SERVER" || target.currency !== "RUB"
    || !evaluatedAt || !toFiniteDate(target.startsAt)) {
    block("TARGET_NOT_SERVER_RESOLVED", "Параметры записи должны быть подтверждены сервером");
  }
  const productBound = Object.prototype.hasOwnProperty.call(input, "lk1ProductBinding");
  if (productBound) {
    const binding = input.lk1ProductBinding;
    const opaqueId = (value) => typeof value === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value);
    if (!isObj(binding) || typeof binding.policyProductId !== "string"
      || !UUID_PATTERN.test(binding.policyProductId)
      || binding.ownedProductId !== binding.policyProductId || !opaqueId(binding.clientSubscriptionId)) {
      block("LK1_PRODUCT_BINDING_INVALID", "Товар правила не совпал с принадлежащим клиенту абонементом Viva");
    }
    if (target?.priceSource !== "VIVA_EXISTING_TARIFF"
      || !Number.isSafeInteger(target?.basePriceMinor) || target.basePriceMinor < 0) {
      block("BASE_PRICE_UNRESOLVED", "Текущая стоимость события Viva не подтверждена");
    }
  } else if (target?.basePriceMinor !== 1_000_000) {
    // Preserve the earlier unwired projection contract; do not mistake its
    // historical 10k carrier input for a newly verified event tariff.
    block("BASE_PRICE_UNRESOLVED", "Существующая услуга 10 000 рублей не подтверждена");
  }
  if (!productBound && (!policy || !instance || policy.subscriptionTypeId !== instance.subscriptionTypeId
    || !toStr(instance.subscriptionInstanceId) || !toStr(instance.subscriptionTypeId)
    || policy.policyVersion !== instance.policyVersion
    || !Number.isSafeInteger(policy.policyVersion) || policy.policyVersion < 1)) {
    block("SUBSCRIPTION_INSTANCE_INVALID", "Версия и экземпляр подписки не подтверждены");
  }
  const activeCount = usage?.activeServices;
  decision.activeServices = activeCount;
  decision.maxActiveServices = rule.maxActiveBookings;
  decision.usageUnits = null;
  decision.dailyUsed = null;
  decision.dailyLimit = null;
  if (!Number.isSafeInteger(activeCount) || activeCount < 0
    || usage.activeServiceScope !== "SUBSCRIPTION_BENEFIT_ONLY") {
    block("USAGE_SNAPSHOT_INVALID", "Активные записи выбранной подписки не подтверждены");
  } else {
    // A full active-bookings list is not a blocker: further bookings stay
    // available at the plan discount, without a free hour or a visit.
    decision.aboveActiveLimit = activeCount >= rule.maxActiveBookings;
  }
  const aboveActiveLimit = decision.aboveActiveLimit === true;
  let selectedRule = null;
  if (category === "GAME") {
    const used = usage?.usedOrReservedFreeMinutesToday;
    const day = moscowLocalDate(target?.startsAt);
    if (!Number.isSafeInteger(used) || used < 0 || !day || usage?.dailyBucketLocalDate !== day) {
      block("USAGE_SNAPSHOT_BUCKET_MISMATCH", "Бесплатные минуты даты игры не подтверждены");
    } else if (duration && Number.isSafeInteger(rule.freeGameMinutesPerDay)) {
      if (aboveActiveLimit) {
        // Past the cap the whole game is a paid overage: the day's free hour
        // stays untouched and no visit is consumed.
        decision.gameMinutes = { localDate: day, usedOrReservedFreeMinutesToday: used,
          freeMinutes: 0, paidOverageMinutes: duration, discountPercent: rule.gameOverageDiscountPercent };
        decision.subscriptionVisitCount = 0;
        selectedRule = { ruleId: "lk1-game", kind: "PERCENT_DISCOUNT",
          percentage: rule.gameOverageDiscountPercent };
      } else {
        const freeMinutes = Math.min(duration, Math.max(0, rule.freeGameMinutesPerDay - used));
        const paidOverageMinutes = duration - freeMinutes;
        decision.gameMinutes = { localDate: day, usedOrReservedFreeMinutesToday: used,
          freeMinutes, paidOverageMinutes, discountPercent: rule.gameOverageDiscountPercent };
        decision.subscriptionVisitCount = freeMinutes > 0 ? 1 : 0;
        selectedRule = { ruleId: "lk1-game", kind: paidOverageMinutes === 0
          ? "FREE_ENTITLEMENT" : "PERCENT_DISCOUNT", percentage: rule.gameOverageDiscountPercent };
        if (freeMinutes > 0 && paidOverageMinutes > 0) {
          if (productBound && target?.priceSource === "VIVA_EXISTING_TARIFF") {
            selectedRule = { ruleId: "lk1-game", kind: "PARTIAL_PRICE_PERCENT_DISCOUNT",
              partialPrice: { numerator: paidOverageMinutes, denominator: duration },
              percentage: rule.gameOverageDiscountPercent };
          } else {
            block("LK1_GAME_OVERAGE_ALLOCATION_UNBOUND", "Применение услуги к платной части игры не подтверждено");
            selectedRule = null;
          }
        }
      }
    }
  } else if (category === "GROUP_TRAINING"
    && isTopokratyTrainingBenefit(input?.lk1ProductBinding, target)) {
    // The club's «Дружба Топократы» training is covered by the free-minute mechanism of a
    // game instead of the free-first-event mechanism of every other group event: the shared
    // day bucket and the visit follow the game rules, and the minutes above the free hour
    // carry the club co-pay. The rule keeps its own branch, so the reviewed free-first-event
    // text of the standard branch stays byte-identical.
    const used = usage?.usedOrReservedFreeMinutesToday;
    const day = moscowLocalDate(target?.startsAt);
    if (!Number.isSafeInteger(used) || used < 0 || !day || usage?.dailyBucketLocalDate !== day) {
      block("USAGE_SNAPSHOT_BUCKET_MISMATCH", "Бесплатные минуты даты тренировки не подтверждены");
    } else if (duration && Number.isSafeInteger(rule.freeGameMinutesPerDay)) {
      const freeMinutes = aboveActiveLimit
        ? 0 : Math.min(duration, Math.max(0, rule.freeGameMinutesPerDay - used));
      const paidOverageMinutes = duration - freeMinutes;
      decision.gameMinutes = { localDate: day, usedOrReservedFreeMinutesToday: used,
        freeMinutes, paidOverageMinutes, discountPercent: TOPOKRATY_TRAINING_DISCOUNT_PERCENT };
      decision.subscriptionVisitCount = freeMinutes > 0 ? 1 : 0;
      if (freeMinutes === 0) {
        // No free hour left: the full one-time price, no visit and no discount.
        selectedRule = { ruleId: "lk1-topokraty-training", kind: "PERCENT_DISCOUNT", percentage: 0 };
      } else if (paidOverageMinutes === 0) {
        selectedRule = { ruleId: "lk1-topokraty-training", kind: "FREE_ENTITLEMENT" };
      } else if (productBound && target?.priceSource === "VIVA_EXISTING_TARIFF") {
        // The co-pay is a quarter of the court price for the time above the free hour,
        // pro rata to the event duration (1 - 1/4 stays as the discount on that part).
        selectedRule = { ruleId: "lk1-topokraty-training", kind: "PARTIAL_PRICE_PERCENT_DISCOUNT",
          partialPrice: { numerator: paidOverageMinutes, denominator: duration },
          percentage: TOPOKRATY_TRAINING_DISCOUNT_PERCENT };
      } else {
        block("LK1_GAME_OVERAGE_ALLOCATION_UNBOUND",
          "Применение услуги к платной части тренировки не подтверждено");
        selectedRule = null;
      }
    }
  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {
    // The first covered event of the subscription's local service day is carried by the plan
    // itself: one visit is consumed and nothing is charged. Every later event that day, and
    // any event once the visits are used up, keeps the configured discount and consumes no
    // visit. The gateway proves the day bucket; a covered product whose snapshot is missing
    // fails closed instead of granting a free event on a guess.
    const freeFirst = usage?.freeFirstEvent;
    let freeFirstCovered = false;
    if (isObj(freeFirst) && freeFirst.covered === true) {
      if (!Number.isSafeInteger(freeFirst.usedEventsToday) || freeFirst.usedEventsToday < 0
        || !Number.isSafeInteger(freeFirst.visitsLeft) || freeFirst.visitsLeft < 0) {
        block("FREE_FIRST_EVENT_SNAPSHOT_INVALID", "Первое бесплатное событие дня не подтверждено");
      } else {
        freeFirstCovered = freeFirst.usedEventsToday === 0 && freeFirst.visitsLeft >= 1;
      }
    }
    decision.subscriptionVisitCount = freeFirstCovered ? 1 : 0;
    selectedRule = freeFirstCovered
      ? { ruleId: `lk1-${category.toLowerCase()}`, kind: "FREE_ENTITLEMENT" }
      : { ruleId: `lk1-${category.toLowerCase()}`, kind: "PERCENT_DISCOUNT",
        percentage: category === "GROUP_TRAINING"
          ? rule.groupTrainingDiscountPercent : rule.tournamentDiscountPercent };
  }
  return { selectedRule, surchargeMinor: 0, category };
}
return { selectedRule: null, surchargeMinor: 0, category: null };
};
const { selectedRule, surchargeMinor, category } = selectBenefit();
// The percent the client-facing quote carries for this decision: 100 for a fully covered
// event, the charged share's own percent otherwise. The advisory preview and the booking
// quote verification both read it, so a rule that changes the charged share (the club
// co-pay) can never drift between the two paths.
decision.eventDiscountPercent = !selectedRule ? 0
  : selectedRule.kind === "FREE_ENTITLEMENT" ? 100
    : ["PERCENT_DISCOUNT", "PARTIAL_PRICE_PERCENT_DISCOUNT"].includes(selectedRule.kind)
      && Number.isFinite(Number(selectedRule.percentage)) ? Number(selectedRule.percentage) : 0;
const productBoundInput = input && Object.prototype.hasOwnProperty.call(input, "lk1ProductBinding");
if (!input || !target || !usage || !evaluatedAt
  || (!productBoundInput && (!policy || !instance))
  || (productBoundInput && blockers.length > 0)) return finish();
const basePriceMinor = target?.basePriceMinor === null || target?.basePriceMinor === undefined
  ? null
  : toNonNegativeInt(target.basePriceMinor);
if (target?.basePriceMinor !== null && target?.basePriceMinor !== undefined && basePriceMinor === null) {
  block("BASE_PRICE_INVALID", "Базовая цена события некорректна");
}

if (!selectedRule) {
  if (["GROUP_TRAINING", "TOURNAMENT", "ADD_ON_PRODUCT"].includes(category)) {
    block("EVENT_NOT_INCLUDED", "Категория, тип события или станция не включены в подписку");
  }
  decision.benefit = {
    kind: "NONE",
    ruleId: null,
    basePriceMinor,
    discountMinor: 0,
    surchargeMinor,
    finalPriceMinor: basePriceMinor === null ? (surchargeMinor || null) : basePriceMinor + surchargeMinor,
    partialPriceCalculation: null,
    currency: "RUB",
  };
} else if (selectedRule.kind === "DISABLED") {
  if (["GROUP_TRAINING", "TOURNAMENT", "ADD_ON_PRODUCT"].includes(category)) {
    block("EVENT_NOT_INCLUDED", "Использование подписки для этого события отключено");
  }
  decision.benefit = {
    kind: "NONE",
    ruleId: selectedRule.ruleId || null,
    basePriceMinor,
    discountMinor: 0,
    surchargeMinor,
    finalPriceMinor: basePriceMinor === null ? (surchargeMinor || null) : basePriceMinor + surchargeMinor,
    partialPriceCalculation: null,
    currency: "RUB",
  };
} else {
  let finalBeforeSurcharge = basePriceMinor;
  let discountMinor = 0;
  let partialPriceCalculation = null;
  if (selectedRule.kind === "FREE_ENTITLEMENT") {
    finalBeforeSurcharge = 0;
    discountMinor = basePriceMinor || 0;
  } else if (selectedRule.kind === "FIXED_PRICE") {
    const fixedPrice = toNonNegativeInt(selectedRule.valueMinor);
    if (fixedPrice === null) {
      block("BENEFIT_VALUE_INVALID", "Фиксированная цена льготы не настроена");
    } else {
      finalBeforeSurcharge = fixedPrice;
      discountMinor = basePriceMinor === null ? 0 : Math.max(0, basePriceMinor - fixedPrice);
    }
  } else if (selectedRule.kind === "PERCENT_DISCOUNT") {
    const percentage = Number(selectedRule.percentage);
    if (basePriceMinor === null) {
      block("BASE_PRICE_UNRESOLVED", "Для расчёта скидки сервер должен подтвердить базовую цену");
    } else if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      block("BENEFIT_VALUE_INVALID", "Процент скидки некорректен");
    } else {
      discountMinor = floorRatio(basePriceMinor, percentage, 100);
      if (discountMinor === null) {
        block("PRICE_CALCULATION_OVERFLOW", "Цена события выходит за допустимый диапазон");
        discountMinor = 0;
      }
      finalBeforeSurcharge = Math.max(0, basePriceMinor - discountMinor);
    }
  } else if (selectedRule.kind === "FIXED_DISCOUNT") {
    const fixedDiscount = toNonNegativeInt(selectedRule.valueMinor);
    if (basePriceMinor === null) {
      block("BASE_PRICE_UNRESOLVED", "Для расчёта скидки сервер должен подтвердить базовую цену");
    } else if (fixedDiscount === null) {
      block("BENEFIT_VALUE_INVALID", "Размер скидки некорректен");
    } else {
      discountMinor = Math.min(basePriceMinor, fixedDiscount);
      finalBeforeSurcharge = Math.max(0, basePriceMinor - discountMinor);
    }
  } else if (selectedRule.kind === "PARTIAL_PRICE_PERCENT_DISCOUNT") {
    const numerator = toNonNegativeInt(selectedRule.partialPrice?.numerator);
    const denominator = toNonNegativeInt(selectedRule.partialPrice?.denominator);
    const percentage = Number(selectedRule.percentage);
    if (basePriceMinor === null) {
      block("BASE_PRICE_UNRESOLVED", "Для расчёта доли сервер должен подтвердить базовую цену");
    } else if (!numerator || !denominator || numerator > denominator) {
      block("BENEFIT_VALUE_INVALID", "Доля стоимости льготы некорректна");
    } else if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      block("BENEFIT_VALUE_INVALID", "Процент скидки некорректен");
    } else {
      const chargeBeforeDiscountMinor = floorRatio(basePriceMinor, numerator, denominator);
      const percentageDiscountMinor = chargeBeforeDiscountMinor === null
        ? null
        : floorRatio(chargeBeforeDiscountMinor, percentage, 100);
      if (chargeBeforeDiscountMinor === null || percentageDiscountMinor === null) {
        block("PRICE_CALCULATION_OVERFLOW", "Цена события выходит за допустимый диапазон");
      } else {
        finalBeforeSurcharge = Math.max(0, chargeBeforeDiscountMinor - percentageDiscountMinor);
        discountMinor = basePriceMinor - finalBeforeSurcharge;
        partialPriceCalculation = {
          numerator,
          denominator,
          chargeBeforeDiscountMinor,
          percentageDiscountMinor,
        };
      }
    }
  } else {
    block("BENEFIT_KIND_UNSUPPORTED", "Тип льготы не поддерживается");
  }
  decision.benefit = {
    kind: selectedRule.kind,
    ruleId: toStr(selectedRule.ruleId),
    basePriceMinor,
    discountMinor,
    surchargeMinor,
    finalPriceMinor: finalBeforeSurcharge === null
      ? (surchargeMinor || null)
      : finalBeforeSurcharge + surchargeMinor,
    partialPriceCalculation,
    currency: "RUB",
  };
}

return finish();
