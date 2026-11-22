// Read-only payment recovery for a Friendship 2.0 two-hour tournament.
// The actor comes from the bearer-authenticated Viva profile; the browser supplies
// neither a transaction ID nor a price. These steps only emit FIND, GET or FINAL.
const tournamentPaymentProduct = "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e";
const finishTournamentPaymentStatus = (status, payment = null) => {
  msg.statusCode = 200;
  msg.headers = { ...responseHeaders(), "Referrer-Policy": "no-referrer" };
  msg.payload = { status, bookingId: ctx.releaseBookingId, exerciseId: ctx.exerciseId, ...payment };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};
const tournamentPaymentUnavailable = () => finishTournamentPaymentStatus("UNAVAILABLE");
const tournamentPaymentAliases = (values, expected) => values
  .filter(value => value !== undefined && value !== null && value !== "")
  .every(value => typeof value === "string" && value === expected);
const tournamentPaymentBookingEchoes = value => {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(tournamentPaymentBookingEchoes);
  if (isObj(value)) {
    const echoes = [value.id, value.uuid, value.bookingId, value.clientBookingId]
      .flatMap(tournamentPaymentBookingEchoes);
    return echoes.length ? echoes : [value];
  }
  return [value];
};
const tournamentPaymentTime = value => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
  ? Date.parse(value) : NaN;
const prepareTournamentPaymentRead = (step, path) => readGlobal("vivacrm_access_token")
  ? prepareAdminGet(ctx, step, path) : tournamentPaymentUnavailable();

if (ctx.step === "tournament_payment_find") {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return tournamentPaymentUnavailable();
  const row = msg.payload[0];
  if (!row) return finishTournamentPaymentStatus("NOT_APPLICABLE");
  const { lk1 } = row;
  const intent = lk1?.transactionIntent;
  const amount = lk1?.decision?.benefit?.finalPriceMinor;
  if (row.tenantKey !== ctx.tenantKey || row.actorClientId !== ctx.actorClientId
    || row.exerciseId !== ctx.exerciseId || row.bookingId !== ctx.releaseBookingId
    || row._id !== `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, row.operationId])}`
    || row.category !== "tournament" || row.state !== "CONFIRMED"
    || lk1?.rule?.productId !== tournamentPaymentProduct || lk1?.target?.eventId !== ctx.exerciseId
    || lk1.target.category !== "TOURNAMENT" || lk1.target.durationMinutes !== 120
    || lk1.decision?.subscriptionVisitCount !== 0 || lk1.decision.benefit?.kind !== "PERCENT_DISCOUNT"
    || !Number.isSafeInteger(amount) || amount <= 0) return tournamentPaymentUnavailable();
  const transactionId = toStr(lk1.transactionId);
  if (transactionId && (!intent || intent.bookingId !== row.bookingId || intent.actorClientId !== row.actorClientId
    || intent.studioId !== lk1.target.stationId || intent.chargeMinor !== amount
    || (lk1.checkout && (lk1.checkout.transactionId !== transactionId || lk1.checkout.toPayMinor !== amount)))) {
    return tournamentPaymentUnavailable();
  }
  ctx.tournamentPayment = {
    amount, transactionId, startsAt: lk1.target.startsAt,
    blocked: Boolean(lk1.unpaidCancellation),
  };
  return prepareTournamentPaymentRead("tournament_payment_booking",
    `/api/v1/clients/${encodeURIComponent(ctx.actorClientId)}/bookings/${encodeURIComponent(ctx.releaseBookingId)}`);
}

if (ctx.step === "tournament_payment_booking") {
  const booking = unwrapRecord(msg.payload);
  const payment = ctx.tournamentPayment;
  if (Number(msg.statusCode) !== 200 || !payment || bookingId(booking) !== ctx.releaseBookingId
    || !tournamentPaymentAliases([booking.id, booking.bookingId, booking.uuid], ctx.releaseBookingId)
    || bookingExerciseId(booking) !== ctx.exerciseId
    || !tournamentPaymentAliases([booking.exercise?.id, booking.exercise?.uuid, booking.exerciseId, booking.vivaExerciseId, booking.eventId], ctx.exerciseId)
    || !tournamentPaymentAliases([booking.clientId, booking.client?.id, booking.client?.clientId, booking.client?.uuid], ctx.actorClientId)) {
    return tournamentPaymentUnavailable();
  }
  const flags = [booking.cancelled, booking.isCancelled, booking.canceled].filter(flag => flag != null);
  if (!flags.length || flags.some(flag => typeof flag !== "boolean" || flag !== flags[0])) return tournamentPaymentUnavailable();
  if (flags[0]) return finishTournamentPaymentStatus("NONE");
  if (booking.cancelledAt || booking.cancellationDate
    || [booking.status, booking.state, booking.bookingStatus].some(status => /CANCEL|ARCHIV|REMOV/i.test(String(status || "")))) {
    return tournamentPaymentUnavailable();
  }
  const linkedId = toStr(booking.transactionId || booking.transactionStatus?.transactionId || booking.transaction?.id);
  if (!tournamentPaymentAliases([booking.transactionId, booking.transactionStatus?.transactionId, booking.transaction?.id], linkedId)) {
    return tournamentPaymentUnavailable();
  }
  const onPlace = booking.paymentType === "ON_PLACE" && !linkedId && !isSubscriptionBooking(booking)
    && !isInactiveBooking(booking) && booking.visitConfirmed !== true
    && booking.paid !== true && !booking.paidAt && !booking.paymentDate;
  if (!onPlace && !linkedId) return tournamentPaymentUnavailable();
  if (!linkedId && !payment.transactionId) return finishTournamentPaymentStatus("PAYMENT_PENDING");
  payment.readTransactionId = linkedId || payment.transactionId;
  payment.onPlace = onPlace;
  return prepareTournamentPaymentRead("tournament_payment_transaction",
    `/api/v1/transactions/${encodeURIComponent(payment.readTransactionId)}`);
}

