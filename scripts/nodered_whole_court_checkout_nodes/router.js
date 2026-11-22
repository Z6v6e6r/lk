// Ports: Mongo find, Mongo updateOne, Viva HTTP, private HTTP response.
const op = msg._wholeCourt;
const out = (port, value = msg) => Array.from({ length: 4 }, (_, i) => (i === port ? value : null));
const reply = (status, body) => out(3, wholeCourtReply(status, body));
const unavailable = () => reply(503, { code: 'WHOLE_COURT_UNAVAILABLE' });
// Once a provider request has been issued, custody of its reply outlives the delegation.
// This exception cannot issue another request or return a checkout URL.
const savingProviderReply = op?.phase === 'dispatched';
if (!gcObject(op?.claims) || (!savingProviderReply && !wholeCourtFresh(op.claims)))
  return unavailable();
const c = op.claims;
const b = op.body;
const target = wholeCourtConfig();
if (
  !savingProviderReply &&
  (!wholeCourtTargetMatches(target, c, b) ||
    !bookedOperationReadConfig(env).ok ||
    !bookedOperationExecutionFlagEnabled(env))
)
  return unavailable();
const key = wholeCourtKey(c, b);
const binding = wholeCourtBinding(c, b);
const admissionKey = wholeCourtAdmissionKey(c);
const where = { _id: key, kind: wholeCourtKind, tenant_id: c.tenant_id };
const pending = () =>
  reply(202, { operationId: b.operationId, draftId: b.draftId, status: 'UNKNOWN' });
const conflict = () => reply(409, { code: 'WHOLE_COURT_ATTEMPT_CONFLICT' });
const exact = (row) =>
  row.kind === wholeCourtKind &&
  row.tenant_id === c.tenant_id &&
  row.binding === binding &&
  row.operationId === b.operationId;
const clean = () => {
  for (const k of [
    'url',
    'method',
    'headers',
    'payload',
    'responseUrl',
    'statusCode',
    'error',
    'requestTimeout',
    'limit',
  ])
    delete msg[k];
};
const find = (phase = 'found', id = key) => {
  clean();
  op.phase = phase;
  // An unexpected namespace owner must be observed before any dispatch.
  msg.payload = { _id: id };
  msg.limit = 2;
  return out(0);
};
const cas = (phase, filter, update, options = {}) => {
  clean();
  op.phase = phase;
  msg.payload = [filter, update, { ...options, writeConcern: { w: 'majority' } }];
  return out(1);
};
const globalValue = (name) => {
  try {
    return global.get(name);
  } catch {
    return null;
  }
};
const userPath = '/end-user/api/v1/' + wholeCourtTenant;
const http = (phase, method, path, admin, body) => {
  const token = admin ? globalValue('vivacrm_access_token') : op.actorToken;
  if (
    !BOOKED_OP_ACTOR_TOKEN.test(typeof token === 'string' ? token : '') ||
    (admin && !(Number(globalValue('vivacrm_token_expires_at')) > Date.now() + 10000))
  )
    return unavailable();
  clean();
  op.phase = phase;
  op.expectedUrl = wholeCourtViva + path;
  msg.url = op.expectedUrl;
  msg.method = method;
  msg.headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
    'X-Correlation-ID': c.correlation_id,
  };
  if (method === 'POST') {
    msg.headers['Content-Type'] = 'application/json';
    msg.payload = body;
  }
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  return out(2);
};
const urlExact = () =>
  !msg.error && msg.url === op.expectedUrl && msg.responseUrl === op.expectedUrl;
const payloadOk = () => urlExact() && msg.statusCode === 200 && gcObject(msg.payload);
const amountMatches = (v, captured) => {
  const amounts = [v.amountMinor, v.totalAmountMinor, v.paidAmountMinor].filter(
    (value) => value !== undefined,
  );
  return (
    (v.currency === undefined || v.currency === 'RUB') &&
    amounts.every((value) => value === b.amountMinor) &&
    (v.toPay === b.amountMinor ||
      (v.toPay === undefined && amounts.length > 0) ||
      (v.toPay === 0 && (captured || amounts.length > 0)))
  );
};
const echoes = (values, id) => values.every((value) => value === undefined || value === id);
const bookingEcho = (values, id) =>
  values === undefined || (Array.isArray(values) && values.length === 1 && values[0] === id);
