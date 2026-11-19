// Composed into the primary split router. The journal is private to this flow.
const paidJoinPending = () => fail(409, "Проверяем предыдущую попытку оплаты. Обновите карточку игры чуть позже.", {
  code: "SPLIT_JOIN_CHECKOUT_PENDING",
});

const paidJoinDb = (ctx, phase, target, operation, args) => {
  ctx.step = phase;
  msg._paidJoinCollection = target;
  msg.operation = operation;
  msg.payload = args;
  const output = Array(PAID_JOIN_DB_OUTPUT + 1).fill(null);
  output[PAID_JOIN_DB_OUTPUT] = msg;
  return output;
};

const paidJoinGameRead = (ctx) => paidJoinDb(ctx, "paid_join_game_read", "games", "find", [
  { id: ctx.gameId }, { limit: 2 },
]);

const paidJoinTransactionPath = (id) => "/transactions/" + encodeURIComponent(id);
const paidJoinBookingPath = (ctx, id) => "/clients/" + encodeURIComponent(ctx.clientId)
  + "/bookings/" + encodeURIComponent(id);
const paidJoinNow = () => new Date().toISOString();
const paidJoinMajority = { writeConcern: { w: "majority", j: true } };
const paidJoinWriteOk = (value) => value?.acknowledged === true && value.matchedCount === 1;
const paidJoinBodyId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  ? value : null;
const paidJoinEnabledForGame = (gameId) => {
  if (readEnv("LK_PAID_SPLIT_JOIN_RECOVERY_ENABLED") !== "1" || !paidJoinBodyId(gameId)) return false;
  const games = String(readEnv("LK_PAID_SPLIT_JOIN_RECOVERY_GAME_IDS") || "").split(",").map(id => id.trim());
  return games.every(paidJoinBodyId) && games.includes(gameId);
};
const paidJoinKey = (ctx) => JSON.stringify([ctx.paidJoinTenant, ctx.gameId, ctx.exerciseId, ctx.clientId]);
const paidJoinExact = (ctx, doc) => doc?._id === paidJoinKey(ctx)
  && doc.gameId === ctx.gameId && doc.exerciseId === ctx.exerciseId && doc.clientId === ctx.clientId && doc.tenant === ctx.paidJoinTenant;
const paidJoinAgrees = (values, expected) => values.every(v => v == null || v === expected);
const paidJoinCurrentBooking = (ctx, body, id) => body?.id === id
  && body.client?.id === ctx.clientId && body.exerciseId === ctx.exerciseId
  && paidJoinAgrees([body.bookingId, body.clientBookingId], id)
  && paidJoinAgrees([body.clientId, body.client?.clientId], ctx.clientId)
  && paidJoinAgrees([body.exercise?.id], ctx.exerciseId);
const paidJoinLinkedTransaction = (ctx, body, checkout) => {
  const product = body?.products?.[0];
  return body?.id === checkout.transactionId && body?.client?.id === ctx.clientId
    && body.toPay === checkout.toPayMinor
    && Array.isArray(body.products) && body.products.length === 1
    && Array.isArray(product.paymentBookingIds) && product.paymentBookingIds.length === 1
    && product.paymentBookingIds[0] === checkout.bookingId
    && (checkout.productId == null || product.id === checkout.productId)
    && (checkout.discountAmountMinor == null || product.discount === checkout.discountAmountMinor)
    && paidJoinAgrees([body.transactionId], checkout.transactionId)
    && paidJoinAgrees([body.clientId, body.client?.uuid], ctx.clientId)
    && paidJoinAgrees([body.exerciseId, body.exercise?.id], ctx.exerciseId)
    && paidJoinAgrees([body.toPayMinor], checkout.toPayMinor)
    && paidJoinAgrees([body.currency], "RUB")
    && paidJoinAgrees([body.bookingId, product.bookingId, product.clientBookingId], checkout.bookingId)
    && [body.bookingIds, body.paymentBookingIds, product.bookingIds].every(ids =>
      ids == null || (Array.isArray(ids) && ids.length === 1 && ids[0] === checkout.bookingId))
    && (product.pricingDetails == null || (Array.isArray(product.pricingDetails)
      && product.pricingDetails.every(p => paidJoinAgrees([p.bookingId, p.clientBookingId], checkout.bookingId))));
};

