const VIVA_API_BASE = "https://api.vivacrm.ru";
const OUTPUT_HTTP = 0;
const OUTPUT_MONGO_FIND = 1;
const OUTPUT_MONGO_UPDATE = 2;
const OUTPUT_RESPONSE = 3;
const OUTPUT_DEBUG = 4;

const emit = (index, value = msg) => {
  const outputs = [null, null, null, null, null];
  outputs[index] = value;
  return outputs;
};
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const envIds = (name) => new Set(
  String(toStr(env.get(name)) || "").split(",").map(normalizeId).filter(Boolean),
);
const isOk = (status) => Number(status) >= 200 && Number(status) < 300;
const responseHeaders = (ctx) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": ctx.corsOrigin || "https://padlhub.ru",
  Vary: "Origin",
});
const finish = (ctx, statusCode, payload) => {
  msg._a3payDevViva = ctx;
  msg.statusCode = statusCode;
  msg.headers = responseHeaders(ctx);
  msg.payload = payload;
  delete msg.error;
  delete msg.url;
  delete msg.method;
  return emit(OUTPUT_RESPONSE);
};
const fail = (ctx, statusCode, error, code, details) => finish(ctx, statusCode, {
  ok: false,
  error,
  code,
  operationId: ctx.operationId || null,
  details: details || null,
});
const inProgress = (ctx, message, state = "IN_PROGRESS") => finish(ctx, 202, {
  ok: true,
  state,
  operationId: ctx.operationId,
  bookingId: ctx.bookingId || null,
  exerciseId: ctx.exerciseId || null,
  message,
});
const confirmed = (ctx, record, statusCode = 200) => finish(ctx, statusCode, {
  ok: true,
  state: "VIVA_BOOKING_CREATED",
  operationId: ctx.operationId,
  bookingId: toStr(record.bookingId),
  exerciseId: toStr(record.exerciseId),
  message: "Бронь создана и проверена в Viva. Счёт A3.pay и игра не создавались.",
});
const cancelled = (ctx, record) => finish(ctx, 200, {
  ok: true,
  state: "CANCELLED",
  operationId: ctx.operationId,
  bookingId: toStr(record.bookingId),
  exerciseId: toStr(record.exerciseId),
  message: "Тестовая бронь отменена и проверена в Viva.",
});
const prepareHttp = (ctx, step, method, path, payload) => {
  ctx.step = step;
  msg._a3payDevViva = ctx;
  msg.method = method;
  msg.url = `${VIVA_API_BASE}${path}`;
  msg.headers = {
    Authorization: ctx.authHeader,
    Accept: "application/json",
    ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  msg.payload = payload;
  delete msg.error;
  delete msg.statusCode;
  return emit(OUTPUT_HTTP);
};
const prepareFind = (ctx, step) => {
  ctx.step = step;
  msg._a3payDevViva = ctx;
  msg.payload = [{ _id: ctx.operationKey }];
  delete msg.error;
  delete msg.statusCode;
  return emit(OUTPUT_MONGO_FIND);
};
const prepareUpdate = (ctx, step, filter, update, options = {}) => {
  ctx.step = step;
  msg._a3payDevViva = ctx;
  msg.payload = [filter, update, options];
  delete msg.error;
  delete msg.statusCode;
  return emit(OUTPUT_MONGO_UPDATE);
};
const modifiedCount = (value) => Number(
  value?.modifiedCount ?? value?.result?.nModified ?? value?.result?.modifiedCount ?? 0,
);
const unwrap = (value) => {
  if (!isObj(value)) return null;
  if (toStr(value.id || value.clientId || value.uuid)) return value;
  for (const key of ["data", "payload", "result"]) {
    const nested = unwrap(value[key]);
    if (nested) return nested;
  }
  return value;
};
const extractItems = (value, seen = new Set()) => {
  if (Array.isArray(value)) return value;
  if (!isObj(value) || seen.has(value)) return [];
  seen.add(value);
  for (const key of ["content", "items", "records", "bookings", "data", "payload", "result"]) {
    if (Array.isArray(value[key])) return value[key];
    const nested = extractItems(value[key], seen);
    if (nested.length > 0) return nested;
  }
  return [];
};
const collectIds = (value, keys, seen = new Set()) => {
  if (value === null || value === undefined || seen.has(value)) return [];
  if (typeof value !== "object") return [];
  seen.add(value);
  const values = [];
  if (Array.isArray(value)) {
    for (const item of value) values.push(...collectIds(item, keys, seen));
    return values;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key)) {
      if (Array.isArray(nested)) values.push(...nested.map(toStr).filter(Boolean));
      else if (isObj(nested)) values.push(...[nested.id, nested.uuid].map(toStr).filter(Boolean));
      else if (toStr(nested)) values.push(toStr(nested));
    }
    if (nested && typeof nested === "object") values.push(...collectIds(nested, keys, seen));
  }
  return [...new Set(values)];
};
const bookingIdOf = (row) => toStr(row?.bookingId || row?.id || row?.uuid);
const isCancelledRow = (row) => {
  if (row?.cancelled === true || row?.isCancelled === true) return true;
  if (toStr(row?.cancelledAt || row?.cancellationDate)) return true;
  return String(row?.status || row?.bookingStatus || "").toUpperCase().includes("CANCEL");
};
const bookingMatchesSelection = (row, selection) => {
  const exercise = isObj(row?.exercise) ? row.exercise : {};
  const studioId = normalizeId(row?.studioId || row?.studio?.id || exercise.studioId || exercise.studio?.id);
  const roomId = normalizeId(row?.roomId || row?.room?.id || exercise.roomId || exercise.room?.id);
  if (studioId && studioId !== normalizeId(selection.studioId)) return false;
  if (roomId && roomId !== normalizeId(selection.roomId)) return false;
  const from = toStr(row?.timeFrom || row?.from || row?.startDateTime || exercise.timeFrom || exercise.startDateTime);
  if (from && !from.includes(`${selection.date}T${selection.fromTime}`)) return false;
  return true;
};
const bookingStrictlyMatchesSelection = (row, selection) => {
  const exercise = isObj(row?.exercise) ? row.exercise : {};
  const studioId = normalizeId(row?.studioId || row?.studio?.id || exercise.studioId || exercise.studio?.id);
  const roomId = normalizeId(row?.roomId || row?.room?.id || exercise.roomId || exercise.room?.id);
  const from = toStr(row?.timeFrom || row?.from || row?.startDateTime || exercise.timeFrom || exercise.startDateTime);
  return Boolean(
    bookingIdOf(row)
    && studioId === normalizeId(selection.studioId)
    && roomId === normalizeId(selection.roomId)
    && from?.includes(`${selection.date}T${selection.fromTime}`),
  );
};
const bookingMatchesRecoveryWindow = (row, providerAttemptedAt) => {
  const attemptedMs = Date.parse(toStr(providerAttemptedAt) || "");
  const createdMs = Date.parse(toStr(
    row?.createdAt || row?.createdDate || row?.creationDate || row?.bookingCreatedAt,
  ) || "");
  return Number.isFinite(attemptedMs)
    && Number.isFinite(createdMs)
    && createdMs >= attemptedMs - 5_000
    && createdMs <= attemptedMs + 2 * 60 * 1000;
};
const bookingHasOperationMarker = (row, operationId) => {
  const expected = `A3PAY_DEV:${operationId}`;
  return [
    row?.comment,
    row?.bookingComment,
    row?.exercise?.comment,
  ].map(toStr).includes(expected);
};
const readRecord = (payload) => asArray(payload).filter(isObj)[0] || null;
const operationDoc = (ctx) => ({
  _id: ctx.operationKey,
  operationId: ctx.operationId,
  actorClientId: ctx.actorClientId,
  selection: ctx.selection,
  selectionKey: ctx.selectionKey,
  state: "PREPARED",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  transitions: [{ state: "PREPARED", at: new Date().toISOString() }],
});
const hydrate = (ctx, record) => {
  ctx.bookingId = toStr(record.bookingId);
  ctx.exerciseId = toStr(record.exerciseId);
  ctx.transactionId = toStr(record.transactionId);
  ctx.claimToken = toStr(record.claimToken) || ctx.claimToken;
  ctx.providerAttemptedAt = toStr(record.providerAttemptedAt) || ctx.providerAttemptedAt;
  ctx.preexistingBookingIds = Array.isArray(record.preexistingBookingIds)
    ? record.preexistingBookingIds.map(toStr).filter(Boolean)
    : ctx.preexistingBookingIds;
  ctx.selection = record.selection || ctx.selection;
  ctx.selectionKey = toStr(record.selectionKey) || ctx.selectionKey;
  return ctx;
};
const startBookingReadback = (ctx) => prepareHttp(
  ctx,
  "create_readback",
  "GET",
  `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`,
  undefined,
);
const startProviderRecoveryReadback = (ctx) => prepareHttp(
  ctx,
  "provider_recovery_readback",
  "GET",
  `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`,
  undefined,
);
const startCancelReadback = (ctx) => prepareHttp(
  ctx,
  "cancel_readback",
  "GET",
  `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`,
  undefined,
);
const startCancelHistoryReadback = (ctx) => prepareHttp(
  ctx,
  "cancel_history_readback",
  "GET",
  `/end-user/api/v2/${ctx.tenantKey}/bookings/history?includeCanceled=true&size=1000`,
  undefined,
);