if (ctx.step === "tournament_payment_transaction") {
  const transaction = unwrapRecord(msg.payload);
  const payment = ctx.tournamentPayment;
  const products = asArray(transaction?.products);
  const bookingEchoes = [transaction?.bookingId, transaction?.bookingIds, transaction?.paymentBookingIds,
    ...products.flatMap(product => [product?.bookingId, product?.bookingIds, product?.paymentBookingIds, product?.clientBookingId,
      ...asArray(product?.pricingDetails).flatMap(detail => [detail?.bookingId, detail?.clientBookingId])])]
    .flatMap(tournamentPaymentBookingEchoes);
  if (Number(msg.statusCode) !== 200 || !payment || toStr(transaction?.id || transaction?.transactionId) !== payment.readTransactionId
    || !tournamentPaymentAliases([transaction.id, transaction.transactionId], payment.readTransactionId)
    || !tournamentPaymentAliases([transaction.clientId, transaction.client?.id, transaction.client?.clientId, transaction.client?.uuid], ctx.actorClientId)
    || !tournamentPaymentAliases([transaction.exerciseId, transaction.exercise?.id], ctx.exerciseId)
    || !tournamentPaymentAliases(bookingEchoes, ctx.releaseBookingId)
    || (transaction.currency != null && transaction.currency !== "RUB")
    || !tournamentPaymentAliases([transaction.state, transaction.paymentStatus, transaction.transactionStatus?.transactionStatus
      ?? transaction.transactionStatus], transaction.status)) return tournamentPaymentUnavailable();
  const original = payment.transactionId === payment.readTransactionId;
  const amounts = [transaction.toPay, transaction.toPayMinor].filter(value => value != null);
  if (original && (!amounts.length || amounts.some(value => value !== payment.amount))) return tournamentPaymentUnavailable();
  const cards = [transaction.cardPaymentInfo, transaction.cardPaymentStatus, transaction.transactionStatus?.cardPaymentStatus]
    .filter(isObj);
  const hasRefund = [transaction, ...cards].some(value => value.refundedAt || value.refundDate
    || value.refund || value.refundSum || value.refundedAmountMinor);
  if (transaction.status === "PAID") {
    return !hasRefund && cards.every(card => !card.status || ["CONFIRMED", "PAID"].includes(card.status))
      ? finishTournamentPaymentStatus("REGISTERED") : tournamentPaymentUnavailable();
  }
  if (transaction.status !== "UNPAID") return tournamentPaymentUnavailable();

  const createdAt = tournamentPaymentTime(transaction.createDate || transaction.createdAt);
  const dueAt = tournamentPaymentTime(transaction.paymentDueDate);
  const expiresAt = Math.min(createdAt + 20 * 60_000, dueAt, tournamentPaymentTime(payment.startsAt));
  const urls = [transaction.paymentUrl, transaction.paymentLink, ...cards.flatMap(card => [card.paymentUrl, card.paymentLink])]
    .filter(value => value != null && value !== "");
  const url = urls[0];
  const canPay = original && payment.onPlace && !payment.blocked
    && !hasRefund && [transaction, ...cards].every(value => !value.paidAt && !value.paymentDate
      && !value.paidAmount && !value.paidAmountMinor && !value.deposit)
    && (!transaction.createdAt || tournamentPaymentTime(transaction.createdAt) === createdAt)
    && cards.some(card => card.status === "NEW")
    && tournamentPaymentAliases(cards.map(card => card.status), "NEW")
    && Number.isFinite(expiresAt) && createdAt <= Date.now() && expiresAt > Date.now()
    && typeof url === "string" && url.startsWith("https://pay.vivacrm.ru/") && url.length <= 4096
    && !/[\s\\]/.test(url) && tournamentPaymentAliases(urls, url);
  return finishTournamentPaymentStatus("PAYMENT_PENDING", canPay
    ? { paymentUrl: url, paymentExpiresAt: new Date(expiresAt).toISOString() } : null);
}

// PROFILE PAYMENT LOOKUP
  if (ctx.step === "tournament_payment_profile") {
    ctx.step = "tournament_payment_find";
    msg.payload = {
      tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, exerciseId: ctx.exerciseId,
      bookingId: ctx.releaseBookingId, category: "tournament", state: "CONFIRMED",
      "lk1.rule.productId": tournamentPaymentProduct, "lk1.target.durationMinutes": 120,
      "lk1.decision.benefit.finalPriceMinor": { $gt: 0 },
    };
    delete msg.error;
    return emit(OUTPUT_MONGO_FIND);
  }
