// Stored alongside subscription operations, under a separate ID namespace and schema.
// Neither timeouts nor a missing provider row transfer a held attempt.
const teKind = "LK1_TOURNAMENT_ENROLLMENT_V2";
const teTenant = "iSkq6G";
const teReservationMs = 120000;
const teWrite = { writeConcern: { w: "majority", j: true } };
const teRead = { limit: 2, readPreference: "primary", readConcern: { level: "majority" } };
const teId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const teKey = (tenant, actor, exercise) => {
  if (tenant !== teTenant || ![actor, exercise].every(teId)) return null;
  return "tournament-enrollment:" + JSON.stringify([tenant, actor.toLowerCase(), exercise.toLowerCase()]);
};
const teExact = (values, expected) => {
  const present = values.filter(value => value != null);
  return present.length > 0 && present.every(value => value === expected);
};
const teEmpty = value => value === undefined || value === null || value === "";
const teDate = value => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const teMatch = result => result?.acknowledged === true && result.matchedCount === 1
  && result.modifiedCount === 1 && result.upsertedCount === 0 && result.upsertedId === null;
const teFind = id => ({ kind: "find", payload: [{ _id: id }, teRead] });
const teFilter = row => ({ _id: row._id, kind: teKind, generation: row.generation, state: row.state, owner: row.owner,
  transactionId: row.transactionId ?? { $exists: false } });
const teUpdate = (row, change) => ({ kind: "update", payload: [teFilter(row), change, teWrite] });
const teResult = (outcome, fields = {}) => ({ kind: "result", outcome, ...fields });
const teViva = "https://api.vivacrm.ru";
const teRefusalCodes = [400, 401, 403, 404, 405, 410, 415, 422];

function teBegin(tenant, actor, exercise, mode, owner) {
  const key = teKey(tenant, actor, exercise);
  const state = { key, tenant, actor, exercise, mode, owner, step: "read" };
  return { state, effect: key ? teFind(key) : teResult("unresolved") };
}

function teOwnerBind(row, s) {
  if (row?._id !== s.key || row.kind !== teKind || teKey(row.target?.tenant, row.target?.actor, row.target?.exercise) !== s.key
    || !Number.isSafeInteger(row.generation) || row.generation < 1 || row.generation >= Number.MAX_SAFE_INTEGER
    || !["RESERVED", "HELD", "RELEASED"].includes(row.state) || !teDate(row.createdAt)) return false;
  if (row.state === "RELEASED" && (!teDate(row.releasedAt)
    || !["SUBSCRIPTION_REJECTED", "SUBSCRIPTION_MONEY_CANCELLED", "SUBSCRIPTION_VISIT_RETURNED", "WIDGET_CHECKOUT_CLOSED"]
      .includes(row.proof?.type))) return false;
  if (row.state === "RESERVED" && (row.owner?.mode !== "subscription" || !teDate(row.reservedUntil))) return false;
  if (row.owner?.mode === "checkout") {
    return Array.isArray(row.owner.selection) && row.owner.selection.length === 3 && teId(row.owner.selection[1]);
  }
  return row.owner?.mode === "subscription" && typeof row.owner.operationKey === "string"
    && teId(row.owner.operationId) && teDate(row.owner.attemptedAt);
}

function teLookupResult(value) {
  return Array.isArray(value) && value.length <= 1
    && (value.length === 0 || (value[0] && typeof value[0] === "object")) ? value : null;
}