const ctx = isObj(msg._a3payDevViva) ? msg._a3payDevViva : null;
if (!ctx) {
  return fail({}, 500, "Контекст тестовой брони потерян", "A3PAY_DEV_CONTEXT_MISSING");
}

if (ctx.step === "profile") {
  if (!isOk(msg.statusCode)) {
    return fail(ctx, Number(msg.statusCode) || 502, "Не удалось подтвердить профиль Viva", "A3PAY_DEV_PROFILE_UNAVAILABLE");
  }
  const profile = unwrap(msg.payload);
  ctx.actorClientId = toStr(profile?.id || profile?.clientId);
  if (!ctx.actorClientId) {
    return fail(ctx, 502, "Профиль Viva не содержит clientId", "A3PAY_DEV_PROFILE_INCOMPLETE");
  }
  const allowedClientIds = envIds("A3PAY_DEV_VIVA_BOOKING_CLIENT_IDS");
  if (allowedClientIds.size === 0) {
    return fail(ctx, 503, "Allowlist тестовых клиентов не настроен", "A3PAY_DEV_CLIENT_ALLOWLIST_MISSING");
  }
  if (!allowedClientIds.has(normalizeId(ctx.actorClientId))) {
    return fail(ctx, 403, "Профиль не разрешён для тестовой брони", "A3PAY_DEV_CLIENT_DENIED");
  }
  ctx.operationKey = `a3pay-dev:${ctx.actorClientId}:${ctx.operationId}`;
  if (["cancel", "status"].includes(ctx.action)) {
    return prepareFind(ctx, "operation_find");
  }
  const nowIso = new Date().toISOString();
  return prepareUpdate(ctx, "operation_upsert", { _id: ctx.operationKey }, {
    $setOnInsert: operationDoc(ctx),
    $set: { lastSeenAt: nowIso },
  }, { upsert: true });
}