const paidJoinCheckoutUrl = (value) => typeof value === "string"
  && /^https:\/\/pay\.vivacrm\.ru\/[A-Za-z0-9_-]+(?:[?#][^\s]*)?$/.test(value);

const paidJoinCheckoutValid = (ctx, checkout) => checkout?.exerciseId === ctx.exerciseId
  && !!paidJoinBodyId(checkout.bookingId) && !!paidJoinBodyId(checkout.transactionId)
  && !!paidJoinBodyId(checkout.paymentRef)
  && Number.isSafeInteger(checkout.toPayMinor) && checkout.toPayMinor > 0
  && Number.isFinite(Date.parse(checkout.deadlineAt))
  && paidJoinCheckoutUrl(checkout.paymentUrl);

const paidJoinOwnedFilter = (ctx, state) => ({
  _id: paidJoinKey(ctx),
  gameId: ctx.gameId,
  exerciseId: ctx.exerciseId,
  clientId: ctx.clientId,
  attempt: ctx.paidJoinAttempt,
  tenant: ctx.paidJoinTenant,
  state,
});
const paidJoinTransition = (ctx, phase, state, update) => paidJoinDb(ctx, phase, "journal", "updateOne", [
  paidJoinOwnedFilter(ctx, state), { $set: { ...update, updatedAt: paidJoinNow() } }, paidJoinMajority,
]);

const paidJoinBegin = (ctx) => {
  if (!paidJoinBodyId(ctx.gameId) || !paidJoinBodyId(ctx.exerciseId)
    || !paidJoinBodyId(ctx.paymentRef) || !/^Bearer\s+\S+$/i.test(ctx.userAuthHeader || "")) {
    return fail(401, "Для оплаты участия войдите в личный кабинет.", { code: "SPLIT_JOIN_AUTH_REQUIRED" });
  }
  ctx.step = "paid_join_profile";
  return endUserRequest(ctx, "/profile");
};

const paidJoinClaim = (ctx, bookingPayload) => {
  ctx.paidJoinBookingPayload = bookingPayload;
  ctx.paidJoinAttempt = ctx.paymentRef;
  const next = {
    gameId: ctx.gameId, exerciseId: ctx.exerciseId, clientId: ctx.clientId,
    tenant: ctx.paidJoinTenant, attempt: ctx.paidJoinAttempt, state: "BOOKING_REQUESTED", updatedAt: paidJoinNow(),
    bookingId: null, checkout: null,
  };
  if (ctx.paidJoinPreviousAttempt) {
    // A replay of the previous generation is a status check, not consent to another charge.
    if (ctx.paidJoinPreviousAttempt === ctx.paidJoinAttempt) return paidJoinPending();
    return paidJoinDb(ctx, "paid_join_claim_ack", "journal", "updateOne", [
      { ...paidJoinOwnedFilter(ctx, "CHECKOUT_READY"), attempt: ctx.paidJoinPreviousAttempt },
      { $set: next }, paidJoinMajority,
    ]);
  }
  return paidJoinDb(ctx, "paid_join_claim_insert", "journal", "insertOne", [
    { _id: paidJoinKey(ctx), ...next }, paidJoinMajority,
  ]);
};

const paidJoinAfterBooking = (ctx) => {
  if (!paidJoinBodyId(ctx.bookingId)) return paidJoinPending();
  ctx.step = "paid_join_created_booking";
  return adminRequest(ctx, "GET", paidJoinBookingPath(ctx, ctx.bookingId));
};

const paidJoinBeforeTransaction = (ctx) =>
  paidJoinTransition(ctx, "paid_join_transaction_ack", "BOOKING_CREATED", {
    state: "TRANSACTION_REQUESTED", expectedAmountMinor: ctx.shareAmountMinor,
    expectedProductId: ctx.productId, expectedDiscountMinor: ctx.discountAmountMinor,
  });

const paidJoinRegisterCheckout = (ctx, checkout) => {
  if (!paidJoinCheckoutValid(ctx, checkout)
    || ctx.bookingId !== checkout.bookingId || ctx.paidJoinAttempt !== checkout.paymentRef
    || checkout.toPayMinor !== ctx.shareAmountMinor) return paidJoinPending();
  ctx.paidJoinCheckout = checkout;
  if (!paidJoinLinkedTransaction(ctx, msg.payload, checkout)) {
    ctx.step = "paid_join_verify_checkout";
    return adminRequest(ctx, "GET", paidJoinTransactionPath(checkout.transactionId));
  }
  return paidJoinRememberCheckout(ctx);
};

const paidJoinRememberCheckout = (ctx) => {
  const checkout = ctx.paidJoinCheckout;
  return paidJoinTransition(ctx, "paid_join_checkout_ack", "TRANSACTION_REQUESTED", {
    state: "CHECKOUT_READY", checkout,
  });
};

const paidJoinResponse = (checkout) => {
  msg.statusCode = 201;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = { ...checkout, checkoutStored: true };
  // Never send the private checkout to the legacy debug output.
  return [null, msg];
};

const paidJoinActorMatches = (ctx, row) => row?.clientId === ctx.clientId || row?.id === ctx.clientId
  || String(row?.phoneNorm || row?.phone || "").replace(/\D/g, "") === ctx.clientPhone;
const paidJoinInactive = (payment) => ["EXPIRED", "LEFT", "CANCELLED"].includes(payment.status);
const paidJoinGameValid = (ctx, game) => {
  const split = game?.metadata?.splitPayment;
  const exerciseIds = [split?.vivaExerciseId, split?.exerciseId, game?.booking?.vivaExerciseId, game?.booking?.exerciseId]
    .filter(Boolean);
  return game?.id === ctx.gameId && (game.tenantKey ?? null) === ctx.paidJoinTenant
    && exerciseIds.length > 0 && exerciseIds.every(id => id === ctx.exerciseId)
    && game.archived !== true && game.status === "PAID" && split?.enabled === true
    && game.settings?.isPrivate !== true && game.organizer?.id !== ctx.clientId
    && Date.parse(game.booking?.timeFromIso) > Date.now()
    && Array.isArray(game.participants) && Array.isArray(game.waitlist) && Array.isArray(split.payments);
};

const paidJoinRoster = (ctx, game) => {
  const checkout = ctx.paidJoinCheckout;
  if (!paidJoinGameValid(ctx, game) || !paidJoinCheckoutValid(ctx, checkout)
    || (!ctx.paidJoinArchive && Date.parse(checkout.deadlineAt) <= Date.now())) return null;
  const metadata = game.metadata;
  const split = metadata.splitPayment;
  const sameActor = (row) => paidJoinActorMatches(ctx, row);
  const sameCheckout = (p) => p?.clientId === ctx.clientId && p.bookingId === checkout.bookingId
    && p.transactionId === checkout.transactionId && p.paymentRef === checkout.paymentRef;
  const memberPayments = split.payments.filter(sameActor);
  const existing = memberPayments.filter(sameCheckout);
  if (existing.length === 1 && existing[0].status === "PAYMENT_PENDING") return { existing: true };
  if (existing.length || memberPayments.some(p => !paidJoinInactive(p))
    || game.participants.some(sameActor) || game.waitlist.some(sameActor)) return null;

  const pending = {
    role: "PARTICIPANT", status: "PAYMENT_PENDING", paymentRef: checkout.paymentRef,
    clientId: ctx.clientId, phone: ctx.clientPhone, phoneNorm: ctx.clientPhone,
    bookingId: checkout.bookingId, productId: checkout.productId, transactionId: checkout.transactionId,
    paymentUrl: ctx.paidJoinArchive ? null : checkout.paymentUrl,
    amount: checkout.toPay, amountMinor: checkout.toPayMinor,
    spot: checkout.spot, deadlineAt: checkout.deadlineAt, expiresAt: checkout.deadlineAt,
    createdAt: paidJoinNow(), paidAt: null,
  };
  const append = (list, value) => Array.from(new Set([...(Array.isArray(list) ? list : []), value]));
  const updatedAt = new Date(Math.max(Date.now(), (Date.parse(game.updatedAt) || 0) + 1)).toISOString();
  return {
    filter: {
      _id: game._id, id: game.id, status: game.status, updatedAt: game.updatedAt,
      archived: { $ne: true }, tenantKey: ctx.paidJoinTenant, settings: game.settings ?? null,
      "booking.vivaExerciseId": game.booking?.vivaExerciseId ?? null, participants: game.participants, waitlist: game.waitlist,
      "metadata.splitPayment.payments": split.payments,
    },
    set: {
      "metadata.splitPayment.payments": [...split.payments, pending],
      "metadata.splitPayment.bookingIds": append(split.bookingIds, checkout.bookingId),
      "metadata.bookingIds": append(metadata.bookingIds, checkout.bookingId),
      waitlist: [...game.waitlist, {
        id: ctx.clientId, name: ctx.paidJoinName, phone: ctx.clientPhone, status: "PENDING", source: "INVITE_LINK",
      }],
      waitlistPhones: append(game.waitlistPhones, ctx.clientPhone),
      allRelatedPhones: append(game.allRelatedPhones, ctx.clientPhone),
      allRelatedClientIds: append(game.allRelatedClientIds, ctx.clientId),
      updatedAt,
    },
  };
};

const paidJoinAbsentOrEmpty = (value) => value == null || (Array.isArray(value) && value.length === 0);
const paidJoinZero = (value) => value == null || value === 0;
const paidJoinNoSettlement = (source) => !source || (
  [source.paid, source.isPaid].every(v => v == null || v === false)
  && [source.paymentDate, source.paidAt, source.refundedAt, source.refundDate, source.refund]
    .every(v => v == null || v === "")
  && [source.deposit, source.paidAmount, source.paidAmountMinor, source.paidAmountKopecks,
    source.refundSum, source.refundedAmountMinor].every(paidJoinZero)
  && paidJoinAbsentOrEmpty(source.receipts) && paidJoinAbsentOrEmpty(source.transactionRefunds)
  && (source.amountDue == null || (typeof source.amountDue === "object" && !Array.isArray(source.amountDue)
    && [source.amountDue.paidKopecks, source.amountDue.refundedKopecks].every(paidJoinZero)))
);
const paidJoinNoMoney = (body) => body?.status === "UNPAID"
  && paidJoinAgrees([body.state, body.paymentStatus, body.transactionStatus], "UNPAID")
  && body.processingStatus == null && body.possibleDoublePayment !== true && body.receiptPending !== true
  && [body, body.cardPaymentInfo, body.cardPaymentStatus].every(paidJoinNoSettlement)
  && (!body.cardPaymentStatus || (body.cardPaymentStatus.status === body.cardPaymentInfo?.status
    && body.cardPaymentStatus.declineOutcome === body.cardPaymentInfo?.declineOutcome));
const paidJoinNoVisit = (body) => body?.paymentType === "ON_PLACE"
  && (body.detailedPaymentType == null || body.detailedPaymentType === "ON_PLACE")
  && body.visitConfirmed === false && paidJoinNoSettlement(body)
  && !body.freeVisitId && !body.clientSubscriptionId && !body.payedBy && !body.paymentClientOneTime
  && !body.clientOneTimeId && !body.transactionId && !body.paymentStatus && !body.transactionStatus
  && !body.refundMethod && !body.oneTimeRefundMethod && paidJoinAbsentOrEmpty(body.boundClientOneTimes);

const paidJoinReadState = (ctx) => {
  const body = msg.payload;
  const step = ctx.step;
  if (msg.error) return paidJoinPending();
  if (step === "paid_join_profile") {
    const profile = body?.data && typeof body.data === "object" ? body.data : body;
    const actor = paidJoinBodyId(profile?.id || profile?.clientId || profile?.client?.id);
    const phone = normalizePhone(profile?.phone || profile?.phoneNumber || profile?.mobile || profile?.client?.phone);
    if (!isOk(msg.statusCode) || !actor || !phone
      || (ctx.clientId && ctx.clientId !== actor) || normalizePhone(ctx.clientPhone) !== phone) {
      return fail(403, "Профиль Viva не соответствует участнику.", { code: "SPLIT_JOIN_ACTOR_MISMATCH" });
    }
    ctx.clientId = actor;
    ctx.clientPhone = phone.slice(1);
    ctx.paidJoinName = [profile.firstName || profile.client?.firstName, profile.lastName || profile.client?.lastName]
      .filter(part => typeof part === "string").join(" ").trim().slice(0, 120) || "Игрок";
    ctx.paidJoin = true;
    return paidJoinDb(ctx, "paid_join_journal", "journal", "findOne", [{ _id: paidJoinKey(ctx) }]);
  }

  if (step === "paid_join_journal") {
    if (body === null) {
      return paidJoinDb(ctx, "paid_join_admission", "games", "find", [{ id: ctx.gameId }, { limit: 2 }]);
    }
    if (!paidJoinExact(ctx, body) || !paidJoinBodyId(body.attempt)) return paidJoinPending();
    if (body.state === "TRANSACTION_REQUESTED" && paidJoinBodyId(body.bookingId)
      && paidJoinBodyId(body.expectedProductId) && Number.isSafeInteger(body.expectedDiscountMinor)
      && Number.isSafeInteger(body.expectedAmountMinor) && body.expectedAmountMinor > 0) {
      ctx.paidJoinAttempt = body.attempt;
      ctx.paidJoinUncertain = body;
      ctx.step = "paid_join_reconcile_transactions";
      return adminRequest(ctx, "GET", "/clients/" + encodeURIComponent(ctx.clientId) + "/transactions?size=100&page=0");
    }
    if (body.state !== "CHECKOUT_READY" || !paidJoinCheckoutValid(ctx, body.checkout)
      || body.bookingId !== body.checkout.bookingId || body.attempt !== body.checkout.paymentRef) return paidJoinPending();
    ctx.paidJoinAttempt = body.attempt;
    ctx.paidJoinCheckout = body.checkout;
    ctx.step = "paid_join_replay_transaction";
    return adminRequest(ctx, "GET", paidJoinTransactionPath(body.checkout.transactionId));
  }

  if (step === "paid_join_admission" || step === "paid_join_readmit") {
    if (!Array.isArray(body) || body.length !== 1) return paidJoinPending();
    const game = body[0];
    if (!paidJoinGameValid(ctx, game)) return paidJoinPending();
    const actor = (row) => paidJoinActorMatches(ctx, row);
    const prior = game.metadata.splitPayment.payments.filter(actor);
    if (game.participants.some(actor) || game.waitlist.some(actor) || prior.some(p => !paidJoinInactive(p))) {
      return paidJoinPending();
    }
    if (step === "paid_join_admission" && prior.length) {
      if (prior.length !== 1) return paidJoinPending();
      const p = prior[0];
      const checkout = {
        exerciseId: ctx.exerciseId, bookingId: p.bookingId, transactionId: p.transactionId,
        paymentRef: p.paymentRef, paymentUrl: p.paymentUrl, deadlineAt: p.deadlineAt, toPayMinor: p.amountMinor,
      };
      if (!paidJoinCheckoutValid(ctx, checkout)) return paidJoinPending();
      ctx.paidJoinLegacyCheckout = true;
      ctx.paidJoinCheckout = checkout;
      ctx.step = "paid_join_replay_transaction";
      return adminRequest(ctx, "GET", paidJoinTransactionPath(checkout.transactionId));
    }
    ctx.step = "paid_join_active_bookings";
    return adminRequest(ctx, "GET", "/exercises/" + encodeURIComponent(ctx.exerciseId)
      + "/bookings?showCancelled=false&page=0&size=100");
  }

  if (step === "paid_join_active_bookings") {
    const rows = body?.content;
    if (!isOk(msg.statusCode) || !Array.isArray(rows) || body.last !== true || body.totalElements !== rows.length
      || rows.some(b => !b?.client?.id || b.isCancelled !== false || b.client.id === ctx.clientId)
      || ![2, 4].includes(ctx.shareCount) || rows.length >= ctx.shareCount) return paidJoinPending();
    ctx.paidJoinAuthComplete = true;
    return continueSplitAfterToken(ctx);
  }

  if (step === "paid_join_claim_insert" || step === "paid_join_claim_ack") {
    const claimed = step === "paid_join_claim_insert"
      ? body?.acknowledged === true && body.insertedId === paidJoinKey(ctx)
      : paidJoinWriteOk(body);
    if (!claimed) return paidJoinPending();
    ctx.step = "create_booking";
    return adminRequest(ctx, "POST", "/exercises/" + encodeURIComponent(ctx.exerciseId) + "/bookings",
      ctx.paidJoinBookingPayload);
  }

  if (step === "paid_join_created_booking") {
    if (!isOk(msg.statusCode) || !paidJoinCurrentBooking(ctx, body, ctx.bookingId)
      || body.isCancelled !== false || !paidJoinNoVisit(body)) return paidJoinPending();
    return paidJoinTransition(ctx, "paid_join_booking_ack", "BOOKING_REQUESTED", {
      state: "BOOKING_CREATED", bookingId: ctx.bookingId,
    });
  }

  if (step === "paid_join_booking_ack") {
    if (!paidJoinWriteOk(body)) return paidJoinPending();
    ctx.step = "available_products";
    return adminRequest(ctx, "POST", "/products/available/by-booking", {
      bookingIds: [ctx.bookingId], clientId: ctx.clientId, studioId: ctx.studioId,
    });
  }

  if (step === "paid_join_transaction_ack") {
    if (!paidJoinWriteOk(body)) return paidJoinPending();
    ctx.step = "transaction";
    return adminRequest(ctx, "POST", "/transactions", ctx.transactionPayload);
  }

  if (step === "paid_join_reconcile_transactions") {
    const attempt = ctx.paidJoinUncertain;
    const rows = body?.content;
    if (!isOk(msg.statusCode) || !Array.isArray(rows) || body.last !== true || body.totalElements !== rows.length) {
      return paidJoinPending();
    }
    const candidates = rows.filter(tx => paidJoinLinkedTransaction(ctx, tx, {
      transactionId: tx?.id, bookingId: attempt.bookingId, toPayMinor: attempt.expectedAmountMinor,
      productId: attempt.expectedProductId, discountAmountMinor: attempt.expectedDiscountMinor,
    }));
    if (candidates.length !== 1) return paidJoinPending();
    const tx = candidates[0];
    const checkout = {
      ok: true, mode: "join", exerciseId: ctx.exerciseId, bookingId: attempt.bookingId,
      transactionId: tx.id, paymentRef: attempt.attempt, paymentUrl: tx.cardPaymentInfo?.paymentUrl,
      productId: attempt.expectedProductId, discountAmountMinor: attempt.expectedDiscountMinor,
      toPayMinor: attempt.expectedAmountMinor, toPay: attempt.expectedAmountMinor / 100,
      selectedPaymentMode: "one_time", deadlineAt: tx.paymentDueDate,
    };
    if (!paidJoinCheckoutValid(ctx, checkout)) return paidJoinPending();
    ctx.paidJoinCheckout = checkout;
    return paidJoinTransition(ctx, "paid_join_checkout_ack", "TRANSACTION_REQUESTED", {
      state: "CHECKOUT_READY", checkout,
    });
  }

  if (step === "paid_join_verify_checkout") {
    if (!isOk(msg.statusCode) || !paidJoinLinkedTransaction(ctx, body, ctx.paidJoinCheckout)) return paidJoinPending();
    return paidJoinRememberCheckout(ctx);
  }

  if (step === "paid_join_checkout_ack") {
    if (!paidJoinWriteOk(body)) return paidJoinPending();
    ctx.step = "paid_join_replay_transaction";
    return adminRequest(ctx, "GET", paidJoinTransactionPath(ctx.paidJoinCheckout.transactionId));
  }

  if (step === "paid_join_replay_transaction") {
    const checkout = ctx.paidJoinCheckout;
    if (!isOk(msg.statusCode) || !paidJoinLinkedTransaction(ctx, body, checkout)) return paidJoinPending();
    const providerDue = Date.parse(body.paymentDueDate);
    const recordedDue = Date.parse(checkout.deadlineAt);
    if (!Number.isFinite(providerDue) || providerDue !== recordedDue) return paidJoinPending();
    const expired = providerDue <= Date.now();
    const unpaid = paidJoinNoMoney(body);
    const card = body.cardPaymentInfo;
    ctx.paidJoinCanReplay = !ctx.paidJoinLegacyCheckout && unpaid && !expired
      && ["NEW", "UNPAID"].includes(card?.status) && card.paymentUrl === checkout.paymentUrl;
    ctx.paidJoinCanReplace = unpaid && card?.status === "REJECTED"
      && (card.declineOutcome === "CANCELLED" || (card.declineOutcome === "EXPIRED" && expired));
    if (!ctx.paidJoinCanReplay && !ctx.paidJoinCanReplace) return paidJoinPending();
    ctx.step = "paid_join_replay_booking";
    return adminRequest(ctx, "GET", paidJoinBookingPath(ctx, checkout.bookingId));
  }

  if (step === "paid_join_replay_booking") {
    if (!isOk(msg.statusCode) || !paidJoinCurrentBooking(ctx, body, ctx.paidJoinCheckout.bookingId)) return paidJoinPending();
    if (body.isCancelled === false && ctx.paidJoinCanReplay && paidJoinNoVisit(body)) return paidJoinGameRead(ctx);
    if (body.isCancelled === false && ctx.paidJoinCanReplace && !ctx.paidJoinLegacyCheckout && paidJoinNoVisit(body)) {
      // Project a late-recovered checkout without reopening its URL, so the
      // existing timeout owner can verify and cancel the exact unpaid booking.
      ctx.paidJoinArchive = true;
      return paidJoinGameRead(ctx);
    }
    if (body.isCancelled !== true || !ctx.paidJoinCanReplace || !paidJoinNoVisit(body)) return paidJoinPending();
    if (!ctx.paidJoinLegacyCheckout) ctx.paidJoinPreviousAttempt = ctx.paidJoinAttempt;
    return paidJoinDb(ctx, "paid_join_readmit", "games", "find", [{ id: ctx.gameId }, { limit: 2 }]);
  }

  if (step === "paid_join_game_read") {
    if (!Array.isArray(body) || body.length !== 1) return paidJoinPending();
    const projection = paidJoinRoster(ctx, body[0]);
    if (!projection) return paidJoinPending();
    if (projection.existing) return ctx.paidJoinArchive ? paidJoinPending() : paidJoinResponse(ctx.paidJoinCheckout);
    return paidJoinDb(ctx, "paid_join_game_ack", "games", "updateOne", [
      projection.filter, { $set: projection.set }, paidJoinMajority,
    ]);
  }

  if (step === "paid_join_game_ack") {
    if (paidJoinWriteOk(body)) return ctx.paidJoinArchive ? paidJoinPending() : paidJoinResponse(ctx.paidJoinCheckout);
    ctx.paidJoinProjectionRetries = (ctx.paidJoinProjectionRetries || 0) + 1;
    return ctx.paidJoinProjectionRetries <= 2 ? paidJoinGameRead(ctx) : paidJoinPending();
  }

  return paidJoinPending();
};