function teAcquire(s, previous) {
  const reservation = s.owner.mode === "subscription";
  const now = Date.now();
  s.next = { _id: s.key, kind: teKind, target: { tenant: s.tenant, actor: s.actor, exercise: s.exercise },
    generation: previous ? previous.generation + 1 : 1, state: reservation ? "RESERVED" : "HELD",
    owner: s.owner, createdAt: new Date(now).toISOString(),
    ...(reservation ? { reservedUntil: new Date(now + teReservationMs).toISOString() } : {}) };
  if (!teOwnerBind(s.next, s)) return teResult("unresolved");
  s.step = previous ? "replace" : "insert";
  if (!previous) return { kind: "insert", payload: [s.next, teWrite] };
  // Every writer uses the old generation in the predicate, including late callbacks.
  const { _id, ...fields } = s.next;
  const update = teUpdate(previous, { $set: fields, $unset: { transactionId: "", proof: "", releasedAt: "",
    ...(reservation ? {} : { reservedUntil: "" }) } });
  if (previous.state === "RESERVED") {
    update.payload[0].reservedUntil = previous.reservedUntil;
    update.payload[0].$expr = { $lte: [{ $toDate: "$reservedUntil" }, "$$NOW"] };
  }
  return update;
}

function teRelease(s, proof) {
  s.step = "release";
  s.proof = proof;
  return teUpdate(s.row, { $set: { state: "RELEASED", proof, releasedAt: new Date().toISOString() } });
}

function teHttpVerified(response, url) {
  return !response.error && response.statusCode === 200 && response.method === "GET" && response.url === url
    && response.responseUrl === url && response.followRedirects === false && response.maxRedirects === 0;
}

function teExisting(s) {
  const row = s.row;
  if (s.owner.mode === "checkout" && row.owner.mode === "checkout"
    && JSON.stringify(s.owner.selection) === JSON.stringify(row.owner.selection)) {
    return teId(row.transactionId) ? teResult("replay", { transactionId: row.transactionId }) : teResult("unresolved");
  }
  return teResult("locked");
}

function teSubscriptionTerminal(row, op) {
  if (!op || op._id !== row.owner.operationKey || op.operationId !== row.owner.operationId
    || teKey(op.tenantKey, op.actorClientId, op.exerciseId) !== row._id || op.category !== "tournament"
    || op.tournamentEnrollment?.generation !== row.generation
    || op.tournamentEnrollment?.attemptedAt !== row.owner.attemptedAt) return null;
  const lk = op.lk1;
  if (op.state === "FAILED" && teDate(op.failedAt) && teRefusalCodes.includes(op.failure?.statusCode)
    && op.tournamentRejection?.generation === row.generation
    && op.tournamentRejection?.status === op.failure.statusCode
    && [op.bookingId, op.upstreamBookingId, op.acceptedAt, op.correlationId, lk?.transactionId,
      lk?.transactionAttemptedAt, lk?.transactionIntent, lk?.checkout, lk?.visitJob].every(teEmpty)
    && (!op.managedEntitlementOperationId || op.tournamentRejection.entitlementReleased === true)) {
    return { type: "SUBSCRIPTION_REJECTED", operationId: op.operationId, at: op.failedAt };
  }
  if (op.state !== "RELEASED" || !teDate(op.releasedAt) || !teId(op.bookingId)
    || (!teEmpty(op.upstreamBookingId) && op.upstreamBookingId !== op.bookingId)) return null;
  const unpaid = lk?.cancelledAllowanceRelease;
  const intent = lk?.transactionIntent;
  const checkout = lk?.checkout;
  const expired = op.releaseReason === "LK1_UNPAID_CHECKOUT_EXPIRED" && lk?.unpaidCancellation?.phase === "CANCELLED"
    && lk.unpaidCancellation.verifiedAt === op.releasedAt;
  const cancelled = op.releaseReason === "CANCELLED_UNPAID_BOOKING" && !lk?.unpaidCancellation;
  if ((expired || cancelled) && lk?.decision?.subscriptionVisitCount === 0 && !lk.visitJob
    && unpaid?.schemaVersion === 1 && unpaid.proofId === op.operationId && unpaid.verifiedAt === op.releasedAt
    && unpaid.bookingState === "CANCELLED" && unpaid.transactionState === "UNPAID_EXPIRED"
    && unpaid.bookingId === op.bookingId && teId(unpaid.transactionId)
    && unpaid.transactionId === lk.transactionId && unpaid.transactionId === checkout?.transactionId
    && intent?.bookingId === op.bookingId && intent.actorClientId === op.actorClientId
    && Number.isSafeInteger(unpaid.amountMinor) && unpaid.amountMinor > 0
    && unpaid.amountMinor === checkout.toPayMinor && unpaid.amountMinor === intent.chargeMinor
    && unpaid.amountMinor === lk.decision.benefit?.finalPriceMinor) {
    return { type: "SUBSCRIPTION_MONEY_CANCELLED", operationId: op.operationId, at: op.releasedAt };
  }
  const visit = lk?.freeCancellationReturn;
  if (op.releaseReason === "LK1_FREE_VISIT_RETURN_VERIFIED" && visit?.schemaVersion === 1
    && visit.verifiedAt === op.releasedAt && visit.method === "SERVICE" && visit.count === 1
    && visit.binding?.tenantKey === op.tenantKey && visit.binding?.operationId === op.operationId
    && visit.binding?.operationKey === op._id && visit.binding?.bookingId === op.bookingId
    && visit.binding?.actorClientId === op.actorClientId && visit.binding?.exerciseId === op.exerciseId
    && visit.binding?.clientSubscriptionId === op.clientSubscriptionId
    && visit.binding?.serviceDate === op.serviceDate && typeof lk.fingerprint === "string" && lk.fingerprint.length > 0
    && visit.binding?.fingerprint === lk.fingerprint
    && visit.before?.targetPresent === true && visit.after?.targetPresent === false
    && Number.isSafeInteger(visit.before.left) && visit.after.left === visit.before.left + 1
    && visit.before.total === visit.after.total && typeof visit.before.other === "string" && visit.before.other === visit.after.other
    && op.releaseBookingId === op.bookingId && op.releasedBookingIds?.includes(op.bookingId)
    && lk.decision?.subscriptionVisitCount === 1 && lk.decision?.benefit?.finalPriceMinor === 0
    && [lk.transactionAttemptedAt, lk.transactionId, lk.transactionIntent, lk.checkout, lk.visitJob].every(teEmpty)) {
    return { type: "SUBSCRIPTION_VISIT_RETURNED", operationId: op.operationId, at: op.releasedAt };
  }
  return null;
}