if (ctx.step === "operation_upsert") {
  return prepareFind(ctx, "operation_find");
}

if (ctx.step === "operation_find") {
  const record = readRecord(msg.payload);
  if (!record) {
    if (ctx.action === "status") {
      return fail(ctx, 404, "Активная тестовая операция не найдена", "A3PAY_DEV_OPERATION_NOT_FOUND");
    }
    return fail(ctx, 503, "Операция не найдена после записи", "A3PAY_DEV_OPERATION_NOT_DURABLE");
  }
  const requestedSelectionKey = ctx.selectionKey;
  hydrate(ctx, record);
  if (normalizeId(record.actorClientId) !== normalizeId(ctx.actorClientId)) {
    return fail(ctx, 409, "Операция принадлежит другому профилю", "A3PAY_DEV_ACTOR_MISMATCH");
  }
  if (ctx.action === "create" && toStr(record.selectionKey) !== requestedSelectionKey) {
    return fail(ctx, 409, "operationId уже связан с другим слотом", "A3PAY_DEV_OPERATION_SELECTION_MISMATCH");
  }

  if (ctx.action === "status") {
    if (record.state === "VIVA_BOOKING_CREATED") return confirmed(ctx, record);
    if (record.state === "CANCELLED") return cancelled(ctx, record);
    if (record.state === "PROVIDER_RESULT_RECEIVED" && ctx.bookingId) return startBookingReadback(ctx);
    if (["PROVIDER_PENDING", "PROVIDER_UNVERIFIED"].includes(record.state)
      && Array.isArray(record.preexistingBookingIds)) {
      return startProviderRecoveryReadback(ctx);
    }
    if (record.state === "CANCEL_PENDING") {
      const attemptedAt = Date.parse(toStr(record.cancelAttemptedAt) || "");
      if (Number.isFinite(attemptedAt) && Date.now() - attemptedAt >= 30_000 && ctx.bookingId) {
        return startCancelReadback(ctx);
      }
      return inProgress(ctx, "Отмена ожидает подтверждения Viva.", "CANCEL_PENDING");
    }
    if (record.state === "SNAPSHOT_PENDING") {
      return inProgress(
        ctx,
        "Операция ожидает явного повторного подтверждения создания; status provider write не запускает.",
        "PREPARED",
      );
    }
    if (record.state === "PREPARED") {
      return inProgress(ctx, "Операция подготовлена, provider write ещё не начинался.", "PREPARED");
    }
    return inProgress(ctx, "Операция требует сверки; provider POST не повторяется.", "PROVIDER_UNVERIFIED");
  }

  if (ctx.action === "create") {
    if (record.state === "VIVA_BOOKING_CREATED") return confirmed(ctx, record);
    if (record.state === "CANCELLED") {
      return fail(ctx, 409, "Эта тестовая операция уже отменена", "A3PAY_DEV_OPERATION_CANCELLED");
    }
    if (record.state === "PROVIDER_RESULT_RECEIVED" && ctx.bookingId) {
      return startBookingReadback(ctx);
    }
    if (record.state === "SNAPSHOT_PENDING") {
      return prepareHttp(
        ctx,
        "precreate_snapshot",
        "GET",
        `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`,
        undefined,
      );
    }
    if (["PROVIDER_PENDING", "PROVIDER_UNVERIFIED"].includes(record.state)
      && Array.isArray(record.preexistingBookingIds)) {
      return startProviderRecoveryReadback(ctx);
    }
    if (["PROVIDER_PENDING", "PROVIDER_UNVERIFIED"].includes(record.state)) {
      return inProgress(
        ctx,
        "Результат запроса Viva неоднозначен. Автоматический повтор запрещён; требуется read-back операции.",
        "PROVIDER_UNVERIFIED",
      );
    }
    if (record.state !== "PREPARED") {
      return fail(ctx, 409, "Операция находится в неподдерживаемом состоянии", "A3PAY_DEV_STATE_CONFLICT");
    }
    ctx.claimToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const nowIso = new Date().toISOString();
    return prepareUpdate(ctx, "create_claim", {
      _id: ctx.operationKey,
      state: "PREPARED",
    }, {
      $set: {
        state: "SNAPSHOT_PENDING",
        claimToken: ctx.claimToken,
        updatedAt: nowIso,
      },
      $unset: { expiresAt: "" },
      $push: { transitions: { state: "SNAPSHOT_PENDING", at: nowIso } },
    });
  }

  if (record.state === "CANCELLED") return cancelled(ctx, record);
  if (record.state === "CANCEL_PENDING") {
    const attemptedAt = Date.parse(toStr(record.cancelAttemptedAt) || "");
    if (Number.isFinite(attemptedAt) && Date.now() - attemptedAt >= 30_000 && ctx.bookingId) {
      return startCancelReadback(ctx);
    }
    return inProgress(ctx, "Отмена уже отправлена в Viva и ожидает подтверждения.");
  }
  if (record.state !== "VIVA_BOOKING_CREATED" || !ctx.bookingId) {
    return fail(ctx, 409, "Подтверждённая бронь для отмены не найдена", "A3PAY_DEV_CANCEL_TARGET_MISSING");
  }
  return prepareHttp(
    ctx,
    "cancel_probe",
    "GET",
    `/end-user/api/v1/${ctx.tenantKey}/bookings/${encodeURIComponent(ctx.bookingId)}/cancel`,
    undefined,
  );
}

