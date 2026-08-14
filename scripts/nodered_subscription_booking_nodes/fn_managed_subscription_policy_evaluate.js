const isObj = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const toNonNegativeInt = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};
const toFiniteDate = (value) => {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
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
  maxActiveServices: toNonNegativeInt(policy?.maxActiveServices),
  dailyUsed: toNonNegativeInt(usage?.dailyUsed),
  dailyLimit: toNonNegativeInt(policy?.dailyUsageLimit),
  benefit: null,
  evaluatedAt: evaluatedAt?.toISOString() || new Date(0).toISOString(),
};

const finish = () => {
  decision.eligible = blockers.length === 0;
  msg._managedSubscriptionPolicyDecision = decision;
  return decision.eligible ? [msg, null] : [null, msg];
};

if (!input || !policy || !instance || !target || !usage || !evaluatedAt) {
  block(
    "MANAGED_SUBSCRIPTION_CONTEXT_INVALID",
    "Не удалось безопасно собрать контекст проверки подписки",
  );
  return finish();
}

if (policy.runtimeSchemaVersion !== 1) {
  block("POLICY_SCHEMA_UNSUPPORTED", "Версия runtime-схемы подписки не поддерживается");
}
if (policy.status !== "PUBLISHED") {
  block("POLICY_NOT_PUBLISHED", "Правила подписки ещё не опубликованы");
}
if (!Number.isInteger(policy.policyVersion) || policy.policyVersion < 1) {
  block("POLICY_VERSION_INVALID", "Версия правил подписки некорректна");
}
if (!toStr(policy.subscriptionTypeId) || !toStr(instance.subscriptionTypeId)
  || !toStr(instance.subscriptionInstanceId)) {
  block("SUBSCRIPTION_INSTANCE_INVALID", "Идентичность экземпляра подписки не подтверждена");
} else if (policy.subscriptionTypeId !== instance.subscriptionTypeId) {
  block("SUBSCRIPTION_TYPE_MISMATCH", "Экземпляр подписки связан с другим типом правил");
}
if (instance.policyVersion !== policy.policyVersion) {
  block("POLICY_VERSION_MISMATCH", "Экземпляр подписки связан с другой версией правил", {
    instancePolicyVersion: instance.policyVersion ?? null,
    evaluatedPolicyVersion: policy.policyVersion ?? null,
  });
}
if (target.resolutionSource !== "SERVER") {
  block("TARGET_NOT_SERVER_RESOLVED", "Параметры события должны быть подтверждены сервером");
}

const policyEffectiveAt = toFiniteDate(policy.effectiveAt);
if (!policyEffectiveAt) {
  block("POLICY_EFFECTIVE_AT_INVALID", "Дата вступления правил в силу некорректна");
} else if (policyEffectiveAt.getTime() > evaluatedAt.getTime()) {
  block("POLICY_NOT_EFFECTIVE", "Правила подписки ещё не вступили в силу", {
    effectiveAt: policyEffectiveAt.toISOString(),
  });
}