const refundSignal = (value) =>
  [value.refunded, value.partiallyPaid, value.partiallyRefunded].some((flag) => flag === true) ||
  [value.refundedAmountMinor, value.refundAmountMinor, value.refundSum].some(
    (amount) => amount !== undefined && amount !== 0,
  ) ||
  value.refundedAt != null ||
  (value.transactionRefunds !== undefined &&
    (!Array.isArray(value.transactionRefunds) || value.transactionRefunds.length > 0)) ||
  [
    value.status,
    value.state,
    value.paymentStatus,
    value.transactionStatus,
    value.cardPaymentInfo?.status,
    value.cardPaymentStatus?.status,
  ].some((status) => typeof status === 'string' && /REFUND|PARTIAL|CHARGEBACK/i.test(status));
const confirmedEvidence = (row) => {
  const evidence = row.confirmation;
  return (
    gcKeys(
      evidence,
      'source,providerStatus,transactionId,bookingId,exerciseId,amountMinor,currency,checkedAt',
    ) &&
    evidence.source === 'VIVA_ORIGINAL_TRANSACTION' &&
    evidence.providerStatus === 'PAID' &&
    evidence.transactionId === row.transactionId &&
    evidence.bookingId === row.bookingId &&
    evidence.exerciseId === row.exerciseId &&
    evidence.amountMinor === b.amountMinor &&
    evidence.currency === 'RUB' &&
    gcIso(evidence.checkedAt) &&
    row.evidenceSha256 ===
      gcHash(
        JSON.stringify([
          binding,
          evidence.source,
          evidence.providerStatus,
          evidence.transactionId,
          evidence.bookingId,
          evidence.exerciseId,
          evidence.amountMinor,
          evidence.currency,
          evidence.checkedAt,
        ]),
      )
  );
};
const confirmResponse = (row) =>
  reply(200, {
    operationId: b.operationId,
    draftId: b.draftId,
    status: 'CONFIRMED',
    receipt: {
      provider: 'VIVA',
      transactionId: row.transactionId,
      bookingId: row.bookingId,
      exerciseId: row.exerciseId,
      amountMinor: b.amountMinor,
      currency: 'RUB',
      confirmedAt: row.confirmation.checkedAt,
    },
  });
const held = (row) =>
  [row.bookingId, row.exerciseId, row.transactionId].every(gcId) &&
  wholeCourtOriginOf(row.paymentUrl) === wholeCourtCheckoutOrigin;
const readHeld = (row) => {
  op.held = {
    paymentUrl: row.paymentUrl,
    transactionId: row.transactionId,
    bookingId: row.bookingId,
    exerciseId: row.exerciseId,
    captured: row.checkoutAmountMinor === b.amountMinor,
  };
  return http(
    'transaction',
    'GET',
    '/api/v1/transactions/' + encodeURIComponent(row.transactionId),
    true,
  );
};
const ack = () => !msg.error && msg.payload?.acknowledged === true;
const transactionClaimId = () =>
  'whole-court:v1:transaction:' +
  gcHash(JSON.stringify([c.tenant_key, op.held.transactionId])).slice(7);