if (ctx.step === "create_claim") {
  if (modifiedCount(msg.payload) !== 1) return prepareFind(ctx, "operation_find");
  return prepareHttp(
    ctx,
    "precreate_snapshot",
    "GET",
    `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`,
    undefined,
  );
}

const startProviderCreate = (ctx) => {
  const selection = ctx.selection;
  const payPayload = {
    subServiceIds: selection.subServiceIds,
    studioId: selection.studioId,
    roomId: selection.roomId,
    trainers: { type: "NO_TRAINER" },
    paymentMethod: "WIDGET",
    baseRedirectUrl: "https://padlhub.ru/lk_dev?paymentProvider=a3pay",
    successUrl: "https://padlhub.ru/lk_dev?paymentProvider=a3pay",
    failUrl: "https://padlhub.ru/lk_dev?paymentProvider=a3pay",
    comment: `A3PAY_DEV:${ctx.operationId}`,
    marketingAttribution: {},
    timeFrom: `${selection.date}T${selection.fromTime}:00+03:00`,
    timeTo: `${selection.date}T${selection.toTime}:00+03:00`,
  };
  return prepareHttp(
    ctx,
    "provider_create",
    "POST",
    `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${encodeURIComponent(selection.masterServiceId)}/pay`,
    payPayload,
  );
};