const activeFrom = toFiniteDate(instance.activeFrom);
const activeTo = toFiniteDate(instance.activeTo);
if (!activeFrom || !activeTo || activeFrom.getTime() > activeTo.getTime()) {
  block("SUBSCRIPTION_VALIDITY_INVALID", "Срок действия подписки не подтверждён");
}
const frozenUntilRaw = toStr(instance.frozenUntil);
const frozenUntil = toFiniteDate(instance.frozenUntil);
if (frozenUntilRaw && !frozenUntil) {
  block("SUBSCRIPTION_FREEZE_STATE_INVALID", "Срок заморозки подписки некорректен");
}
if (instance.state === "FROZEN") {
  block("SUBSCRIPTION_FROZEN", "Подписка заморожена", {
    frozenUntil: frozenUntil?.toISOString() || null,
  });
} else if (instance.state !== "ACTIVE") {
  const stateCode = instance.state === "EXPIRED"
    ? "SUBSCRIPTION_EXPIRED"
    : "SUBSCRIPTION_NOT_ACTIVE";
  block(stateCode, "Подписка сейчас недоступна для записи", {
    state: toStr(instance.state),
  });
}
if (activeFrom && evaluatedAt.getTime() < activeFrom.getTime()) {
  block("SUBSCRIPTION_NOT_ACTIVE", "Срок действия подписки ещё не начался", {
    activeFrom: activeFrom.toISOString(),
  });
}
if (activeTo && evaluatedAt.getTime() > activeTo.getTime()) {
  block("SUBSCRIPTION_EXPIRED", "Срок действия подписки закончился", {
    activeTo: activeTo.toISOString(),
  });
}
const noShowBlockedUntilRaw = toStr(instance.noShowBlockedUntil);
const noShowBlockedUntil = toFiniteDate(instance.noShowBlockedUntil);
if (noShowBlockedUntilRaw && !noShowBlockedUntil) {
  block("SUBSCRIPTION_NO_SHOW_STATE_INVALID", "Срок блокировки после неявки некорректен");
}
if (noShowBlockedUntil && noShowBlockedUntil.getTime() > evaluatedAt.getTime()) {
  block("SUBSCRIPTION_NO_SHOW_BLOCKED", "Запись по подписке временно заблокирована после неявки", {
    blockedUntil: noShowBlockedUntil.toISOString(),
  });
}

const startsAt = toFiniteDate(target.startsAt);
const durationMinutes = toNonNegativeInt(target.durationMinutes);
const stationId = toStr(target.stationId);
const category = toStr(target.category);
const action = toStr(input.action);
const actionCategory = {
  CREATE_GAME: "GAME",
  JOIN_GAME: "GAME",
  BOOK_GROUP_TRAINING: "GROUP_TRAINING",
  BOOK_TOURNAMENT: "TOURNAMENT",
}[action];

if (!startsAt || !durationMinutes || !stationId || !actionCategory) {
  block("TARGET_INVALID", "Параметры события неполны или некорректны");
} else {
  if (category !== actionCategory) {
    block("TARGET_CATEGORY_MISMATCH", "Категория события не совпадает с действием", {
      action,
      category,
    });
  }
  if (startsAt.getTime() <= evaluatedAt.getTime()) {
    block("TARGET_IN_PAST", "Нельзя использовать подписку для уже начавшегося события");
  }
  if (
    activeTo
    && startsAt.getTime() > activeTo.getTime()
    && policy.lifecycle?.allowBookingsAfterExpiry !== true
  ) {
    block("TARGET_AFTER_SUBSCRIPTION_EXPIRY", "Событие проходит после окончания подписки", {
      activeTo: activeTo.toISOString(),
    });
  }
}
if (target.currency !== "RUB") {
  block("CURRENCY_UNSUPPORTED", "Валюта события не поддерживается", {
    currency: toStr(target.currency),
  });
}

if (action === "CREATE_GAME") {
  if (policy.createGame?.enabled !== true) {
    block("SUBSCRIPTION_CREATE_DISABLED", "Создание игр по этой подписке отключено");
  } else if (!Array.isArray(policy.createGame.durationsMinutes)
    || !policy.createGame.durationsMinutes.includes(durationMinutes)) {
    block("DURATION_NOT_ALLOWED", "Такая длительность игры недоступна по подписке", {
      durationMinutes,
      allowedDurationsMinutes: Array.isArray(policy.createGame?.durationsMinutes)
        ? policy.createGame.durationsMinutes
        : [],
    });
  }
}
if (action === "JOIN_GAME") {
  if (policy.joinGame?.enabled !== true) {
    block("SUBSCRIPTION_JOIN_DISABLED", "Присоединение к играм по этой подписке отключено");
  } else {
    const minDuration = toNonNegativeInt(policy.joinGame.minDurationMinutes);
    const maxDuration = toNonNegativeInt(policy.joinGame.maxDurationMinutes);
    if (!minDuration || !maxDuration || !durationMinutes
      || durationMinutes < minDuration || durationMinutes > maxDuration) {
      block("DURATION_NOT_ALLOWED", "Длительность игры находится вне разрешённого диапазона", {
        durationMinutes,
        minDurationMinutes: minDuration,
        maxDurationMinutes: maxDuration,
      });
    }
  }
}

