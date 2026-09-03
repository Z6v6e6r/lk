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
  PURCHASE_ADD_ON_PRODUCT: "ADD_ON_PRODUCT",
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
if (!targetLocal) {
  block("TARGET_LOCAL_DATE_UNRESOLVED", "Не удалось определить локальную дату события");
}
const bookingWindowEnabled = policy.bookingWindow?.enabled === true;
const bookingWindowDays = bookingWindowEnabled
  ? toNonNegativeInt(policy.bookingWindow?.days)
  : null;
if (bookingWindowEnabled) {
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
  }
}
if (targetLocal) {
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
if (policy.activeServicesLimit?.enabled === true
  && usage.activeServiceScope !== policy.activeServicesLimit?.scope) {
  block("ACTIVE_SERVICE_SCOPE_MISMATCH", "Снимок активных услуг рассчитан для другого состава записей", {
    expectedScope: toStr(policy.activeServicesLimit?.scope),
    actualScope: toStr(usage.activeServiceScope),
  });
}

const usageKeys = ["dailyUsed", "weeklyUsed", "monthlyUsed", "futureBookings"];
if (policy.activeServicesLimit?.enabled === true) usageKeys.push("activeServices");
if (usageKeys.some((key) => toNonNegativeInt(usage[key]) === null)) {
  block("USAGE_SNAPSHOT_INVALID", "Серверный снимок использования подписки некорректен");
}

const activeServices = toNonNegativeInt(usage.activeServices);
const activeServicesLimitEnabled = policy.activeServicesLimit?.enabled === true;
const maxActiveServices = activeServicesLimitEnabled
  ? toNonNegativeInt(policy.activeServicesLimit?.max)
  : null;
if (activeServicesLimitEnabled) {
  if (maxActiveServices === null || maxActiveServices < 1 || activeServices === null) {
    block("ACTIVE_SERVICES_LIMIT_INVALID", "Лимит активных услуг не настроен");
  } else if (activeServices >= maxActiveServices) {
    block("ACTIVE_SERVICES_LIMIT_REACHED", "Достигнут лимит активных услуг по подписке", {
      activeServices,
      maxActiveServices,
    });
  }
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
const hasDailyUsagePolicy = isObj(policy.dailyUsagePolicy);
const dailyUsageActions = hasDailyUsagePolicy
  ? policy.dailyUsagePolicy.actions
  : [
    "CREATE_GAME",
    "JOIN_GAME",
    "BOOK_GROUP_TRAINING",
    "BOOK_TOURNAMENT",
    "PURCHASE_ADD_ON_PRODUCT",
  ];
const dailyLimitExceededMode = hasDailyUsagePolicy
  ? policy.dailyUsagePolicy.limitExceeded
  : "BLOCK";
const dailyUsagePolicyPercentage = hasDailyUsagePolicy
  ? toNonNegativeInt(policy.dailyUsagePolicy.percentage)
  : null;
const hasDailyUsageDiscountDurations = hasDailyUsagePolicy
  && Object.prototype.hasOwnProperty.call(policy.dailyUsagePolicy, "discountDurationsMinutes");
const hasDailyUsageDurations = hasDailyUsagePolicy
  && Object.prototype.hasOwnProperty.call(policy.dailyUsagePolicy, "usageDurationsMinutes");
const dailyUsageDurations = hasDailyUsageDurations
  && Array.isArray(policy.dailyUsagePolicy.usageDurationsMinutes)
  ? policy.dailyUsagePolicy.usageDurationsMinutes
    .map((value) => toNonNegativeInt(value))
    .filter((value) => [60, 90, 120].includes(value))
  : null;
const dailyUsageDurationsValid = !hasDailyUsageDurations
  || (Array.isArray(policy.dailyUsagePolicy.usageDurationsMinutes)
    && dailyUsageDurations.length > 0
    && dailyUsageDurations.length === policy.dailyUsagePolicy.usageDurationsMinutes.length
    && new Set(dailyUsageDurations).size === dailyUsageDurations.length);
const dailyUsageDiscountDurations = hasDailyUsageDiscountDurations
  && Array.isArray(policy.dailyUsagePolicy.discountDurationsMinutes)
  ? policy.dailyUsagePolicy.discountDurationsMinutes
    .map((value) => toNonNegativeInt(value))
    .filter((value) => value !== null && value > 0)
  : null;
const dailyUsageDiscountDurationsValid = !hasDailyUsageDiscountDurations
  || (Array.isArray(policy.dailyUsagePolicy.discountDurationsMinutes)
    && dailyUsageDiscountDurations.length > 0
    && dailyUsageDiscountDurations.length === policy.dailyUsagePolicy.discountDurationsMinutes.length);
let dailyLimitExceeded = false;
if (!Array.isArray(dailyUsageActions) || dailyUsageActions.length === 0) {
  block("DAILY_USAGE_POLICY_INVALID", "Область дневного лимита подписки не настроена");
} else if (!["BLOCK", "PERCENT_DISCOUNT"].includes(dailyLimitExceededMode)) {
  block("DAILY_USAGE_POLICY_INVALID", "Поведение после дневного лимита не настроено");
} else if (dailyLimitExceededMode === "PERCENT_DISCOUNT"
  && (dailyUsagePolicyPercentage === null || dailyUsagePolicyPercentage > 100)) {
  block("DAILY_USAGE_DISCOUNT_INVALID", "Скидка после дневного лимита не настроена");
} else if (dailyLimitExceededMode === "BLOCK"
  && hasDailyUsagePolicy
  && policy.dailyUsagePolicy.percentage !== null) {
  block("DAILY_USAGE_DISCOUNT_INVALID", "Скидка несовместима с блокирующим дневным лимитом");
} else if (dailyLimitExceededMode === "PERCENT_DISCOUNT"
  && !dailyUsageDiscountDurationsValid) {
  block("DAILY_USAGE_DISCOUNT_DURATION_INVALID", "Длительности скидки после дневного лимита не настроены");
} else if (!dailyUsageDurationsValid) {
  block("DAILY_USAGE_DURATION_INVALID", "Длительности дневного лимита подписки не настроены");
} else if (dailyLimitExceededMode === "BLOCK"
  && hasDailyUsageDiscountDurations) {
  block("DAILY_USAGE_DISCOUNT_DURATION_INVALID", "Длительности скидки несовместимы с блокирующим дневным лимитом");
}
const dailyActionApplies = Array.isArray(dailyUsageActions)
  && dailyUsageActions.includes(action);
const dailyDurationApplies = !hasDailyUsageDurations
  || dailyUsageDurations?.includes(durationMinutes) === true;
const requestedDailyUsageUnits = dailyDurationApplies ? usageUnits : 0;
if (dailyActionApplies) {
  if (dailyUsed === null || dailyLimit === null) {
    block("DAILY_USAGE_LIMIT_INVALID", "Дневной лимит подписки не настроен");
  } else if (requestedDailyUsageUnits !== null && dailyUsed + requestedDailyUsageUnits > dailyLimit) {
    dailyLimitExceeded = true;
    if (dailyLimitExceededMode === "BLOCK") {
      block("DAILY_USAGE_LIMIT_REACHED", "Дневной лимит использования подписки исчерпан", {
        dailyUsed,
        dailyLimit,
        requestedUsageUnits: requestedDailyUsageUnits,
      });
    } else if (dailyLimitExceededMode === "PERCENT_DISCOUNT"
      && (dailyUsagePolicyPercentage === null || dailyUsagePolicyPercentage > 100)) {
      block("DAILY_USAGE_DISCOUNT_INVALID", "Скидка после дневного лимита не настроена");
    } else if (dailyLimitExceededMode === "PERCENT_DISCOUNT"
      && dailyUsageDiscountDurations !== null
      && !dailyUsageDiscountDurations.includes(durationMinutes)) {
      block("DAILY_USAGE_LIMIT_REACHED", "Дневной лимит бесплатной игры исчерпан", {
        dailyUsed,
        dailyLimit,
        requestedUsageUnits: requestedDailyUsageUnits,
        requestedDurationMinutes: durationMinutes,
      });
    }
  }
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
let surchargeMinor = 0;
const stationRuleMatches = Array.isArray(policy.stationAccessRules)
  ? policy.stationAccessRules
    .filter((rule) => {
      if (!isObj(rule) || rule.enabled !== true || !isObj(rule.selector)) return false;
      if (rule.selector.kind === "HOME_STATION") return stationId === homeStationId;
      if (rule.selector.kind === "ALL_STATIONS") return true;
      return rule.selector.kind === "STATION_LIST"
        && Array.isArray(rule.selector.stationIds)
        && rule.selector.stationIds.includes(stationId);
    })
    .sort((left, right) => Number(right.priority) - Number(left.priority))
  : [];
if (!homeStationId || !stationId || !Array.isArray(policy.stationAccessRules)) {
  block("STATION_POLICY_INVALID", "Правило использования на станциях не настроено");
}
if (stationRuleMatches.some((rule) => !Number.isFinite(Number(rule.priority)))) {
  block("STATION_RULE_PRIORITY_INVALID", "Приоритет правила станции некорректен");
}
const stationPriority = stationRuleMatches.length > 0 ? Number(stationRuleMatches[0].priority) : null;
const selectedStationRules = stationPriority === null
  ? []
  : stationRuleMatches.filter((rule) => Number(rule.priority) === stationPriority);
if (selectedStationRules.length > 1) {
  block("AMBIGUOUS_STATION_RULE", "Для станции найдено несколько равноприоритетных правил");
}
const selectedStationRule = selectedStationRules.length === 1 ? selectedStationRules[0] : null;
if (!selectedStationRule) {
  block("STATION_NOT_ALLOWED", "Станция не включена в правила подписки");
} else if (!toStr(selectedStationRule.ruleId)) {
  block("STATION_RULE_ID_INVALID", "Идентификатор правила станции некорректен");
} else if (!isObj(selectedStationRule.surcharge)) {
  block("STATION_SURCHARGE_INVALID", "Доплата для станции не настроена");
} else if (selectedStationRule.surcharge.kind === "FIXED") {
  const configuredSurcharge = toNonNegativeInt(selectedStationRule.surcharge.amountMinor);
  if (configuredSurcharge === null) {
    block("STATION_SURCHARGE_INVALID", "Доплата для станции не настроена");
  } else {
    surchargeMinor = configuredSurcharge;
  }
} else if (selectedStationRule.surcharge.kind !== "NONE") {
  block("STATION_SURCHARGE_INVALID", "Тип доплаты для станции не поддерживается");
}

const externalEventTypeId = toStr(target.externalEventTypeId);
const productTypeId = toStr(target.productTypeId);
const matchingRules = Array.isArray(policy.benefitRules)
  ? policy.benefitRules
    .filter((rule) => (
      isObj(rule)
      && rule.enabled === true
      && rule.category === category
      && Array.isArray(rule.actions)
      && rule.actions.includes(action)
      && Array.isArray(rule.stationIds)
      && rule.stationIds.includes(stationId)
      && externalEventTypeId
      && Array.isArray(rule.externalEventTypeIds)
      && rule.externalEventTypeIds.includes(externalEventTypeId)
      && Array.isArray(rule.durationMinutes)
      && rule.durationMinutes.includes(durationMinutes)
      && (category !== "ADD_ON_PRODUCT" || (
        productTypeId
        && Array.isArray(rule.productTypeIds)
        && rule.productTypeIds.includes(productTypeId)
      ))
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

let selectedRule = highestRules.length === 1 ? highestRules[0] : null;
if (selectedRule && !toStr(selectedRule.ruleId)) {
  block("BENEFIT_RULE_ID_INVALID", "Идентификатор правила льготы некорректен");
}
if (dailyLimitExceeded
  && dailyLimitExceededMode === "PERCENT_DISCOUNT"
  && dailyUsagePolicyPercentage !== null
  && dailyUsagePolicyPercentage <= 100
  && dailyUsageDiscountDurationsValid
  && (!hasDailyUsageDiscountDurations
    || dailyUsageDiscountDurations.includes(durationMinutes))) {
  selectedRule = {
    ruleId: "daily-usage-limit-exceeded",
    kind: "PERCENT_DISCOUNT",
    percentage: dailyUsagePolicyPercentage,
  };
}
const basePriceMinor = target.basePriceMinor === null || target.basePriceMinor === undefined
  ? null
  : toNonNegativeInt(target.basePriceMinor);
if (target.basePriceMinor !== null && target.basePriceMinor !== undefined && basePriceMinor === null) {
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