if (ctx.step === "precreate_snapshot") {
  if (!isOk(msg.statusCode)) {
    return fail(ctx, 502, "Не удалось снять pre-write snapshot Viva", "A3PAY_DEV_PREWRITE_SNAPSHOT_FAILED");
  }
  const matchingRows = extractItems(msg.payload).filter((row) => (
    !isCancelledRow(row) && bookingStrictlyMatchesSelection(row, ctx.selection)
  ));
  const preexistingBookingIds = [...new Set(matchingRows.map(bookingIdOf).filter(Boolean))];
  ctx.preexistingBookingIds = preexistingBookingIds;
  const nowIso = new Date().toISOString();
  return prepareUpdate(ctx, "precreate_snapshot_update", {
    _id: ctx.operationKey,
    state: "SNAPSHOT_PENDING",
    claimToken: ctx.claimToken,
  }, {
    $set: {
      state: "PROVIDER_PENDING",
      preexistingBookingIds,
      prewriteSnapshotAt: nowIso,
      providerAttemptedAt: nowIso,
      updatedAt: nowIso,
    },
    $push: { transitions: { state: "PROVIDER_PENDING", at: nowIso } },
  });
}

if (ctx.step === "precreate_snapshot_update") {
  if (modifiedCount(msg.payload) !== 1) return prepareFind(ctx, "operation_find");
  return startProviderCreate(ctx);
}

if (ctx.step === "provider_create") {
  const nowIso = new Date().toISOString();
  if (!isOk(msg.statusCode)) {
    return prepareUpdate(ctx, "provider_unverified_update", {
      _id: ctx.operationKey,
      state: "PROVIDER_PENDING",
      claimToken: ctx.claimToken,
    }, {
      $set: {
        state: "PROVIDER_UNVERIFIED",
        providerStatus: Number(msg.statusCode) || null,
        updatedAt: nowIso,
      },
      $push: { transitions: { state: "PROVIDER_UNVERIFIED", at: nowIso } },
    });
  }
  const bookingIds = collectIds(msg.payload, new Set(["bookingId", "bookingIds", "paymentBookingIds", "clientBookingId"]));
  const exerciseIds = collectIds(msg.payload, new Set(["exerciseId", "vivaExerciseId"]));
  const transactionIds = collectIds(msg.payload, new Set(["transactionId", "transactionUuid"]));
  if (bookingIds.length !== 1) {
    return prepareUpdate(ctx, "provider_unverified_update", {
      _id: ctx.operationKey,
      state: "PROVIDER_PENDING",
      claimToken: ctx.claimToken,
    }, {
      $set: {
        state: "PROVIDER_UNVERIFIED",
        providerStatus: Number(msg.statusCode) || null,
        providerBookingIdCount: bookingIds.length,
        updatedAt: nowIso,
      },
      $push: { transitions: { state: "PROVIDER_UNVERIFIED", at: nowIso } },
    });
  }
  ctx.bookingId = bookingIds[0];
  ctx.exerciseId = exerciseIds.length === 1 ? exerciseIds[0] : null;
  ctx.transactionId = transactionIds.length === 1 ? transactionIds[0] : null;
  return prepareUpdate(ctx, "provider_result_update", {
    _id: ctx.operationKey,
    state: "PROVIDER_PENDING",
    claimToken: ctx.claimToken,
  }, {
    $set: {
      state: "PROVIDER_RESULT_RECEIVED",
      bookingId: ctx.bookingId,
      exerciseId: ctx.exerciseId,
      transactionId: ctx.transactionId,
      providerStatus: Number(msg.statusCode),
      updatedAt: nowIso,
    },
    $unset: { claimToken: "" },
    $push: { transitions: { state: "PROVIDER_RESULT_RECEIVED", at: nowIso } },
  });
}