const timeZone = toStr(policy.timeZone);
const localDateParts = (date, zone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (!values.year || !values.month || !values.day) return null;
    return {
      key: `${values.year}-${values.month}-${values.day}`,
      dayNumber: Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) / 86400000,
    };
  } catch (_) {
    return null;
  }
};

const todayLocal = timeZone ? localDateParts(evaluatedAt, timeZone) : null;
const targetLocal = startsAt && timeZone ? localDateParts(startsAt, timeZone) : null;
const bookingWindowDays = toNonNegativeInt(policy.bookingWindowDays);
if (!todayLocal || !targetLocal || !bookingWindowDays) {
  block("BOOKING_WINDOW_UNRESOLVED", "Не удалось определить календарное окно записи");
} else {
  const dayOffset = targetLocal.dayNumber - todayLocal.dayNumber;
  if (dayOffset < 0 || dayOffset >= bookingWindowDays) {
    block("BOOKING_WINDOW_EXCEEDED", "Событие находится за пределами окна записи по подписке", {
      bookingWindowDays,
      targetLocalDate: targetLocal.key,
      currentLocalDate: todayLocal.key,
    });
  }
  if (Array.isArray(policy.usage?.blackoutDates)
    && policy.usage.blackoutDates.includes(targetLocal.key)) {
    block("SUBSCRIPTION_BLACKOUT_DATE", "На выбранную дату подписка не действует", {
      targetLocalDate: targetLocal.key,
    });
  }
}

if (targetLocal && toStr(usage.dailyBucketLocalDate) !== targetLocal.key) {
  block("USAGE_SNAPSHOT_BUCKET_MISMATCH", "Снимок использования рассчитан для другой даты", {
    expectedLocalDate: targetLocal.key,
    actualLocalDate: toStr(usage.dailyBucketLocalDate),
  });
}
if (usage.activeServiceScope !== policy.activeServiceScope) {
  block("ACTIVE_SERVICE_SCOPE_MISMATCH", "Снимок активных услуг рассчитан для другого состава записей", {
    expectedScope: toStr(policy.activeServiceScope),
    actualScope: toStr(usage.activeServiceScope),
  });
}

const usageKeys = ["activeServices", "dailyUsed", "weeklyUsed", "monthlyUsed", "futureBookings"];
if (usageKeys.some((key) => toNonNegativeInt(usage[key]) === null)) {
  block("USAGE_SNAPSHOT_INVALID", "Серверный снимок использования подписки некорректен");
}

const maxActiveServices = toNonNegativeInt(policy.maxActiveServices);
const activeServices = toNonNegativeInt(usage.activeServices);
if (maxActiveServices === null || activeServices === null) {
  block("ACTIVE_SERVICES_LIMIT_INVALID", "Лимит активных услуг не настроен");
} else if (activeServices >= maxActiveServices) {
  block("ACTIVE_SERVICES_LIMIT_REACHED", "Достигнут лимит активных услуг по подписке", {
    activeServices,
    maxActiveServices,
  });
}

const usageUnits = durationMinutes
  ? toNonNegativeInt(policy.usageUnitsByDuration?.[String(durationMinutes)])
  : null;
decision.usageUnits = usageUnits;
if (usageUnits === null) {
  block("USAGE_UNITS_UNRESOLVED", "Не настроено списание для длительности события", {
    durationMinutes,
  });
}

const dailyUsed = toNonNegativeInt(usage.dailyUsed);
const dailyLimit = toNonNegativeInt(policy.dailyUsageLimit);
if (dailyUsed === null || dailyLimit === null) {
  block("DAILY_USAGE_LIMIT_INVALID", "Дневной лимит подписки не настроен");
} else if (usageUnits !== null && dailyUsed + usageUnits > dailyLimit) {
  block("DAILY_USAGE_LIMIT_REACHED", "Дневной лимит использования подписки исчерпан", {
    dailyUsed,
    dailyLimit,
    requestedUsageUnits: usageUnits,
  });
}