const teNoMoney = row => row
  && [row.paid, row.isPaid, row.refunded, row.isRefunded].every(value => value == null || value === false)
  && ["paymentDate", "paidAt", "refundDate", "refundedAt", "refund", "acquiringAuthCode", "acquiringRrnCode"]
    .every(key => teEmpty(row[key]))
  && ["paidAmount", "paidAmountMinor", "paidAmountKopecks", "refundSum", "refundedAmount", "refundedAmountMinor"]
    .every(key => teEmpty(row[key]) || row[key] === 0);

function teClosedTransaction(s, transaction) {
  const row = s.row, line = transaction?.products?.[0], card = transaction?.cardPaymentInfo;
  if (!transaction || !teExact([transaction.id, transaction.uuid, transaction.transactionId], row.transactionId)
    || !teExact([transaction.clientId, transaction.client?.id, transaction.client?.uuid, transaction.client?.clientId], row.target.actor)
    // A card decline can be retried under the same order. Require cancellation of the sale.
    || !teExact([transaction.status, transaction.state, transaction.transactionStatus], "CANCELLED")
    || ![undefined, null, "UNPAID", "CANCELLED"].includes(transaction.paymentStatus)
    || [transaction.isCancelled, transaction.cancelled, transaction.canceled].some(value => value != null && value !== true)
    || transaction.paymentMethod !== "WIDGET" || !Array.isArray(transaction.products) || transaction.products.length !== 1
    || !teExact([line?.id, line?.productId, line?.product?.id], row.owner.selection[1]) || line.type !== row.owner.productType
    || line.count !== 1 || !Array.isArray(line.bookingRequests) || line.bookingRequests.length !== 1
    || !teExact([line.bookingRequests[0]?.exerciseId, transaction.exerciseId, transaction.exercise?.id], row.target.exercise)
    || line.bookingRequests[0]?.exerciseId !== row.target.exercise
    || !teDate(transaction.createDate) || !teDate(transaction.paymentDueDate)
    || Date.parse(transaction.createDate) < Date.parse(row.createdAt) - 60000
    || Date.parse(transaction.paymentDueDate) < Date.parse(transaction.createDate)
    || Date.now() < Math.max(Date.parse(transaction.paymentDueDate), Date.parse(transaction.createDate) + 25 * 60000) + 60000
    || transaction.deposit !== 0 || transaction.processingStatus !== null
    || transaction.receiptPending !== false || transaction.possibleDoublePayment !== false
    || line.used === true || !teNoMoney(transaction) || !teNoMoney(line)
    || [transaction.clientSubscriptionId, transaction.clientSubscription, line.clientSubscriptionId, line.clientSubscription].some(x => !teEmpty(x))) return false;
  if (!card || card.status !== "REJECTED" || !["CANCELLED", "EXPIRED"].includes(card.declineOutcome)
    || !teId(card.paymentId) || !teNoMoney(card)
    || Object.keys(card).some(key => !["paymentId", "paymentUrl", "status", "declineOutcome", "declineReason", "declineMessage"].includes(key))) return false;
  if (!Number.isSafeInteger(transaction.toPay) || transaction.toPay <= 0
    || !Array.isArray(transaction.paymentLegs) || transaction.paymentLegs.length !== 1
    || transaction.paymentLegs[0]?.source !== "CARD" || transaction.paymentLegs[0]?.amountKopecks !== transaction.toPay
    || !teNoMoney(transaction.paymentLegs[0])) return false;
  if (!["purchasedServices", "receipts", "executedSurcharges", "paidByOtherSaleBookingIds", "transactionRefunds"]
    .every(key => Array.isArray(transaction[key]) && transaction[key].length === 0)) return false;
  return ["cardPaymentStatus", "payments", "cardPayments", "paymentAttempts", "payment", "paymentInfo"]
    .every(key => teEmpty(transaction[key]));
}

