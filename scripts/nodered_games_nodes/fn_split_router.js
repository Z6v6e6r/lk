const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const SPLIT_DIRECTION_ID = 4485;
const SPLIT_EXERCISE_TYPE_ID = 1208;

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

const pickId = (value) => {
  if (!value || typeof value !== "object") return null;
  return toStr(value.id) || toStr(value.uuid);
};

const extractConflictExerciseId = (value, ctx) => {
  const conflicts = Array.isArray(value?.conflicts) ? value.conflicts : [];
  const targetStart = `${ctx.date}T${ctx.fromTime}:00+03:00`;
  const targetEnd = `${ctx.date}T${ctx.toTime}:00+03:00`;

  const matchingConflict = conflicts.find((item) => {
    if (!item || typeof item !== "object") return false;
    const exerciseId = toStr(item.conflictingExerciseId) || toStr(item.exerciseId);
    if (!exerciseId) return false;
    const roomId = toStr(item.room?.id || item.roomId);
    const startsAt = toStr(item.timeFrom);
    const endsAt = toStr(item.timeTo);
    return roomId === ctx.roomId && startsAt === targetStart && endsAt === targetEnd;
  });

  return matchingConflict
    ? toStr(matchingConflict.conflictingExerciseId) || toStr(matchingConflict.exerciseId)
    : null;
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const adminRequest = (ctx, method, path, payload) => {
  msg._splitCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, msg];
};

const extractList = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return value.content;
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
};

const isLikelyPaymentUrl = (value) => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  return /(pay|tbank|tinkoff|payment|checkout|bank|acquir)|([?&](payment|transaction|order|invoice)=)/i.test(text);
};

const extractPaymentUrl = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text)) return null;
    return isLikelyPaymentUrl(text) ? text : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractPaymentUrl(item);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  for (const key of ["paymentUrl", "redirectUrl", "paymentLink", "checkoutUrl", "cardPaymentUrl", "paymentPageUrl"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["url", "link"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["data", "payload", "result", "transaction", "transactionStatus", "cardPaymentStatus", "payment", "paymentInfo", "cardPaymentInfo"]) {
    const found = extractPaymentUrl(value[key]);
    if (found) return found;
  }
  return null;
};

const buildBookingRequest = (ctx) => {
  const payload = {
    phone: ctx.clientPhone,
    paymentType: "ON_PLACE",
    familyMemberId: "",
  };
  if (ctx.spot) payload.spot = ctx.spot;

  ctx.step = "create_booking";
  return adminRequest(
    ctx,
    "POST",
    `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`,
    payload,
  );
};

const ctx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : null;
if (!ctx) {
  return fail(500, "Split payment context is missing");
}

if (ctx.step === "token") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(500, "Viva token error", msg.payload || null);
  }
  ctx.token = msg.payload.access_token;

  if (ctx.action === "create") {
    ctx.step = "create_exercise";
    return adminRequest(ctx, "POST", "/exercises", {
      direction: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
      type: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
      timeFrom: `${ctx.date}T${ctx.fromTime}+03:00`,
      timeTo: `${ctx.date}T${ctx.toTime}+03:00`,
      maxClientsCount: ctx.maxClientsCount,
      roomId: ctx.roomId,
      clientId: ctx.clientId || undefined,
      requirements: [],
    });
  }

  return buildBookingRequest(ctx);
}

if (!isOk(msg.statusCode)) {
  if (ctx.step === "create_exercise" && Number(msg.statusCode) === 409) {
    const conflictExerciseId = extractConflictExerciseId(msg.payload, ctx);
    if (conflictExerciseId) {
      ctx.exercise = msg.payload;
      ctx.exerciseId = conflictExerciseId;
      ctx.reusedConflictingExercise = true;
      return buildBookingRequest(ctx);
    }
  }
  return fail(msg.statusCode || 502, "Viva request failed", msg.payload || null);
}

if (ctx.step === "create_exercise") {
  const exerciseId = pickId(msg.payload);
  if (!exerciseId) {
    return fail(502, "Viva exercise response has no id", msg.payload || null);
  }

  ctx.exercise = msg.payload;
  ctx.exerciseId = exerciseId;
  if (!ctx.studioId && msg.payload?.studio?.id) {
    ctx.studioId = msg.payload.studio.id;
  }
  return buildBookingRequest(ctx);
}