const weeklyLimit = policy.usage?.weeklyUsageLimit;
const monthlyLimit = policy.usage?.monthlyUsageLimit;
const weeklyUsed = toNonNegativeInt(usage.weeklyUsed);
const monthlyUsed = toNonNegativeInt(usage.monthlyUsed);
if (weeklyLimit !== null && weeklyLimit !== undefined) {
  const normalizedWeeklyLimit = toNonNegativeInt(weeklyLimit);
  if (normalizedWeeklyLimit === null || weeklyUsed === null) {
    block("WEEKLY_USAGE_LIMIT_INVALID", "Недельный лимит подписки не настроен");
  } else if (usageUnits !== null && weeklyUsed + usageUnits > normalizedWeeklyLimit) {
    block("WEEKLY_USAGE_LIMIT_REACHED", "Недельный лимит использования подписки исчерпан", {
      weeklyUsed,
      weeklyLimit: normalizedWeeklyLimit,
      requestedUsageUnits: usageUnits,
    });
  }
}
if (monthlyLimit !== null && monthlyLimit !== undefined) {
  const normalizedMonthlyLimit = toNonNegativeInt(monthlyLimit);
  if (normalizedMonthlyLimit === null || monthlyUsed === null) {
    block("MONTHLY_USAGE_LIMIT_INVALID", "Месячный лимит подписки не настроен");
  } else if (usageUnits !== null && monthlyUsed + usageUnits > normalizedMonthlyLimit) {
    block("MONTHLY_USAGE_LIMIT_REACHED", "Месячный лимит использования подписки исчерпан", {
      monthlyUsed,
      monthlyLimit: normalizedMonthlyLimit,
      requestedUsageUnits: usageUnits,
    });
  }
}

const maxFutureBookings = policy.usage?.maxFutureBookings;
const futureBookings = toNonNegativeInt(usage.futureBookings);
if (maxFutureBookings !== null && maxFutureBookings !== undefined) {
  const normalizedMaxFutureBookings = toNonNegativeInt(maxFutureBookings);
  if (normalizedMaxFutureBookings === null || futureBookings === null) {
    block("FUTURE_BOOKINGS_LIMIT_INVALID", "Лимит будущих записей не настроен");
  } else if (futureBookings >= normalizedMaxFutureBookings) {
    block("FUTURE_BOOKINGS_LIMIT_REACHED", "Достигнут лимит будущих записей по подписке", {
      futureBookings,
      maxFutureBookings: normalizedMaxFutureBookings,
    });
  }
}

const minHoursBetweenUses = Number(policy.usage?.minHoursBetweenUses);
if (!Number.isFinite(minHoursBetweenUses) || minHoursBetweenUses < 0) {
  block("MIN_USE_INTERVAL_INVALID", "Минимальный интервал использования подписки не настроен");
} else if (startsAt && minHoursBetweenUses > 0) {
  const normalizedActiveServiceTimes = Array.isArray(usage.activeServiceStartsAt)
    ? usage.activeServiceStartsAt.map(toFiniteDate)
    : null;
  const conflictAt = normalizedActiveServiceTimes
    ? normalizedActiveServiceTimes
      .filter(Boolean)
      .find((date) => Math.abs(date.getTime() - startsAt.getTime()) < minHoursBetweenUses * 3600000)
    : null;
  if (!Array.isArray(usage.activeServiceStartsAt)) {
    block("ACTIVE_SERVICE_TIMES_INVALID", "Сервер не передал времена активных услуг");
  } else if (normalizedActiveServiceTimes.some((date) => !date)) {
    block("ACTIVE_SERVICE_TIMES_INVALID", "Сервер передал некорректное время активной услуги");
  } else if (conflictAt) {
    block("MIN_USE_INTERVAL_NOT_MET", "Между услугами недостаточно времени", {
      minHoursBetweenUses,
      conflictingStartsAt: conflictAt.toISOString(),
    });
  }
}