function teLinkedBookings(transaction) {
  const line = transaction.products[0];
  const request = line.bookingRequests[0];
  const ids = [];
  for (const source of [transaction, line, request]) {
    for (const key of ["bookingId", "clientBookingId"]) {
      if (!teEmpty(source[key])) ids.push(source[key]);
    }
    for (const key of ["bookingIds", "paymentBookingIds"]) {
      if (source[key] == null) continue;
      if (!Array.isArray(source[key])) return null;
      ids.push(...source[key]);
    }
  }
  // Unknown association formats are not proof of absence.
  if (transaction.booking || line.booking || request.booking || (line.pricingDetails != null
    && (!Array.isArray(line.pricingDetails) || line.pricingDetails.some(x => !x || x.bookingId || x.clientBookingId)))) return null;
  return ids.every(teId) ? [...new Set(ids)] : null;
}

function teClosedBookings(s, payload) {
  const rows = Array.isArray(payload) ? payload : payload?.content;
  // A truncated page could hide another live seat for the same actor.
  if (!Array.isArray(rows) || rows.length >= 200 || (!Array.isArray(payload)
    && (payload.last !== true || payload.totalElements !== rows.length))) return false;
  const ids = new Set();
  const cancelledOwned = new Set();
  const safe = rows.every(row => {
    const id = row?.id ?? row?.bookingId;
    const actor = row?.clientId ?? row?.client?.id;
    if (!teId(id) || ids.has(id) || !teId(actor) || !teExact([row.id, row.bookingId], id)
      || !teExact([row.clientId, row.client?.id, row.client?.clientId], actor)) return false;
    ids.add(id);
    if (actor.toLowerCase() !== s.actor.toLowerCase()) return true;
    if ([row.exerciseId, row.exercise?.id].some(id => id != null && id !== s.exercise)) return false;
    const flags = [row.isCancelled, row.cancelled, row.canceled].filter(x => x != null);
    const states = [row.status, row.state, row.bookingStatus].filter(x => !teEmpty(x));
    const cancelled = flags.every(x => x === true) && states.every(x => ["CANCELLED", "CANCELED"].includes(x))
      && flags.length + states.length > 0 && teNoMoney(row)
      && [row.receiptPending, row.possibleDoublePayment].every(value => value == null || value === false)
      && [row.pendingPayments, row.receipts, row.refunds, row.payments, row.paymentLegs]
        .every(value => value == null || (Array.isArray(value) && value.length === 0))
      && (row.amountDue == null || (typeof row.amountDue === "object" && !Array.isArray(row.amountDue)
        && [row.amountDue.paidKopecks, row.amountDue.refundedKopecks].every(x => x == null || x === 0)))
      && [row.clientSubscriptionId, row.clientSubscription, row.transactionId, row.transactionStatus, row.paymentStatus,
        row.paymentMethod, row.refundMethod, row.processingStatus].every(teEmpty);
    if (cancelled) cancelledOwned.add(id);
    return cancelled;
  });
  return safe && s.bookingIds.every(id => cancelledOwned.has(id));
}