if (op.phase === 'start') return http('profile', 'GET', userPath + '/profile', false);
if (op.phase === 'profile') {
  if (!payloadOk()) return unavailable();
  if (gcAlias(msg.payload, ['id', 'clientId']) !== c.provider_client_id)
    return reply(403, { code: 'WHOLE_COURT_ACTOR_MISMATCH' });
  return find('admitted', admissionKey);
}
if (op.phase === 'admitted' || op.phase === 'admissionSaved') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return unavailable();
  const entry = msg.payload[0];
  if (entry) {
    if (
      entry._id !== admissionKey ||
      entry.kind !== wholeCourtKind + '_ADMISSION' ||
      entry.tenant_id !== c.tenant_id ||
      entry.binding !== binding ||
      entry.slotKey !== key
    )
      return conflict();
    return find();
  }
  if (op.mode !== 'reserve' || op.phase === 'admissionSaved')
    return reply(404, { code: 'WHOLE_COURT_ATTEMPT_NOT_FOUND' });
  return cas(
    'admissionWrite',
    { _id: admissionKey },
    {
      $setOnInsert: {
        kind: wholeCourtKind + '_ADMISSION',
        tenant_id: c.tenant_id,
        binding,
        slotKey: key,
      },
    },
    { upsert: true },
  );
}
if (op.phase === 'admissionWrite') return find('admissionSaved', admissionKey);
if (op.phase === 'found' || op.phase === 'settled') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return unavailable();
  if (msg.payload.length === 1) {
    const row = msg.payload[0];
    if (!gcObject(row) || !exact(row)) return conflict();
    if (
      row.phase === 'CONFIRMED' &&
      [row.transactionId, row.bookingId, row.exerciseId].every(gcId) &&
      confirmedEvidence(row)
    )
      return confirmResponse(row);
    if (op.phase === 'found' && row.phase === 'HELD' && held(row)) return readHeld(row);
    return pending();
  }
  if (op.mode !== 'reserve' || op.phase === 'settled')
    return reply(404, { code: 'WHOLE_COURT_ATTEMPT_NOT_FOUND' });
  if (Date.parse(b.startsAt) <= Date.now()) return reply(409, { code: 'WHOLE_COURT_SLOT_EXPIRED' });
  const svc = lk1CourtMasterServices[b.stationId];
  if (!svc || ![svc.masterServiceId, svc.subServiceId].every(gcId))
    return reply(409, { code: 'WHOLE_COURT_SERVICE_UNRESOLVED' });
  const start = gcMoscow(b.startsAt);
  const end = gcMoscow(b.endsAt);
  return http(
    'price',
    'GET',
    '/api/v1/studios/' +
      encodeURIComponent(b.stationId) +
      '/rooms/' +
      encodeURIComponent(b.roomId) +
      '/sub-services/' +
      encodeURIComponent(svc.subServiceId) +
      '/price?fromDate=' +
      start.slice(0, 10) +
      '&fromTime=' +
      encodeURIComponent(start.slice(11, 16)) +
      '&toTime=' +
      encodeURIComponent(end.slice(11, 16)) +
      '&size=100',
    true,
  );
}
if (op.phase === 'price') {
  if (!payloadOk()) return unavailable();
  if (
    msg.payload.total !== b.amountMinor ||
    (msg.payload.currency !== undefined && msg.payload.currency !== 'RUB')
  )
    return reply(409, { code: 'WHOLE_COURT_PRICE_CHANGED' });
  return cas(
    'claimed',
    { _id: key },
    {
      $setOnInsert: {
        ...where,
        binding,
        operationId: b.operationId,
        phase: 'DISPATCHING',
        dispatchedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}
if (op.phase === 'claimed') {
  // Even an ACK explicitly lost after the Mongo insert cannot authorize a POST.
  if (!ack()) return pending();
  if (
    msg.payload.upsertedCount !== 1 ||
    msg.payload.upsertedId !== key ||
    msg.payload.matchedCount !== 0 ||
    msg.payload.modifiedCount !== 0
  )
    return find();
  const svc = lk1CourtMasterServices[b.stationId];
  if (
    op.mode !== 'reserve' ||
    Date.parse(b.startsAt) <= Date.now() ||
    !svc ||
    ![svc.masterServiceId, svc.subServiceId].every(gcId)
  )
    return pending();
  const returnUrl = wholeCourtOrigin + '/games/new?paymentReturn=' + b.operationId;
  const localTime = (value) => gcMoscow(value).slice(0, 19) + '+03:00';
  return http(
    'dispatched',
    'POST',
    userPath + '/products/master-services/' + encodeURIComponent(svc.masterServiceId) + '/pay',
    false,
    {
      subServiceIds: [svc.subServiceId],
      studioId: b.stationId,
      roomId: b.roomId,
      trainers: { type: 'NO_TRAINER' },
      paymentMethod: 'WIDGET',
      baseRedirectUrl: returnUrl,
      successUrl: returnUrl,
      failUrl: returnUrl,
      comment: 'LK2:' + b.operationId,
      marketingAttribution: {},
      timeFrom: localTime(b.startsAt),
      timeTo: localTime(b.endsAt),
    },
  );
}
if (op.phase === 'dispatched') {
  const p = msg.payload;
  if (!urlExact() || ![200, 201, 202].includes(msg.statusCode) || !gcObject(p)) return pending();
  if (
    ![200, 201].includes(msg.statusCode) ||
    !gcId(p.transactionId) ||
    !gcId(p.exerciseId) ||
    !Array.isArray(p.bookingIds) ||
    p.bookingIds.length !== 1 ||
    !gcId(p.bookingIds[0]) ||
    wholeCourtOriginOf(p.paymentUrl) !== wholeCourtCheckoutOrigin
  ) {
    const references = {};
    if (gcId(p.id)) references.providerCorrelationId = p.id;
    if (gcId(p.transactionId)) references.providerTransactionCandidate = p.transactionId;
    if (!Object.keys(references).length) return pending();
    // An opaque async ID is evidence for reconciliation, not authority to declare a transaction.
    return cas(
      'unresolvedSaved',
      { ...where, binding, phase: 'DISPATCHING' },
      {
        $set: { phase: 'UNRESOLVED', ...references },
      },
    );
  }
  return cas(
    'saved',
    { ...where, binding, phase: 'DISPATCHING' },
    {
      $set: {
        phase: 'HELD',
        transactionId: p.transactionId,
        bookingId: p.bookingIds[0],
        exerciseId: p.exerciseId,
        paymentUrl: p.paymentUrl,
      },
    },
  );
}
if (op.phase === 'unresolvedSaved') return pending();
if (op.phase === 'saved') return ack() ? find() : pending();

if (op.phase === 'transaction') {
  if (!payloadOk()) return pending();
  const p = msg.payload;
  const h = op.held;
  if (
    !h ||
    gcAlias(p, ['id', 'transactionId']) !== h.transactionId ||
    (p.client !== undefined && (!gcObject(p.client) || p.client.id !== c.provider_client_id)) ||
    (p.exercise !== undefined && (!gcObject(p.exercise) || p.exercise.id !== h.exerciseId)) ||
    !echoes([p.clientId], c.provider_client_id) ||
    !echoes([p.exerciseId], h.exerciseId) ||
    !echoes([p.bookingId, p.pricingDetails?.clientBookingId], h.bookingId) ||
    !bookingEcho(p.bookingIds, h.bookingId) ||
    !bookingEcho(p.paymentBookingIds, h.bookingId) ||
    (p.products !== undefined &&
      (!Array.isArray(p.products) ||
        p.products.length !== 1 ||
        !gcObject(p.products[0]) ||
        !bookingEcho(p.products[0].bookingIds, h.bookingId))) ||
    !amountMatches(p, h.captured) ||
    refundSignal(p)
  )
    return pending();
  if (p.status !== undefined && !['PAID', 'WAITING', 'UNPAID'].includes(p.status)) return pending();
  op.transaction = {
    status: p.status ?? null,
    expiresAt: wholeCourtZonedDate(p.paymentDueDate),
    cardNew: p.cardPaymentInfo?.status === 'NEW',
    amountDue: p.toPay !== 0,
  };
  return http(
    'transactionStatus',
    'GET',
    '/end-user/api/v2/' +
      wholeCourtTenant +
      '/transactions/' +
      encodeURIComponent(h.transactionId) +
      '/status',
    false,
  );
}
if (op.phase === 'transactionStatus') {
  if (
    !payloadOk() ||
    !echoes([msg.payload.id, msg.payload.transactionId], op.held.transactionId) ||
    refundSignal(msg.payload)
  )
    return pending();
  const h = op.held;
  const checked = op.transaction;
  const status = msg.payload.transactionStatus;
  if (status === 'PAID' && (checked.status === null || checked.status === 'PAID')) {
    op.confirmation = {
      source: 'VIVA_ORIGINAL_TRANSACTION',
      providerStatus: 'PAID',
      transactionId: h.transactionId,
      bookingId: h.bookingId,
      exerciseId: h.exerciseId,
      amountMinor: b.amountMinor,
      currency: 'RUB',
      checkedAt: new Date().toISOString(),
    };
    return cas(
      'receiptClaimed',
      { _id: transactionClaimId() },
      {
        $setOnInsert: {
          kind: wholeCourtKind + '_TRANSACTION',
          tenant_id: c.tenant_id,
          transactionId: h.transactionId,
          binding,
          operationKey: key,
        },
      },
      { upsert: true },
    );
  }
  if (
    op.mode === 'reserve' &&
    checked.status !== 'PAID' &&
    checked.amountDue &&
    (status === 'WAITING' || (status === 'UNPAID' && checked.cardNew)) &&
    checked.expiresAt &&
    Date.parse(checked.expiresAt) > Date.now() &&
    Date.parse(b.startsAt) > Date.now()
  ) {
    return cas(
      'checkoutVerified',
      {
        ...where,
        binding,
        phase: 'HELD',
        transactionId: h.transactionId,
        bookingId: h.bookingId,
        exerciseId: h.exerciseId,
      },
      { $set: { checkoutAmountMinor: b.amountMinor } },
    );
  }
  return pending();
}
if (op.phase === 'checkoutVerified') {
  if (
    !ack() ||
    msg.payload.matchedCount !== 1 ||
    Date.parse(op.transaction.expiresAt) <= Date.now()
  )
    return pending();
  return reply(200, {
    operationId: b.operationId,
    draftId: b.draftId,
    status: 'AWAITING_PAYMENT',
    amountMinor: b.amountMinor,
    currency: 'RUB',
    paymentUrl: op.held.paymentUrl,
    expiresAt: op.transaction.expiresAt,
  });
}
if (op.phase === 'receiptClaimed') return find('receiptOwner', transactionClaimId());
if (op.phase === 'receiptOwner') {
  const owner = Array.isArray(msg.payload) && msg.payload.length === 1 ? msg.payload[0] : null;
  if (
    msg.error ||
    !gcObject(owner) ||
    owner._id !== transactionClaimId() ||
    owner.kind !== wholeCourtKind + '_TRANSACTION' ||
    owner.tenant_id !== c.tenant_id ||
    owner.binding !== binding ||
    owner.operationKey !== key ||
    owner.transactionId !== op.held.transactionId
  )
    return pending();
  const h = op.held;
  const e = op.confirmation;
  return cas(
    'confirmed',
    {
      ...where,
      binding,
      phase: 'HELD',
      transactionId: h.transactionId,
      bookingId: h.bookingId,
      exerciseId: h.exerciseId,
    },
    {
      $set: {
        phase: 'CONFIRMED',
        confirmation: e,
        evidenceSha256: gcHash(
          JSON.stringify([
            binding,
            e.source,
            e.providerStatus,
            e.transactionId,
            e.bookingId,
            e.exerciseId,
            e.amountMinor,
            e.currency,
            e.checkedAt,
          ]),
        ),
      },
      $unset: { paymentUrl: '' },
    },
  );
}
if (op.phase === 'confirmed') return find('settled');
return unavailable();