const homeStationId = toStr(instance.homeStationId);
const crossStationMode = toStr(policy.usage?.crossStationMode);
let surchargeMinor = 0;
if (!homeStationId || !stationId || !["HOME_ONLY", "ALLOWED", "ALLOWED_WITH_SURCHARGE"].includes(crossStationMode)) {
  block("STATION_POLICY_INVALID", "Правило использования на станциях не настроено");
} else if (homeStationId !== stationId) {
  if (crossStationMode === "HOME_ONLY") {
    block("STATION_NOT_ALLOWED", "Подписка действует только на домашней станции");
  } else if (crossStationMode === "ALLOWED_WITH_SURCHARGE") {
    const configuredSurcharge = toNonNegativeInt(policy.usage?.crossStationSurchargeMinor);
    if (configuredSurcharge === null) {
      block("STATION_SURCHARGE_INVALID", "Доплата за другую станцию не настроена");
    } else {
      surchargeMinor = configuredSurcharge;
    }
  }
}

const externalEventTypeId = toStr(target.externalEventTypeId);
const matchingRules = Array.isArray(policy.benefitRules)
  ? policy.benefitRules
    .filter((rule) => (
      isObj(rule)
      && rule.enabled === true
      && rule.category === category
      && Array.isArray(rule.stationIds)
      && rule.stationIds.includes(stationId)
      && externalEventTypeId
      && Array.isArray(rule.externalEventTypeIds)
      && rule.externalEventTypeIds.includes(externalEventTypeId)
    ))
    .sort((left, right) => Number(right.priority) - Number(left.priority))
  : [];

if (matchingRules.some((rule) => !Number.isFinite(Number(rule.priority)))) {
  block("BENEFIT_RULE_PRIORITY_INVALID", "Приоритет правила льготы некорректен");
}

const highestPriority = matchingRules.length > 0 ? Number(matchingRules[0].priority) : null;
const highestRules = highestPriority === null
  ? []
  : matchingRules.filter((rule) => Number(rule.priority) === highestPriority);
if (highestRules.length > 1) {
  block("AMBIGUOUS_BENEFIT_RULE", "Для события найдено несколько равноприоритетных льгот");
}

const selectedRule = highestRules.length === 1 ? highestRules[0] : null;
if (selectedRule && !toStr(selectedRule.ruleId)) {
  block("BENEFIT_RULE_ID_INVALID", "Идентификатор правила льготы некорректен");
}
const basePriceMinor = target.basePriceMinor === null || target.basePriceMinor === undefined
  ? null
  : toNonNegativeInt(target.basePriceMinor);
if (target.basePriceMinor !== null && target.basePriceMinor !== undefined && basePriceMinor === null) {
  block("BASE_PRICE_INVALID", "Базовая цена события некорректна");
}

if (!selectedRule) {
  if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {
    block("EVENT_NOT_INCLUDED", "Категория, тип события или станция не включены в подписку");
  }
  decision.benefit = {
    kind: "NONE",
    ruleId: null,
    basePriceMinor,
    discountMinor: 0,
    surchargeMinor,
    finalPriceMinor: basePriceMinor === null ? (surchargeMinor || null) : basePriceMinor + surchargeMinor,
    currency: "RUB",
  };
} else if (selectedRule.kind === "DISABLED") {
  if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {
    block("EVENT_NOT_INCLUDED", "Использование подписки для этого события отключено");
  }
  decision.benefit = {
    kind: "NONE",
    ruleId: selectedRule.ruleId || null,
    basePriceMinor,
    discountMinor: 0,
    surchargeMinor,
    finalPriceMinor: basePriceMinor === null ? (surchargeMinor || null) : basePriceMinor + surchargeMinor,
    currency: "RUB",
  };
} else {
  let finalBeforeSurcharge = basePriceMinor;
  let discountMinor = 0;
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
      discountMinor = Math.round(basePriceMinor * percentage / 100);
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
    currency: "RUB",
  };
}

return finish();