if (ctx.step === "create_booking") {
  const bookingId = pickId(msg.payload);
  if (!bookingId) {
    return fail(502, "Viva booking response has no id", msg.payload || null);
  }

  ctx.booking = msg.payload;
  ctx.bookingId = bookingId;
  ctx.clientId = ctx.clientId || toStr(msg.payload?.client?.id);
  ctx.clientPhone = ctx.clientPhone || toStr(msg.payload?.client?.phone);
  ctx.studioId = ctx.studioId || toStr(msg.payload?.studio?.id);
  ctx.spot = toNumber(msg.payload?.spot) ?? ctx.spot ?? null;

  if (!ctx.clientId || !ctx.studioId) {
    return fail(502, "Viva booking response has no clientId or studioId", msg.payload || null);
  }

  ctx.step = "available_products";
  return adminRequest(ctx, "POST", "/products/available/by-booking", {
    bookingIds: [bookingId],
    clientId: ctx.clientId,
    studioId: ctx.studioId,
  });
}

if (ctx.step === "available_products") {
  const products = extractList(msg.payload);
  const product = products.find((item) => {
    if (!item || typeof item !== "object") return false;
    const type = String(item.productType || item.type || "").toUpperCase();
    return type === "SERVICE" || type === "BOOKING_PAYMENT";
  }) || products[0];

  if (!product || typeof product !== "object") {
    return fail(502, "No Viva booking payment product is available", msg.payload || null);
  }

  const productId = pickId(product);
  if (!productId) {
    return fail(502, "Viva product response has no id", product);
  }

  const productTypeRaw = String(product.productType || product.type || "").toUpperCase();
  const productType = ["SERVICE", "ADVANCE_SUB_SERVICE", "BOOKING_PAYMENT"].includes(productTypeRaw)
    ? productTypeRaw
    : "SERVICE";
  const productCostMinor = Math.max(0, Math.round(toNumber(product.cost) ?? 200000));
  const shareAmountMinor = Math.max(0, Math.round(Number(ctx.shareAmount || 0) * 100));
  const discountAmountMinor = Math.max(productCostMinor - shareAmountMinor, 0);

  ctx.product = product;
  ctx.productId = productId;
  ctx.baseShareAmountMinor = productCostMinor;
  ctx.baseShareAmount = productCostMinor / 100;
  ctx.shareAmountMinor = shareAmountMinor;
  ctx.discountAmountMinor = discountAmountMinor;
  ctx.discountAmount = discountAmountMinor / 100;
  ctx.step = "transaction";

  const transactionPayload = {
    clientPhone: ctx.clientPhone.startsWith("+") ? ctx.clientPhone : `+${ctx.clientPhone}`,
    paymentMethod: "WIDGET",
    products: [
      {
        id: productId,
        count: 1,
        customAmount: null,
        type: productType,
        discount: discountAmountMinor,
        bookingIds: [ctx.bookingId],
      },
    ],
    studioId: ctx.studioId,
    discountReason: ctx.shareCount === 4 ? "Своя игра 1/4 акция Терехово" : "Своя игра split акция Терехово",
    offlineTillId: null,
    deposit: 0,
  };
  if (ctx.successUrl) {
    transactionPayload.successUrl = ctx.successUrl;
    transactionPayload.baseRedirectUrl = ctx.successUrl;
    transactionPayload.redirectUrl = ctx.successUrl;
    transactionPayload.returnUrl = ctx.successUrl;
    transactionPayload.successRedirectUrl = ctx.successUrl;
  }
  if (ctx.failUrl) {
    transactionPayload.failUrl = ctx.failUrl;
    transactionPayload.failRedirectUrl = ctx.failUrl;
    transactionPayload.failureRedirectUrl = ctx.failUrl;
  }

  return adminRequest(ctx, "POST", "/transactions", transactionPayload);
}

if (ctx.step === "transaction") {
  const transactionId = pickId(msg.payload);
  const toPayMinor = Math.max(0, Math.round(toNumber(msg.payload?.toPay) ?? ctx.shareAmountMinor ?? 0));
  const responsePayload = {
    ok: true,
    mode: ctx.action,
    paymentRef: ctx.paymentRef,
    exerciseId: ctx.exerciseId,
    bookingId: ctx.bookingId,
    productId: ctx.productId,
    transactionId,
    paymentUrl: extractPaymentUrl(msg.payload),
    toPayMinor,
    toPay: toPayMinor / 100,
    shareAmount: ctx.shareAmount,
    shareAmountMinor: ctx.shareAmountMinor,
    baseShareAmount: ctx.baseShareAmount,
    baseShareAmountMinor: ctx.baseShareAmountMinor,
    discountAmount: ctx.discountAmount,
    discountAmountMinor: ctx.discountAmountMinor,
    directionId: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
    exerciseTypeId: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
    deadlineAt: ctx.deadlineAt,
    spot: ctx.spot ?? null,
    reusedConflictingExercise: Boolean(ctx.reusedConflictingExercise),
  };

  msg.statusCode = 201;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = responsePayload;
  return [null, msg, msg];
}

return fail(500, "Unsupported split payment step", { step: ctx.step });