if (ctx.step === "provider_unverified_update") {
  if (Array.isArray(ctx.preexistingBookingIds)) return startProviderRecoveryReadback(ctx);
  return inProgress(ctx, "Viva не дала однозначного результата. Повтор создания автоматически не выполняется.", "PROVIDER_UNVERIFIED");
}

if (ctx.step === "provider_result_update") {
  if (modifiedCount(msg.payload) !== 1) return prepareFind(ctx, "operation_find");
  return startBookingReadback(ctx);
}

if (ctx.step === "provider_recovery_readback") {
  if (!isOk(msg.statusCode)) {
    return inProgress(ctx, "Результат Viva неоднозначен; recovery read-back пока недоступен.", "PROVIDER_UNVERIFIED");
  }
  const beforeIds = new Set(asArray(ctx.preexistingBookingIds).map(normalizeId).filter(Boolean));
  const candidates = extractItems(msg.payload).filter((row) => (
    !isCancelledRow(row)
    && bookingStrictlyMatchesSelection(row, ctx.selection)
    && bookingMatchesRecoveryWindow(row, ctx.providerAttemptedAt)
    && bookingHasOperationMarker(row, ctx.operationId)
    && !beforeIds.has(normalizeId(bookingIdOf(row)))
  ));
  if (candidates.length !== 1) {
    return inProgress(ctx, "Recovery read-back не нашёл ровно одну новую бронь; автоматический повтор запрещён.", "PROVIDER_UNVERIFIED");
  }
  ctx.bookingId = bookingIdOf(candidates[0]);
  ctx.exerciseId = toStr(candidates[0]?.exerciseId || candidates[0]?.exercise?.id);
  const nowIso = new Date().toISOString();
  return prepareUpdate(ctx, "provider_recovery_update", {
    _id: ctx.operationKey,
    state: { $in: ["PROVIDER_PENDING", "PROVIDER_UNVERIFIED"] },
  }, {
    $set: {
      state: "PROVIDER_RESULT_RECEIVED",
      bookingId: ctx.bookingId,
      exerciseId: ctx.exerciseId,
      recoveredByReadback: true,
      recoveredAt: nowIso,
      updatedAt: nowIso,
    },
    $unset: { claimToken: "" },
    $push: { transitions: { state: "PROVIDER_RESULT_RECEIVED", at: nowIso } },
  });
}

if (ctx.step === "provider_recovery_update") {
  if (modifiedCount(msg.payload) !== 1) return prepareFind(ctx, "operation_find");
  return startBookingReadback(ctx);
}

if (ctx.step === "create_readback") {
  if (!isOk(msg.statusCode)) {
    return inProgress(ctx, "Бронь получена от Viva, но её read-back пока не подтверждён.");
  }
  const matches = extractItems(msg.payload).filter((row) => (
    normalizeId(bookingIdOf(row)) === normalizeId(ctx.bookingId)
  ));
  if (matches.length !== 1 || isCancelledRow(matches[0]) || !bookingMatchesSelection(matches[0], ctx.selection)) {
    return inProgress(ctx, "Бронь получена от Viva, но точный read-back пока не совпал.");
  }
  const nowIso = new Date().toISOString();
  return prepareUpdate(ctx, "booking_confirmed_update", {
    _id: ctx.operationKey,
    state: "PROVIDER_RESULT_RECEIVED",
    bookingId: ctx.bookingId,
  }, {
    $set: { state: "VIVA_BOOKING_CREATED", verifiedAt: nowIso, updatedAt: nowIso },
    $push: { transitions: { state: "VIVA_BOOKING_CREATED", at: nowIso } },
  });
}

if (ctx.step === "booking_confirmed_update") {
  if (modifiedCount(msg.payload) !== 1) return prepareFind(ctx, "operation_find");
  return confirmed(ctx, ctx, 201);
}

