const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const END_USER_API = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";
const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const KEY_TOKEN_REQUEST_BODY = "vivacrm_token_request_body";
const TOKEN_CACHE_GRACE_MS = 30 * 1000;
const DEFAULT_TOKEN_REQUEST_BODY =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const uniq = (values) => {
  const result = [];
  const used = new Set();
  values.forEach((item) => {
    const normalized = toStr(item);
    if (!normalized || used.has(normalized)) return;
    used.add(normalized);
    result.push(normalized);
  });
  return result;
};

const clone = (value) => {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
};
const AUDIT_MAX_EVENTS = 200;

const buildAuditEventId = () => `g_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const buildCleanupAuditEvent = (ctx, nowIso, details) => ({
  id: buildAuditEventId(),
  at: nowIso,
  type: ctx.mode === "PARTICIPANT_TIMEOUT"
    ? "SPLIT_PARTICIPANT_TIMEOUT_CLEANUP_APPLIED"
    : "SPLIT_GAME_CLEANUP_APPLIED",
  source: "split_cleanup",
  payload: {
    gameId: ctx.gameId || null,
    mode: ctx.mode || "GAME_CLEANUP",
    reason: ctx.reason || null,
    dryRun: ctx.dryRun === true,
    bookingIds: uniq(ctx.initialBookingIds || []),
    ...details,
  },
});

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const normalizeComparableId = (value) => {
  const text = toStr(value);
  return text ? text.toLowerCase() : null;
};

const sameIdentity = (left, right) => {
  if (!left || !right) return false;
  const leftId = normalizeComparableId(left.id || left.clientId || left.playerId || left.userId);
  const rightId = normalizeComparableId(right.id || right.clientId || right.playerId || right.userId);
  if (leftId && rightId && leftId === rightId) return true;
  const leftPhone = normalizePhone(left.phone || left.phoneNorm || left.clientPhone || left.playerPhone);
  const rightPhone = normalizePhone(right.phone || right.phoneNorm || right.clientPhone || right.playerPhone);
  if (leftPhone && rightPhone && leftPhone === rightPhone) return true;
  return false;
};

const normalizeTransactionStatus = (value) => String(value || "").trim().toUpperCase();

const extractTransactionPayload = (payload) => {
  if (!payload || typeof payload !== "object") return {};
  const candidates = [
    payload,
    payload.data,
    payload.payload,
    payload.result,
    payload.transaction,
    payload.transactionStatus,
    payload.cardPaymentStatus,
    payload.payment,
    payload.paymentInfo,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const status = normalizeTransactionStatus(
      candidate.status
      || candidate.state
      || candidate.paymentStatus
      || candidate.transactionStatus,
    );
    const toPay = toNumber(candidate.toPay);
    if (status || toPay !== null) {
      return candidate;
    }
  }
  return payload;
};

const isPaidTransactionPayload = (payload) => {
  const tx = extractTransactionPayload(payload);
  const status = normalizeTransactionStatus(
    tx.status
    || tx.state
    || tx.paymentStatus
    || tx.transactionStatus,
  );
  if (
    status.includes("PAID")
    || status.includes("SUCCESS")
    || status.includes("COMPLETE")
    || status.includes("APPROV")
    || status.includes("CONFIRM")
  ) {
    return true;
  }
  if (
    status.includes("FAIL")
    || status.includes("CANCEL")
    || status.includes("REJECT")
    || status.includes("ERROR")
    || status.includes("EXPIRE")
    || status.includes("REFUND")
    || status.includes("VOID")
  ) {
    return false;
  }
  const toPay = toNumber(tx.toPay);
  return toPay !== null && toPay <= 0;
};

const buildTimedOutPaymentByBooking = (values) => {
  const map = {};
  asArray(values).forEach((item) => {
    if (!item || typeof item !== "object") return;
    const bookingIds = uniq([
      ...asArray(item.bookingIds),
      item.bookingId,
    ]);
    if (bookingIds.length === 0) return;
    const entry = {
      paymentRef: toStr(item.paymentRef),
      transactionId: toStr(item.transactionId),
      clientId: toStr(item.clientId || item.playerId || item.userId),
      phone: normalizePhone(item.phone || item.phoneNorm || item.clientPhone || item.playerPhone),
      name: toStr(item.name || item.playerName || item.clientName) || "Игрок",
      bookingIds,
      playerBucket: toStr(item.playerBucket),
      playerSnapshot: item.playerSnapshot && typeof item.playerSnapshot === "object"
        ? clone(item.playerSnapshot)
        : null,
    };
    bookingIds.forEach((bookingId) => {
      const existing = map[bookingId];
      if (!existing) {
        map[bookingId] = entry;
        return;
      }
      if (!existing.transactionId && entry.transactionId) existing.transactionId = entry.transactionId;
      if (!existing.clientId && entry.clientId) existing.clientId = entry.clientId;
      if (!existing.phone && entry.phone) existing.phone = entry.phone;
      if (!existing.name && entry.name) existing.name = entry.name;
      if (!existing.playerBucket && entry.playerBucket) existing.playerBucket = entry.playerBucket;
      if (!existing.playerSnapshot && entry.playerSnapshot) existing.playerSnapshot = clone(entry.playerSnapshot);
      existing.bookingIds = uniq([...(existing.bookingIds || []), ...entry.bookingIds]);
    });
  });
  return map;
};

const removePlayersByIdentity = (list, identity) => asArray(list).filter((item) => !sameIdentity(item, identity));

const upsertPlayerByIdentity = (list, player) => {
  const source = asArray(list);
  const idx = source.findIndex((item) => sameIdentity(item, player));
  if (idx === -1) {
    source.push(player);
    return source;
  }
  source[idx] = {
    ...source[idx],
    ...player,
    id: source[idx].id || player.id || null,
    phone: source[idx].phone || player.phone || null,
    phoneNorm: source[idx].phoneNorm || player.phoneNorm || null,
  };
  return source;
};

const removeTimeoutLeaveEventsByIdentity = (events, identity) => (
  asArray(events).filter((item) => {
    const reason = String(item?.reason || "").trim().toUpperCase();
    if (reason !== "AUTO_PAYMENT_TIMEOUT") return true;
    return !sameIdentity(
      { id: item?.playerId, phone: item?.playerPhone },
      identity,
    );
  })
);

const collectIdentityPhones = (players) => uniq(
  asArray(players).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return [
      normalizePhone(item.phone || item.phoneNorm || item.clientPhone || item.playerPhone),
    ];
  }),
);

const collectIdentityIds = (players) => uniq(
  asArray(players).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return [
      toStr(item.id || item.clientId || item.playerId || item.userId),
    ];
  }),
);

const collectActivePaymentPhones = (payments) => uniq(
  asArray(payments).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (String(item.status || "").trim().toUpperCase() === "EXPIRED") return [];
    return [
      normalizePhone(item.phone || item.phoneNorm || item.clientPhone || item.playerPhone),
    ];
  }),
);

const collectActivePaymentIds = (payments) => uniq(
  asArray(payments).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (String(item.status || "").trim().toUpperCase() === "EXPIRED") return [];
    return [
      toStr(item.clientId || item.playerId || item.userId || item.id),
    ];
  }),
);

const buildIdentityProjectionSet = (ctx, splitPayments) => {
  const participantPhones = collectIdentityPhones(ctx.nextParticipants);
  const waitlistPhones = collectIdentityPhones(ctx.nextWaitlist);
  const participantIds = collectIdentityIds(ctx.nextParticipants);
  const waitlistIds = collectIdentityIds(ctx.nextWaitlist);
  const activePaymentPhones = collectActivePaymentPhones(splitPayments);
  const activePaymentIds = collectActivePaymentIds(splitPayments);

  return {
    participantPhones,
    waitlistPhones,
    participantIds,
    waitlistIds,
    allRelatedPhones: uniq([
      ...participantPhones,
      ...waitlistPhones,
      ...activePaymentPhones,
    ]),
    allRelatedClientIds: uniq([
      ...participantIds,
      ...waitlistIds,
      ...activePaymentIds,
    ]),
  };
};

const recoverPaidTimedOutState = (ctx, timeoutMeta, transactionPayload) => {
  if (!timeoutMeta || typeof timeoutMeta !== "object") return;
  const nowIso = new Date().toISOString();
  const tx = extractTransactionPayload(transactionPayload);
  const txStatus = normalizeTransactionStatus(
    tx.status
    || tx.state
    || tx.paymentStatus
    || tx.transactionStatus,
  ) || null;

  const bookingIds = uniq([
    ...asArray(timeoutMeta.bookingIds),
  ]);
  const metaIdentity = {
    id: timeoutMeta.clientId || null,
    phone: timeoutMeta.phone || null,
  };

  ctx.nextSplitPayments = asArray(ctx.nextSplitPayments).map((item) => {
    if (!item || typeof item !== "object") return item;
    const itemBookingIds = uniq([
      ...asArray(item.bookingIds),
      item.bookingId,
    ]);
    const itemTxId = toStr(item.transactionId);
    const itemPaymentRef = toStr(item.paymentRef);
    const matchesBooking = itemBookingIds.some((bookingId) => bookingIds.includes(bookingId));
    const matchesTransaction = timeoutMeta.transactionId && itemTxId && timeoutMeta.transactionId === itemTxId;
    const matchesPaymentRef = timeoutMeta.paymentRef && itemPaymentRef && timeoutMeta.paymentRef === itemPaymentRef;
    if (!matchesBooking && !matchesTransaction && !matchesPaymentRef) return item;
    return {
      ...item,
      status: "PAID",
      cancelReason: null,
      cancelledAt: null,
      leftAt: null,
      paidAt: toStr(item.paidAt) || nowIso,
      transactionStatus: txStatus || toStr(item.transactionStatus) || null,
      transactionStatusCheckedAt: nowIso,
      transactionStatusSource: "split_cleanup",
    };
  });

  const fallbackPlayer = {
    id: timeoutMeta.clientId || null,
    name: timeoutMeta.name || "Игрок",
    phone: timeoutMeta.phone || null,
    phoneNorm: timeoutMeta.phone || null,
    source: "INVITE_LINK",
    status: timeoutMeta.playerBucket === "waitlist" ? "WAITLIST" : "CONFIRMED",
  };
  const playerSnapshot = timeoutMeta.playerSnapshot && typeof timeoutMeta.playerSnapshot === "object"
    ? clone(timeoutMeta.playerSnapshot)
    : fallbackPlayer;

  const cleanParticipants = removePlayersByIdentity(ctx.nextParticipants, metaIdentity);
  const cleanWaitlist = removePlayersByIdentity(ctx.nextWaitlist, metaIdentity);

  if (timeoutMeta.playerBucket === "waitlist") {
    ctx.nextParticipants = cleanParticipants;
    ctx.nextWaitlist = upsertPlayerByIdentity(cleanWaitlist, {
      ...playerSnapshot,
      status: "WAITLIST",
    });
  } else {
    ctx.nextWaitlist = cleanWaitlist;
    ctx.nextParticipants = upsertPlayerByIdentity(cleanParticipants, {
      ...playerSnapshot,
      status: "CONFIRMED",
    });
  }

  ctx.nextLeaveEvents = removeTimeoutLeaveEventsByIdentity(ctx.nextLeaveEvents, metaIdentity);
};

const appendTrace = (ctx, entry) => {
  if (!Array.isArray(ctx.trace)) ctx.trace = [];
  ctx.trace.push({
    at: new Date().toISOString(),
    ...entry,
  });
};

const readCachedAdminToken = () => {
  const token = toStr(global.get(KEY_TOKEN));
  const expiresAtRaw = Number(global.get(KEY_EXPIRES_AT) || 0);
  const expiresAt = Number.isFinite(expiresAtRaw) ? expiresAtRaw : 0;
  if (!token || expiresAt <= Date.now() + TOKEN_CACHE_GRACE_MS) return null;
  return token;
};

const resolveTokenRequestConfig = () => {
  const payload = toStr(global.get(KEY_TOKEN_REQUEST_BODY));
  if (payload) {
    return {
      payload,
      source: KEY_TOKEN_REQUEST_BODY,
    };
  }
  return {
    payload: DEFAULT_TOKEN_REQUEST_BODY,
    source: "default_inline",
  };
};

const persistAdminToken = (token, expiresInRaw) => {
  const normalizedToken = toStr(token);
  if (!normalizedToken) return;
  const expiresIn = Number(expiresInRaw);
  const ttlSec = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300;
  global.set(KEY_TOKEN, normalizedToken);
  global.set(KEY_EXPIRES_AT, Date.now() + ttlSec * 1000);
};

const adminRequest = (ctx, method, path, payload) => {
  msg._splitCleanupCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, null, null];
};

const endUserRequest = (ctx, method, path, payload) => {
  const cleanupAuth = msg._splitCleanupAuth && typeof msg._splitCleanupAuth === "object"
    ? msg._splitCleanupAuth
    : {};
  msg._splitCleanupCtx = ctx;
  msg.method = method;
  msg.url = `${END_USER_API}${path}`;
  msg.headers = {
    Authorization: toStr(cleanupAuth.authHeader),
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, null, null];
};

const bookingApiRequest = (ctx, request) => (
  request?.scope === "end_user"
    ? endUserRequest(ctx, request.method, request.path, request.payload)
    : adminRequest(ctx, request.method, request.path, request.payload)
);

const requestToken = (ctx) => {
  const cachedToken = readCachedAdminToken();
  if (cachedToken) {
    ctx.token = cachedToken;
    appendTrace(ctx, {
      step: "token_cached",
    });
    const bookingReq = nextBookingRequest(ctx);
    if (bookingReq) return bookingReq;
    const exerciseReq = nextExerciseRequest(ctx);
    if (exerciseReq) return exerciseReq;
    return finalizeTask(ctx);
  }

  const tokenRequest = resolveTokenRequestConfig();
  msg._splitCleanupCtx = ctx;
  msg.method = "POST";
  msg.url = TOKEN_URL;
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.payload = tokenRequest.payload;
  appendTrace(ctx, {
    step: "token_request_sent",
    source: tokenRequest.source,
  });
  return [msg, null, null, null];
};

const isAlreadyCancelledResponse = (statusCode, payload) => {
  if (![400, 409, 422].includes(Number(statusCode))) return false;
  const text = JSON.stringify(payload || {}).toLowerCase();
  return (
    text.includes("already") && text.includes("cancel")
  ) || text.includes("уже отмен");
};

const normalizeBookingQueueItem = (value, fallbackClientId = null) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      bookingId: toStr(value.bookingId || value.id || value.uuid),
      clientId: toStr(value.clientId || value.playerId || value.userId) || fallbackClientId || null,
      transactionId: toStr(value.transactionId || value.transaction?.id || value.transactionUuid),
      paymentRef: toStr(value.paymentRef),
    };
  }
  return {
    bookingId: toStr(value),
    clientId: fallbackClientId || null,
    transactionId: null,
    paymentRef: null,
  };
};

const uniqBookingQueue = (values) => {
  const result = [];
  const indexByBookingId = new Map();
  asArray(values).forEach((item) => {
    const normalized = normalizeBookingQueueItem(item, null);
    const bookingId = toStr(normalized.bookingId);
    if (!bookingId) return;
    const clientId = toStr(normalized.clientId) || null;
    const key = bookingId.toLowerCase();
    const existingIndex = indexByBookingId.get(key);
    if (existingIndex !== undefined) {
      if (!result[existingIndex].clientId && clientId) {
        result[existingIndex].clientId = clientId;
      }
      return;
    }
    indexByBookingId.set(key, result.length);
    result.push({
      bookingId,
      clientId,
      transactionId: toStr(normalized.transactionId),
      paymentRef: toStr(normalized.paymentRef),
    });
  });
  return result;
};

const normalizeRefundMethod = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw.toUpperCase();
  if (normalized === "CURRENCY" || normalized === "DEPOSIT") return normalized;
  return null;
};

const normalizeCancellationActionId = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (["card", "deposit", "subscription", "none"].includes(normalized)) return normalized;
  return null;
};

const resolvePreferredRefundMethod = (ctx) => {
  const preferredRefundMethod = normalizeRefundMethod(ctx?.preferredRefundMethod);
  if (preferredRefundMethod) return preferredRefundMethod;
  const cancellationActionId = normalizeCancellationActionId(ctx?.cancellationActionId);
  if (cancellationActionId === "card") return "CURRENCY";
  if (cancellationActionId === "deposit") return "DEPOSIT";
  return null;
};

const isActorBooking = (ctx, bookingId) => (
  Boolean(
    normalizeComparableId(ctx?.actorBookingId)
    && normalizeComparableId(ctx?.actorBookingId) === normalizeComparableId(bookingId),
  )
);

const buildBookingCancelProbe = (ctx, bookingId, clientId) => {
  const encodedId = encodeURIComponent(bookingId);
  if (isActorBooking(ctx, bookingId)) {
    return {
      scope: "end_user",
      method: "GET",
      path: `/bookings/${encodedId}/cancel`,
      payload: undefined,
      label: "end_user_cancel_probe",
    };
  }
  if (clientId) {
    return {
      scope: "admin",
      method: "GET",
      path: `/clients/${encodeURIComponent(clientId)}/bookings/${encodedId}/cancel`,
      payload: undefined,
      label: "admin_client_cancel_probe",
    };
  }
  if (ctx.exerciseId) {
    return {
      scope: "admin",
      method: "GET",
      path: `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings/${encodedId}/cancel`,
      payload: undefined,
      label: "admin_exercise_cancel_probe",
    };
  }
  return {
    unsupportedReason: "Не удалось определить клиента или занятие для отмены записи",
    unsupportedCode: "missing_scoped_booking_target",
  };
};

const buildScopedBookingCancelRequest = (ctx, bookingId, clientId, options) => {
  const encodedId = encodeURIComponent(bookingId);
  if (isActorBooking(ctx, bookingId)) {
    return {
      scope: "end_user",
      method: "DELETE",
      path: `/bookings/${encodedId}`,
      payload: options.endUserPayload ?? {},
      label: `end_user_${options.label}`,
      refundMethod: options.refundMethod || null,
      refundMessage: options.refundMessage || null,
    };
  }

  const adminPayload = {
    refundMethod: options.adminRefundMethod,
    cancelExercise: false,
  };
  if (clientId) {
    return {
      scope: "admin",
      method: "PUT",
      path: `/clients/${encodeURIComponent(clientId)}/bookings/${encodedId}/cancel`,
      payload: adminPayload,
      label: `admin_client_${options.label}`,
      refundMethod: options.refundMethod || options.adminRefundMethod || null,
      refundMessage: options.refundMessage || null,
    };
  }
  if (ctx.exerciseId) {
    return {
      scope: "admin",
      method: "DELETE",
      path: `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings/${encodedId}`,
      payload: adminPayload,
      label: `admin_exercise_${options.label}`,
      refundMethod: options.refundMethod || options.adminRefundMethod || null,
      refundMessage: options.refundMessage || null,
    };
  }
  return {
    unsupportedReason: "Не удалось определить клиента или занятие для отмены записи",
    unsupportedCode: "missing_scoped_booking_target",
  };
};

const buildClientBookingVerifyRequest = (clientId, bookingId) => ({
  method: "GET",
  path: `/clients/${encodeURIComponent(clientId)}/bookings/${encodeURIComponent(bookingId)}`,
  payload: undefined,
  label: "verify_client_booking",
});

const buildExerciseBookingsVerifyRequest = (exerciseId) => ({
  method: "GET",
  path: `/exercises/${encodeURIComponent(exerciseId)}/bookings?showCancelled=true&page=0&size=200`,
  payload: undefined,
  label: "verify_exercise_bookings",
});

const isCancelledBookingRow = (row) => {
  if (!row || typeof row !== "object") return false;
  if (row.isCancelled === true || row.cancelled === true) return true;
  if (toStr(row.cancellationDate || row.cancelledAt)) return true;
  const status = String(row.bookingStatus || row.status || row.state || "").trim().toUpperCase();
  return status.includes("CANCEL");
};

const isCancelledExercise = (value) => {
  if (!value || typeof value !== "object") return false;
  if (value.isCancelled === true || value.cancelled === true || value.deleted === true) return true;
  if (toStr(value.cancellationDate || value.cancelledAt || value.deletedAt)) return true;
  const status = String(
    value.exerciseStatus || value.status || value.state || "",
  ).trim().toUpperCase();
  return status.includes("CANCEL") || status.includes("DELETE");
};

const extractBookingRows = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.content)) return payload.content;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.content)) return payload.data.content;
    if (Array.isArray(payload.data.items)) return payload.data.items;
  }
  return [];
};

const findBookingRow = (payload, bookingId) => {
  const normalizedBookingId = normalizeComparableId(bookingId);
  if (!normalizedBookingId) return null;
  return extractBookingRows(payload).find((row) => (
    normalizeComparableId(row?.id || row?.bookingId || row?.uuid) === normalizedBookingId
  )) || null;
};

const isAvailableCancellationOption = (value) => value?.available === true;

const resolveBookingCancellationOptions = (payload) => {
  const root = payload && typeof payload === "object" ? payload : {};
  const options = root.cancellationOptions && typeof root.cancellationOptions === "object"
    ? root.cancellationOptions
    : {};

  return {
    money: isAvailableCancellationOption(options.money),
    deposit: isAvailableCancellationOption(options.deposit),
    subscription: isAvailableCancellationOption(options.subscription),
    cancellationOnly: isAvailableCancellationOption(options.cancellationOnly),
    settlementAccount: isAvailableCancellationOption(options.settlementAccount),
    exercise: isAvailableCancellationOption(options.exercise),
  };
};

const pickBookingCancellationRequest = (ctx, bookingId, clientId, payload) => {
  const options = resolveBookingCancellationOptions(payload);
  const preferredRefundMethod = resolvePreferredRefundMethod(ctx);
  const cancellationActionId = normalizeCancellationActionId(ctx.cancellationActionId);

  if (preferredRefundMethod === "DEPOSIT") {
    if (!options.deposit) {
      return {
        unsupportedReason: "Возврат на депозит недоступен для этой записи",
        unsupportedCode: "preferred_refund_method_unavailable",
      };
    }
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: { refundMethod: "DEPOSIT" },
      adminRefundMethod: "DEPOSIT",
      label: "delete_deposit",
      refundMethod: "DEPOSIT",
    });
  }

  if (preferredRefundMethod === "CURRENCY") {
    if (!options.money) {
      return {
        unsupportedReason: "Возврат на карту недоступен для этой записи",
        unsupportedCode: "preferred_refund_method_unavailable",
      };
    }
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: { refundMethod: "CURRENCY" },
      adminRefundMethod: "CURRENCY",
      label: "delete_currency",
      refundMethod: "CURRENCY",
    });
  }

  if (cancellationActionId === "subscription") {
    if (!options.subscription && !options.exercise) {
      return {
        unsupportedReason: "Возврат занятия на абонемент недоступен для этой записи",
        unsupportedCode: "preferred_cancellation_action_unavailable",
      };
    }
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: {},
      adminRefundMethod: "SERVICE",
      label: "delete_subscription",
      refundMethod: null,
      refundMessage: "Вернули 1 занятие на абонемент.",
    });
  }

  if (cancellationActionId === "none") {
    if (!options.cancellationOnly) {
      return {
        unsupportedReason: "Отмена без возврата недоступна для этой записи",
        unsupportedCode: "preferred_cancellation_action_unavailable",
      };
    }
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: {},
      adminRefundMethod: "NONE",
      label: "delete_plain",
      refundMethod: null,
      refundMessage: "Запись отменена без возврата средств.",
    });
  }

  if (options.money) {
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: { refundMethod: "CURRENCY" },
      adminRefundMethod: "CURRENCY",
      label: "delete_currency",
      refundMethod: "CURRENCY",
    });
  }

  if (options.deposit) {
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: { refundMethod: "DEPOSIT" },
      adminRefundMethod: "DEPOSIT",
      label: "delete_deposit",
      refundMethod: "DEPOSIT",
    });
  }

  if (options.subscription) {
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: {},
      adminRefundMethod: "SERVICE",
      label: "delete_subscription",
      refundMethod: null,
      refundMessage: "Вернули 1 занятие на абонемент.",
    });
  }

  if (options.cancellationOnly) {
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: {},
      adminRefundMethod: "NONE",
      label: "delete_plain",
      refundMethod: null,
      refundMessage: "Запись отменена без возврата средств.",
    });
  }

  if (options.settlementAccount) {
    return {
      unsupportedReason: "Viva предлагает возврат только на лицевой счет",
      unsupportedCode: "unsupported_settlement_account",
    };
  }

  if (options.exercise) {
    if (isActorBooking(ctx, bookingId)) {
      return {
        unsupportedReason: "Viva предлагает неподдержанный вариант возврата собственной записи",
        unsupportedCode: "unsupported_exercise_refund",
      };
    }
    return buildScopedBookingCancelRequest(ctx, bookingId, clientId, {
      endUserPayload: {},
      adminRefundMethod: "SERVICE",
      label: "delete_service",
      refundMethod: null,
    });
  }

  return {
    unsupportedReason: "Для записи нет поддержанного сценария возврата",
    unsupportedCode: "unsupported_refund_method",
  };
};

const buildExerciseAttempt = (ctx, attempt) => {
  const encodedId = encodeURIComponent(ctx.exerciseId);
  switch (attempt) {
    case 0:
      return {
        method: "DELETE",
        path: `/exercises/${encodedId}`,
        payload: {},
        label: "delete_exercise",
      };
    case 1:
      return {
        method: "POST",
        path: `/exercises/${encodedId}/cancel`,
        payload: {},
        label: "cancel_exercise",
      };
    default:
      return {
        method: "PATCH",
        path: `/exercises/${encodedId}`,
        payload: { status: "CANCELLED" },
        label: "patch_exercise_cancelled",
      };
  }
};

const startGenericBookingCancel = (ctx, bookingId, clientId, meta = {}) => {
  const probeRequest = buildBookingCancelProbe(ctx, bookingId, clientId);
  if (!probeRequest || probeRequest.unsupportedReason) {
    ctx.blockLocalMutation = true;
    ctx.blockReason = probeRequest?.unsupportedCode || "missing_scoped_booking_target";
    appendTrace(ctx, {
      step: "cancel_booking_probe_unsupported",
      bookingId,
      clientId: clientId || null,
      unsupportedReason: probeRequest?.unsupportedReason || null,
      unsupportedCode: probeRequest?.unsupportedCode || null,
      ...meta,
    });
    return pushBookingFailureAndContinue(ctx, {
      bookingId,
      clientId,
      method: "scoped_booking",
      unsupportedReason: probeRequest?.unsupportedReason || "Missing scoped booking target",
    });
  }
  ctx.currentBookingId = bookingId;
  ctx.currentClientId = clientId || null;
  ctx.currentCancelRequest = null;
  ctx.step = "cancel_booking_probe";
  appendTrace(ctx, {
    step: "cancel_booking_probe_request",
    bookingId,
    clientId: clientId || null,
    attemptLabel: probeRequest.label,
    scope: probeRequest.scope,
    ...meta,
  });
  return bookingApiRequest(ctx, probeRequest);
};

const nextBookingRequest = (ctx) => {
  if (!Array.isArray(ctx.bookingQueue) || ctx.bookingQueue.length === 0) return null;
  const queueItem = normalizeBookingQueueItem(ctx.bookingQueue.shift(), null);
  const bookingId = toStr(queueItem.bookingId);
  if (!bookingId) return nextBookingRequest(ctx);
  const clientId = toStr(queueItem.clientId) || null;
  const timeoutMeta = ctx.timedOutPaymentByBooking && typeof ctx.timedOutPaymentByBooking === "object"
    ? (ctx.timedOutPaymentByBooking[bookingId] || null)
    : null;
  const fallbackClientId = toStr(timeoutMeta?.clientId) || null;
  const effectiveClientId = clientId || fallbackClientId || null;
  const transactionId = toStr(queueItem.transactionId) || toStr(timeoutMeta?.transactionId) || null;
  const paymentRef = toStr(queueItem.paymentRef) || toStr(timeoutMeta?.paymentRef) || null;

  if (ctx.mode === "PARTICIPANT_TIMEOUT" && transactionId) {
    ctx.currentBookingId = bookingId;
    ctx.currentClientId = effectiveClientId;
    ctx.currentTimedOutPayment = {
      ...(timeoutMeta && typeof timeoutMeta === "object" ? timeoutMeta : {}),
      bookingIds: uniq([
        ...asArray(timeoutMeta?.bookingIds),
        bookingId,
      ]),
      transactionId,
      paymentRef,
      clientId: effectiveClientId || timeoutMeta?.clientId || null,
    };
    ctx.step = "check_timeout_transaction";
    appendTrace(ctx, {
      step: "check_timeout_transaction_request",
      bookingId,
      clientId: effectiveClientId || null,
      transactionId,
      paymentRef: paymentRef || null,
    });
    return adminRequest(
      ctx,
      "GET",
      `/transactions/${encodeURIComponent(transactionId)}`,
      undefined,
    );
  }

  return startGenericBookingCancel(ctx, bookingId, effectiveClientId, {
    fallback: effectiveClientId ? null : "missing_client_id",
    paymentRef: paymentRef || null,
    transactionId: transactionId || null,
  });
};

const nextExerciseRequest = (ctx) => {
  if (!ctx.exerciseId || ctx.exerciseProcessed === true) return null;

  const attempt = Number.isFinite(Number(ctx.exerciseAttempt))
    ? Number(ctx.exerciseAttempt)
    : 0;
  const attemptPayload = buildExerciseAttempt(ctx, attempt);

  ctx.step = "cancel_exercise";
  ctx.exerciseAttempt = attempt;
  appendTrace(ctx, {
    step: "cancel_exercise_request",
    exerciseId: ctx.exerciseId,
    attempt,
    attemptLabel: attemptPayload.label,
  });
  return adminRequest(ctx, attemptPayload.method, attemptPayload.path, attemptPayload.payload);
};

const pushBookingSuccessAndContinue = (ctx, result) => {
  ctx.bookingResults.push({
    bookingId: result.bookingId,
    ok: true,
    clientId: result.clientId || null,
    method: result.method || "generic_booking",
    refundMethod: result.refundMethod || null,
    alreadyCancelled: result.alreadyCancelled === true,
    verifiedAbsent: result.verifiedAbsent === true,
    statusCode: result.statusCode,
  });
  ctx.currentBookingId = null;
  ctx.currentClientId = null;
  ctx.currentCancelRequest = null;
  ctx.currentVerifyRequest = null;

  const bookingReq = nextBookingRequest(ctx);
  if (bookingReq) return bookingReq;

  const exerciseReq = nextExerciseRequest(ctx);
  if (exerciseReq) return exerciseReq;

  return finalizeTask(ctx);
};

const startBookingVerification = (ctx, bookingId, clientId, meta = {}) => {
  let verifyRequest = null;
  let verifyScope = null;
  const effectiveClientId = clientId || (
    isActorBooking(ctx, bookingId) ? toStr(ctx.actorClientId) : null
  );
  if (effectiveClientId) {
    verifyRequest = buildClientBookingVerifyRequest(effectiveClientId, bookingId);
    verifyScope = "client";
  } else if (ctx.exerciseId) {
    verifyRequest = buildExerciseBookingsVerifyRequest(ctx.exerciseId);
    verifyScope = "exercise";
  }

  if (!verifyRequest) {
    ctx.blockLocalMutation = true;
    ctx.blockReason = ctx.blockReason || "viva_cancel_unverified";
    appendTrace(ctx, {
      step: "cancel_booking_unverified",
      bookingId,
      clientId: effectiveClientId || null,
      statusCode: meta.statusCode,
      reason: "missing_verification_target",
      response: clone(meta.response || null),
    });
    return pushBookingFailureAndContinue(ctx, {
      bookingId,
      clientId: effectiveClientId,
      method: "scoped_booking",
      statusCode: meta.statusCode,
      response: meta.response || null,
    });
  }

  ctx.step = "verify_booking_cancelled";
  ctx.currentVerifyRequest = {
    ...verifyRequest,
    scope: verifyScope,
    originAlreadyCancelled: meta.alreadyCancelled === true,
    originStatusCode: meta.statusCode,
  };
  appendTrace(ctx, {
    step: "cancel_booking_verify_request",
    bookingId,
    clientId: effectiveClientId || null,
    exerciseId: ctx.exerciseId || null,
    verifyScope,
    attemptLabel: verifyRequest.label,
    previousStatusCode: meta.statusCode,
  });
  return adminRequest(ctx, verifyRequest.method, verifyRequest.path, verifyRequest.payload);
};

const pushBookingFailureAndContinue = (ctx, failure) => {
  ctx.blockLocalMutation = true;
  if (!ctx.blockReason) {
    ctx.blockReason = failure.unsupportedReason ? "unsupported_refund_method" : "viva_cancel_failed";
  }
  ctx.bookingResults.push({
    bookingId: failure.bookingId,
    ok: false,
    clientId: failure.clientId || null,
    method: failure.method || "generic_booking",
    statusCode: failure.statusCode,
    unsupportedReason: failure.unsupportedReason || null,
    response: clone(failure.response || null),
  });
  ctx.currentBookingId = null;
  ctx.currentClientId = null;
  ctx.currentCancelRequest = null;
  ctx.currentVerifyRequest = null;
  const bookingReq = nextBookingRequest(ctx);
  if (bookingReq) return bookingReq;
  return finalizeTask(ctx);
};

const buildPersistSet = (ctx, nowIso) => {
  const bookingResults = Array.isArray(ctx.bookingResults) ? ctx.bookingResults : [];
  const bookingSuccess = bookingResults.filter((item) => item?.ok === true).map((item) => item.bookingId);
  const bookingFailed = bookingResults.filter((item) => item?.ok !== true).map((item) => item.bookingId);
  const exerciseCancelled = ctx.exerciseId
    ? (ctx.exerciseCancelled === true)
    : true;
  const hasVivaErrors = Boolean(ctx.forceVivaErrors) || bookingFailed.length > 0 || !exerciseCancelled;

  if (ctx.mode === "PARTICIPANT_TIMEOUT") {
    const nextSplitPayments = asArray(ctx.nextSplitPayments).map((item) => {
      if (!item || typeof item !== "object") return item;
      const status = String(item.status || "").trim().toUpperCase();
      if (status !== "EXPIRED" || String(item.cancelReason || "").trim().toUpperCase() !== "PAYMENT_TIMEOUT") {
        return item;
      }
      return {
        ...item,
        vivaCancellation: {
          bookingSuccess,
          bookingFailed,
          exerciseId: null,
          exerciseCancelled: true,
          traces: clone(ctx.trace || []),
        },
      };
    });
    const identityProjection = buildIdentityProjectionSet(ctx, nextSplitPayments);
    return {
      updatedAt: nowIso,
      participants: asArray(ctx.nextParticipants),
      waitlist: asArray(ctx.nextWaitlist),
      participantPhones: identityProjection.participantPhones,
      waitlistPhones: identityProjection.waitlistPhones,
      participantIds: identityProjection.participantIds,
      waitlistIds: identityProjection.waitlistIds,
      allRelatedPhones: identityProjection.allRelatedPhones,
      allRelatedClientIds: identityProjection.allRelatedClientIds,
      "metadata.leaveEvents": asArray(ctx.nextLeaveEvents),
      "metadata.lastLeaveUpdateAt": nowIso,
      "metadata.splitPayment.payments": nextSplitPayments,
      "metadata.splitPayment.lastLeaveUpdateAt": nowIso,
      "metadata.splitPayment.cleanupAt": nowIso,
      "metadata.splitPayment.cleanupSource": "split_cleanup",
      "metadata.splitPayment.lastTimeoutCleanupResult": {
        bookingSuccess,
        bookingFailed,
        withVivaErrors: hasVivaErrors,
        refundMethod: ctx.selectedRefundMethod || null,
        refundMessage: ctx.refundMessage || null,
        traces: clone(ctx.trace || []),
      },
    };
  }

  const reasonMap = {
    PAYMENT_TIMEOUT: "SPLIT_PAYMENT_TIMEOUT_10M",
    ASSEMBLY_TIMEOUT: "SPLIT_ASSEMBLY_TIMEOUT_24H",
    FORCED: "SPLIT_FORCE_CLEANUP",
  };
  const reasonCode = reasonMap[ctx.reason] || "SPLIT_AUTOCLEANUP";

  const setDoc = {
    status: "CANCELLED",
    archived: true,
    updatedAt: nowIso,
    "metadata.splitPayment.status": hasVivaErrors ? "CANCELLED_WITH_VIVA_ERRORS" : "CANCELLED",
    "metadata.splitPayment.cancelReason": reasonCode,
    "metadata.splitPayment.cancelledAt": nowIso,
    "metadata.splitPayment.cleanupAt": nowIso,
    "metadata.splitPayment.cleanupSource": "split_cleanup",
    "metadata.splitPayment.vivaCancellation": {
      bookingSuccess,
      bookingFailed,
      exerciseId: ctx.exerciseId || null,
      exerciseCancelled,
      refundMethod: ctx.selectedRefundMethod || null,
      refundMessage: ctx.refundMessage || null,
      traces: clone(ctx.trace || []),
    },
  };

  if (ctx.reason === "ASSEMBLY_TIMEOUT") {
    setDoc["metadata.splitPayment.refundStatus"] = hasVivaErrors ? "REQUEST_FAILED" : "REQUESTED";
    setDoc["metadata.splitPayment.refundRequestedAt"] = nowIso;
  }

  return setDoc;
};

const finalizeTask = (ctx) => {
  const nowIso = new Date().toISOString();
  const bookingResults = Array.isArray(ctx.bookingResults) ? ctx.bookingResults : [];
  const bookingSuccessCount = bookingResults.filter((item) => item?.ok === true).length;
  const bookingFailedCount = bookingResults.filter((item) => item?.ok !== true).length;
  const exerciseCancelled = ctx.exerciseId ? (ctx.exerciseCancelled === true) : true;
  const hasVivaErrors = Boolean(ctx.forceVivaErrors) || bookingFailedCount > 0 || !exerciseCancelled;
  const blockLocalMutation = ctx.blockLocalMutation === true || hasVivaErrors;

  const summaryPayload = {
    ok: true,
    mode: ctx.mode || "GAME_CLEANUP",
    gameId: ctx.gameId,
    reason: ctx.reason,
    dryRun: ctx.dryRun === true,
    bookingIds: uniq(ctx.initialBookingIds || []),
    bookingSuccessCount,
    bookingFailedCount,
    exerciseId: ctx.exerciseId || null,
    exerciseCancelled,
    cancelledInLk: ctx.dryRun !== true && !blockLocalMutation,
    withVivaErrors: hasVivaErrors,
    blockLocalMutation,
    blockReason: toStr(ctx.blockReason) || null,
    refundMessage: toStr(ctx.refundMessage) || null,
    timedOutPayments: asArray(ctx.timedOutPayments),
    trace: clone(ctx.trace || []),
    finishedAt: nowIso,
  };

  const safeBaseMsg = Object.assign({}, msg);
  delete safeBaseMsg._splitCleanupAuth;
  delete safeBaseMsg._splitCleanupCtx;
  delete safeBaseMsg.method;
  delete safeBaseMsg.url;
  const summaryMsg = Object.assign(safeBaseMsg, {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    payload: summaryPayload,
  });

  if (ctx.dryRun === true || blockLocalMutation) {
    return [null, null, summaryMsg, summaryMsg];
  }

  const auditEvent = buildCleanupAuditEvent(ctx, nowIso, {
    bookingSuccessCount,
    bookingFailedCount,
    exerciseId: ctx.exerciseId || null,
    exerciseCancelled,
    withVivaErrors: hasVivaErrors,
    timedOutPaymentsCount: asArray(ctx.timedOutPayments).length,
    traceSteps: asArray(ctx.trace)
      .slice(-12)
      .map((item) => toStr(item?.step))
      .filter(Boolean),
  });

  const dbMsg = Object.assign({}, safeBaseMsg, {
    statusCode: undefined,
    headers: undefined,
    query: {
      id: ctx.gameId,
      archived: { $ne: true },
    },
    payload: {
      $set: {
        ...buildPersistSet(ctx, nowIso),
        "audit.version": 1,
        "audit.updatedAt": nowIso,
        "audit.lastEvent": auditEvent,
      },
      $push: {
        "audit.events": {
          $each: [auditEvent],
          $slice: -AUDIT_MAX_EVENTS,
        },
      },
    },
  });

  return [null, dbMsg, summaryMsg, summaryMsg];
};

const ctxFromMsg = msg._splitCleanupCtx && typeof msg._splitCleanupCtx === "object"
  ? msg._splitCleanupCtx
  : null;

if (!ctxFromMsg) {
  const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
  const gameId = toStr(payload?.gameId);
  if (!gameId) {
    return [null, null, null, null];
  }

  const queueFromTargets = asArray(payload?.bookingTargets);
  const queueFromBookingIds = uniq(payload?.bookingIds || []);
  const bookingQueue = uniqBookingQueue([
    ...queueFromTargets,
    ...queueFromBookingIds,
  ]);
  const initialBookingIds = uniq(bookingQueue.map((item) => item.bookingId));
  const cleanupAuth = msg._splitCleanupAuth && typeof msg._splitCleanupAuth === "object"
    ? msg._splitCleanupAuth
    : {};

  const initialCtx = {
    mode: toStr(payload?.mode) || "GAME_CLEANUP",
    gameId,
    reason: toStr(payload.reason) || "PAYMENT_TIMEOUT",
    dryRun: payload.dryRun === true,
    exerciseId: toStr(payload.exerciseId),
    preferredRefundMethod: normalizeRefundMethod(payload?.preferredRefundMethod),
    cancellationActionId: normalizeCancellationActionId(payload?.cancellationActionId),
    actorBookingId: toStr(payload?.actorBookingId),
    actorClientId: toStr(cleanupAuth.actorClientId),
    actorPhoneNorm: normalizePhone(cleanupAuth.actorPhoneNorm),
    initialBookingIds,
    bookingQueue,
    bookingResults: [],
    exerciseAttempt: 0,
    exerciseProcessed: false,
    exerciseCancelled: null,
    token: null,
    step: "token_request",
    trace: [],
    selectedRefundMethod: null,
    refundMessage: null,
    nextParticipants: asArray(payload?.nextParticipants),
    nextWaitlist: asArray(payload?.nextWaitlist),
    nextSplitPayments: asArray(payload?.nextSplitPayments),
    nextLeaveEvents: asArray(payload?.nextLeaveEvents),
    timedOutPayments: asArray(payload?.timedOutPayments),
    timedOutPaymentByBooking: buildTimedOutPaymentByBooking(payload?.timedOutPayments),
    blockLocalMutation: payload?.blockLocalMutation === true,
    blockReason: toStr(payload?.blockReason),
    forceVivaErrors: false,
  };
  if (initialCtx.mode === "PARTICIPANT_TIMEOUT") {
    initialCtx.exerciseId = null;
  }

  appendTrace(initialCtx, {
    step: "init",
    gameId,
    reason: initialCtx.reason,
    dryRun: initialCtx.dryRun,
  });

  const hasVivaTargets = (
    (Array.isArray(initialCtx.bookingQueue) && initialCtx.bookingQueue.length > 0)
    || Boolean(initialCtx.exerciseId)
  );
  if (!hasVivaTargets) {
    initialCtx.blockLocalMutation = true;
    initialCtx.blockReason = initialCtx.blockReason || "missing_viva_targets";
    initialCtx.forceVivaErrors = true;
    appendTrace(initialCtx, {
      step: "blocked_missing_viva_targets",
      mode: initialCtx.mode,
      bookingQueueSize: Array.isArray(initialCtx.bookingQueue) ? initialCtx.bookingQueue.length : 0,
      exerciseId: initialCtx.exerciseId || null,
    });
    return finalizeTask(initialCtx);
  }
  if (initialCtx.actorBookingId && !toStr(cleanupAuth.authHeader)) {
    initialCtx.blockLocalMutation = true;
    initialCtx.blockReason = "end_user_auth_missing";
    initialCtx.forceVivaErrors = true;
    appendTrace(initialCtx, {
      step: "blocked_end_user_auth_missing",
      bookingId: initialCtx.actorBookingId,
    });
    return finalizeTask(initialCtx);
  }

  return requestToken(initialCtx);
}

const ctx = ctxFromMsg;

if (ctx.step === "token_request") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    appendTrace(ctx, {
      step: "token_failed",
      statusCode: msg.statusCode,
      response: clone(msg.payload || null),
    });
    ctx.token = null;
    ctx.forceVivaErrors = true;
    // Avoid local roster mutation when Viva auth failed; retries should run against untouched game state.
    ctx.dryRun = true;
    return finalizeTask(ctx);
  }

  ctx.token = msg.payload.access_token;
  persistAdminToken(ctx.token, msg.payload?.expires_in);
  appendTrace(ctx, {
    step: "token_success",
  });

  const bookingReq = nextBookingRequest(ctx);
  if (bookingReq) return bookingReq;

  const exerciseReq = nextExerciseRequest(ctx);
  if (exerciseReq) return exerciseReq;

  return finalizeTask(ctx);
}

if (ctx.step === "check_timeout_transaction") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId) || null;
  const timeoutMeta = ctx.currentTimedOutPayment && typeof ctx.currentTimedOutPayment === "object"
    ? ctx.currentTimedOutPayment
    : null;
  const transactionId = toStr(timeoutMeta?.transactionId);
  const statusCode = Number(msg.statusCode);

  if (!bookingId || !transactionId) {
    if (!bookingId) {
      const bookingReq = nextBookingRequest(ctx);
      if (bookingReq) return bookingReq;
      const exerciseReq = nextExerciseRequest(ctx);
      if (exerciseReq) return exerciseReq;
      return finalizeTask(ctx);
    }
    return startGenericBookingCancel(ctx, bookingId, clientId, {
      fallback: "missing_timeout_transaction_id",
    });
  }

  if (isOk(statusCode) && isPaidTransactionPayload(msg.payload)) {
    recoverPaidTimedOutState(ctx, timeoutMeta, msg.payload || null);
    appendTrace(ctx, {
      step: "check_timeout_transaction_paid",
      bookingId,
      clientId,
      transactionId,
      statusCode,
    });
    ctx.bookingResults.push({
      bookingId,
      ok: true,
      clientId,
      method: "transaction_recheck",
      skippedAsPaid: true,
      transactionId,
      statusCode,
    });
    ctx.currentBookingId = null;
    ctx.currentClientId = null;
    ctx.currentTimedOutPayment = null;
    const bookingReq = nextBookingRequest(ctx);
    if (bookingReq) return bookingReq;
    const exerciseReq = nextExerciseRequest(ctx);
    if (exerciseReq) return exerciseReq;
    return finalizeTask(ctx);
  }

  appendTrace(ctx, {
    step: isOk(statusCode) ? "check_timeout_transaction_not_paid" : "check_timeout_transaction_failed",
    bookingId,
    clientId,
    transactionId,
    statusCode,
    response: clone(msg.payload || null),
  });

  return startGenericBookingCancel(ctx, bookingId, clientId, {
    fallback: "transaction_not_paid",
    transactionId,
    statusCode,
  });
}

if (ctx.step === "cancel_booking_probe") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  const statusCode = Number(msg.statusCode);

  if (isAlreadyCancelledResponse(statusCode, msg.payload)) {
    appendTrace(ctx, {
      step: "cancel_booking_already_cancelled",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    return startBookingVerification(ctx, bookingId, clientId, {
      statusCode,
      alreadyCancelled: true,
      response: msg.payload || null,
    });
  }

  if (statusCode === 404) {
    appendTrace(ctx, {
      step: "cancel_booking_probe_not_found",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    return startBookingVerification(ctx, bookingId, clientId, {
      statusCode,
      response: msg.payload || null,
    });
  }

  if (!isOk(statusCode)) {
    appendTrace(ctx, {
      step: "cancel_booking_probe_failed",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    return pushBookingFailureAndContinue(ctx, {
      bookingId,
      clientId,
      method: "generic_booking",
      statusCode,
      response: msg.payload || null,
    });
  }

  const cancelRequest = pickBookingCancellationRequest(
    ctx,
    bookingId,
    clientId,
    msg.payload || null,
  );
  if (!cancelRequest || cancelRequest.unsupportedReason) {
    ctx.blockLocalMutation = true;
    ctx.blockReason = cancelRequest?.unsupportedCode || ctx.blockReason || "unsupported_refund_method";
    appendTrace(ctx, {
      step: "cancel_booking_probe_unsupported",
      bookingId,
      clientId,
      statusCode,
      unsupportedReason: cancelRequest?.unsupportedReason || null,
      unsupportedCode: cancelRequest?.unsupportedCode || null,
      response: clone(msg.payload || null),
    });
    return pushBookingFailureAndContinue(ctx, {
      bookingId,
      clientId,
      method: "generic_booking",
      statusCode,
      unsupportedReason: cancelRequest?.unsupportedReason || "Unsupported refund path",
      response: msg.payload || null,
    });
  }

  ctx.currentCancelRequest = cancelRequest;
  if (cancelRequest.refundMethod && !ctx.selectedRefundMethod) {
    ctx.selectedRefundMethod = cancelRequest.refundMethod;
  }
  if (cancelRequest.refundMessage && !ctx.refundMessage) {
    ctx.refundMessage = cancelRequest.refundMessage;
  }
  ctx.step = "cancel_booking";
  appendTrace(ctx, {
    step: "cancel_booking_request",
    bookingId,
    clientId,
    statusCode,
    attemptLabel: cancelRequest.label,
    scope: cancelRequest.scope,
    refundMethod: cancelRequest.refundMethod || null,
  });
  return bookingApiRequest(ctx, cancelRequest);
}

if (ctx.step === "cancel_booking") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  const statusCode = Number(msg.statusCode);
  const cancelRequest = ctx.currentCancelRequest && typeof ctx.currentCancelRequest === "object"
    ? ctx.currentCancelRequest
    : null;

  if (isOk(msg.statusCode) || isAlreadyCancelledResponse(statusCode, msg.payload)) {
    appendTrace(ctx, {
      step: isOk(msg.statusCode)
        ? "cancel_booking_success"
        : "cancel_booking_already_cancelled",
      bookingId,
      clientId,
      statusCode: msg.statusCode,
      refundMethod: cancelRequest?.refundMethod || null,
      response: isOk(msg.statusCode) ? undefined : clone(msg.payload || null),
    });
    return startBookingVerification(ctx, bookingId, clientId, {
      statusCode: msg.statusCode,
      alreadyCancelled: !isOk(msg.statusCode),
      response: isOk(msg.statusCode) ? null : (msg.payload || null),
    });
  }

  if (statusCode === 404) {
    appendTrace(ctx, {
      step: "cancel_booking_delete_not_found",
      bookingId,
      clientId,
      exerciseId: toStr(ctx.exerciseId),
      statusCode,
      attemptLabel: cancelRequest?.label || null,
      refundMethod: cancelRequest?.refundMethod || null,
      response: clone(msg.payload || null),
    });
    return startBookingVerification(ctx, bookingId, clientId, {
      statusCode,
      response: msg.payload || null,
    });
  }

  appendTrace(ctx, {
    step: "cancel_booking_failed",
    bookingId,
    clientId,
    statusCode: msg.statusCode,
    refundMethod: cancelRequest?.refundMethod || null,
    response: clone(msg.payload || null),
  });
  return pushBookingFailureAndContinue(ctx, {
    bookingId,
    clientId,
    method: "generic_booking",
    statusCode: msg.statusCode,
    response: msg.payload || null,
  });
}

if (ctx.step === "verify_booking_cancelled") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  const statusCode = Number(msg.statusCode);
  const verifyRequest = ctx.currentVerifyRequest && typeof ctx.currentVerifyRequest === "object"
    ? ctx.currentVerifyRequest
    : null;
  const verifyScope = toStr(verifyRequest?.scope);
  const cancelRequest = ctx.currentCancelRequest && typeof ctx.currentCancelRequest === "object"
    ? ctx.currentCancelRequest
    : null;

  let verifiedCancelled = false;
  let activeBooking = false;

  if (statusCode === 404 && verifyScope === "client" && toStr(ctx.exerciseId)) {
    const historyRequest = buildExerciseBookingsVerifyRequest(toStr(ctx.exerciseId));
    ctx.currentVerifyRequest = {
      ...historyRequest,
      scope: "exercise",
      originAlreadyCancelled: verifyRequest?.originAlreadyCancelled === true,
      originStatusCode: verifyRequest?.originStatusCode,
    };
    appendTrace(ctx, {
      step: "cancel_booking_verify_history_request",
      bookingId,
      clientId,
      exerciseId: toStr(ctx.exerciseId),
      previousStatusCode: statusCode,
      attemptLabel: historyRequest.label,
    });
    return adminRequest(ctx, historyRequest.method, historyRequest.path, historyRequest.payload);
  }

  if (isOk(statusCode) && verifyScope === "client") {
    verifiedCancelled = isCancelledBookingRow(msg.payload);
    activeBooking = !verifiedCancelled;
  } else if (isOk(statusCode) && verifyScope === "exercise") {
    const bookingRow = findBookingRow(msg.payload, bookingId);
    verifiedCancelled = Boolean(bookingRow && isCancelledBookingRow(bookingRow));
    activeBooking = Boolean(bookingRow && !verifiedCancelled);
  }

  if (verifiedCancelled) {
    appendTrace(ctx, {
      step: "cancel_booking_verified_cancelled",
      bookingId,
      clientId,
      exerciseId: toStr(ctx.exerciseId),
      statusCode,
      verifyScope,
    });
    return pushBookingSuccessAndContinue(ctx, {
      bookingId,
      clientId,
      method: "generic_booking",
      refundMethod: cancelRequest?.refundMethod || null,
      verifiedAbsent: false,
      alreadyCancelled: verifyRequest?.originAlreadyCancelled === true,
      statusCode,
    });
  }

  ctx.blockLocalMutation = true;
  ctx.blockReason = ctx.blockReason || (
    activeBooking ? "viva_booking_still_active" : "viva_cancel_unverified"
  );
  appendTrace(ctx, {
    step: activeBooking ? "cancel_booking_still_active" : "cancel_booking_unverified",
    bookingId,
    clientId,
    exerciseId: toStr(ctx.exerciseId),
    statusCode,
    verifyScope,
    refundMethod: cancelRequest?.refundMethod || null,
    response: clone(msg.payload || null),
  });
  return pushBookingFailureAndContinue(ctx, {
    bookingId,
    clientId,
    method: "generic_booking",
    statusCode,
    response: msg.payload || null,
  });
}

if (ctx.step === "cancel_exercise") {
  const attempt = Number.isFinite(Number(ctx.exerciseAttempt)) ? Number(ctx.exerciseAttempt) : 0;

  if (isOk(msg.statusCode)) {
    appendTrace(ctx, {
      step: "cancel_exercise_success",
      exerciseId: ctx.exerciseId,
      attempt,
      statusCode: msg.statusCode,
    });
    ctx.step = "verify_exercise_cancelled";
    ctx.exerciseCancelOriginStatusCode = Number(msg.statusCode);
    appendTrace(ctx, {
      step: "verify_exercise_cancelled_request",
      exerciseId: ctx.exerciseId,
      attempt,
    });
    return adminRequest(
      ctx,
      "GET",
      `/exercises/${encodeURIComponent(ctx.exerciseId)}`,
      undefined,
    );
  }

  if (attempt < 2) {
    const nextAttempt = attempt + 1;
    ctx.exerciseAttempt = nextAttempt;
    const attemptPayload = buildExerciseAttempt(ctx, nextAttempt);
    appendTrace(ctx, {
      step: "cancel_exercise_retry",
      exerciseId: ctx.exerciseId,
      attempt: nextAttempt,
      statusCode: msg.statusCode,
      attemptLabel: attemptPayload.label,
      response: clone(msg.payload || null),
    });
    return adminRequest(ctx, attemptPayload.method, attemptPayload.path, attemptPayload.payload);
  }

  appendTrace(ctx, {
    step: "cancel_exercise_failed",
    exerciseId: ctx.exerciseId,
    attempt,
    statusCode: msg.statusCode,
    response: clone(msg.payload || null),
  });
  ctx.exerciseProcessed = true;
  ctx.exerciseCancelled = false;
  return finalizeTask(ctx);
}

if (ctx.step === "verify_exercise_cancelled") {
  const attempt = Number.isFinite(Number(ctx.exerciseAttempt)) ? Number(ctx.exerciseAttempt) : 0;
  const statusCode = Number(msg.statusCode);
  const verifiedCancelled = statusCode === 404 || (
    isOk(statusCode) && isCancelledExercise(msg.payload)
  );
  if (verifiedCancelled) {
    appendTrace(ctx, {
      step: statusCode === 404
        ? "verify_exercise_cancelled_absent"
        : "verify_exercise_cancelled_success",
      exerciseId: ctx.exerciseId,
      attempt,
      statusCode,
    });
    ctx.exerciseProcessed = true;
    ctx.exerciseCancelled = true;
    return finalizeTask(ctx);
  }

  appendTrace(ctx, {
    step: isOk(statusCode)
      ? "verify_exercise_still_active"
      : "verify_exercise_cancelled_failed",
    exerciseId: ctx.exerciseId,
    attempt,
    statusCode,
    response: clone(msg.payload || null),
  });
  if (attempt < 2) {
    const nextAttempt = attempt + 1;
    ctx.exerciseAttempt = nextAttempt;
    const attemptPayload = buildExerciseAttempt(ctx, nextAttempt);
    ctx.step = "cancel_exercise";
    appendTrace(ctx, {
      step: "cancel_exercise_retry_after_readback",
      exerciseId: ctx.exerciseId,
      attempt: nextAttempt,
      attemptLabel: attemptPayload.label,
    });
    return adminRequest(ctx, attemptPayload.method, attemptPayload.path, attemptPayload.payload);
  }

  ctx.exerciseProcessed = true;
  ctx.exerciseCancelled = false;
  ctx.forceVivaErrors = true;
  return finalizeTask(ctx);
}

appendTrace(ctx, {
  step: "unknown_step",
  currentStep: ctx.step,
});
return finalizeTask(ctx);