function teStep(s, reply) {
  if (s.step === "read") {
    const rows = !reply.error && teLookupResult(reply.payload);
    if (!rows) return teResult("unresolved");
    const row = rows[0];
    if (row && !teOwnerBind(row, s)) return teResult("unresolved");
    const expiredReservation = row?.state === "RESERVED" && Date.parse(row.reservedUntil) <= Date.now();
    if (!row || row.state === "RELEASED" || expiredReservation) {
      return s.mode === "inspect" ? teResult("open") : teAcquire(s, row);
    }
    if (row.state === "RESERVED") return teResult("locked");
    s.row = row;
    if (s.mode === "acquire") return teResult("locked");
    if (row.owner.mode === "subscription") {
      s.step = "owner";
      return teFind(row.owner.operationKey);
    }
    if (!teId(row.transactionId)) return teExisting(s);
    s.step = "transaction";
    s.url = teViva + "/api/v1/transactions/" + encodeURIComponent(row.transactionId);
    return { kind: "http", url: s.url };
  }
  if (s.step === "owner") {
    const rows = !reply.error && teLookupResult(reply.payload);
    const proof = rows && teSubscriptionTerminal(s.row, rows[0]);
    return proof ? teRelease(s, proof) : teExisting(s);
  }
  if (s.step === "transaction") {
    if (!teHttpVerified(reply, s.url) || !teClosedTransaction(s, reply.payload)) return teExisting(s);
    s.bookingIds = teLinkedBookings(reply.payload);
    if (!s.bookingIds?.length) return teExisting(s);
    s.step = "bookings";
    s.url = teViva + "/api/v1/exercises/" + encodeURIComponent(s.exercise) + "/bookings?showCancelled=true&size=200";
    return { kind: "http", url: s.url };
  }
  if (s.step === "bookings") {
    if (!teHttpVerified(reply, s.url) || !teClosedBookings(s, reply.payload)) return teExisting(s);
    return teRelease(s, { type: "WIDGET_CHECKOUT_CLOSED", transactionId: s.row.transactionId });
  }
  if (s.step === "insert") {
    if (!reply.error && reply.payload?.acknowledged === true && reply.payload.insertedId === s.key) {
      return teResult("acquired", { row: s.next });
    }
    return teResult("unresolved");
  }
  if (s.step === "release" || s.step === "replace") {
    if (reply.error || !teMatch(reply.payload)) return teResult("unresolved");
    return s.step === "release" ? teResult("closed") : teResult("acquired", { row: s.next });
  }
  return teResult("unresolved");
}