if (ctx.step === "cancel_probe") {
  if (!isOk(msg.statusCode)) {
    return fail(ctx, Number(msg.statusCode) || 502, "Viva не подтвердила безопасный сценарий отмены", "A3PAY_DEV_CANCEL_PROBE_FAILED");
  }
  const options = msg.payload?.cancellationOptions || msg.payload?.data?.cancellationOptions || {};
  if (options?.cancellationOnly?.available !== true) {
    return fail(ctx, 409, "Viva не предложила отмену без возврата; автоматическая отмена остановлена", "A3PAY_DEV_CANCEL_MODE_UNSUPPORTED");
  }
  const nowIso = new Date().toISOString();
  return prepareUpdate(ctx, "cancel_claim", {
    _id: ctx.operationKey,
    state: "VIVA_BOOKING_CREATED",
    bookingId: ctx.bookingId,
  }, {
    $set: { state: "CANCEL_PENDING", cancelAttemptedAt: nowIso, updatedAt: nowIso },
    $push: { transitions: { state: "CANCEL_PENDING", at: nowIso } },
  });
}

if (ctx.step === "cancel_claim") {
  if (modifiedCount(msg.payload) !== 1) return prepareFind(ctx, "operation_find");
  return prepareHttp(
    ctx,
    "cancel_delete",
    "DELETE",
    `/end-user/api/v1/${ctx.tenantKey}/bookings/${encodeURIComponent(ctx.bookingId)}`,
    {},
  );
}

if (ctx.step === "cancel_delete") {
  ctx.cancelStatus = Number(msg.statusCode) || null;
  return startCancelReadback(ctx);
}

if (ctx.step === "cancel_readback") {
  if (!isOk(msg.statusCode)) {
    return inProgress(ctx, "Запрос отмены отправлен, но read-back Viva пока недоступен.");
  }
  const rows = extractItems(msg.payload).filter((row) => (
    normalizeId(bookingIdOf(row)) === normalizeId(ctx.bookingId)
  ));
  const active = rows.find((row) => !isCancelledRow(row));
  const nowIso = new Date().toISOString();
  if (active) {
    return prepareUpdate(ctx, "cancel_active_update", {
      _id: ctx.operationKey,
      state: "CANCEL_PENDING",
      bookingId: ctx.bookingId,
    }, {
      $set: {
        state: "VIVA_BOOKING_CREATED",
        lastCancelStatus: ctx.cancelStatus,
        updatedAt: nowIso,
      },
      $push: { transitions: { state: "CANCEL_NOT_CONFIRMED", at: nowIso } },
    });
  }
  return startCancelHistoryReadback(ctx);
}

if (ctx.step === "cancel_history_readback") {
  if (!isOk(msg.statusCode)) {
    return inProgress(ctx, "Активная бронь исчезла, но история Viva пока не подтвердила отмену.");
  }
  const cancelledRows = extractItems(msg.payload).filter((row) => (
    normalizeId(bookingIdOf(row)) === normalizeId(ctx.bookingId) && isCancelledRow(row)
  ));
  if (cancelledRows.length !== 1) {
    return inProgress(ctx, "История Viva не подтвердила точную отменённую бронь.");
  }
  const nowIso = new Date().toISOString();
  return prepareUpdate(ctx, "cancel_confirmed_update", {
    _id: ctx.operationKey,
    state: "CANCEL_PENDING",
    bookingId: ctx.bookingId,
  }, {
    $set: {
      state: "CANCELLED",
      cancelledAt: nowIso,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      lastCancelStatus: ctx.cancelStatus,
      updatedAt: nowIso,
    },
    $push: { transitions: { state: "CANCELLED", at: nowIso } },
  });
}

if (ctx.step === "cancel_active_update") {
  return fail(ctx, 409, "Viva всё ещё показывает бронь активной; повтор отмены возможен после проверки", "A3PAY_DEV_CANCEL_NOT_CONFIRMED");
}

if (ctx.step === "cancel_confirmed_update") {
  if (modifiedCount(msg.payload) !== 1) return prepareFind(ctx, "operation_find");
  return cancelled(ctx, ctx);
}

return fail(ctx, 500, "Неизвестный этап тестовой брони", "A3PAY_DEV_STEP_UNKNOWN", { step: ctx.step });
