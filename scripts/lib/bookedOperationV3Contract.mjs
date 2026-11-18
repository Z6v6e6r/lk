// Source-only v3 booked-operation wire contract for the LK1 producer.
//
// It mirrors the LK2 consumer parser (packages/subscription-runtime-adapter/src/
// booked-operation-v3.ts). Node-RED nodes must validate/build only through this module so both
// sides fail closed on the same keys, amounts and binding fields. No route or provider call is
// created here.

export const BOOKED_OPERATION_V3 = Object.freeze({
  contractVersion: 3,
  preflightPath: '/lk/integrations/v3/booked-operation-preflights',
  admissionPath: '/lk/integrations/v3/booked-operation-admissions',
  readPrefix: '/lk/integrations/v3/booked-operations/',
  cancelPrefix: '/lk/integrations/v3/booked-operations/',
  scopes: Object.freeze({
    preflight: 'subscription-runtime.booked-operation.preflight',
    admit: 'subscription-runtime.booked-operation.admit',
    read: 'subscription-runtime.booked-operation.read',
    cancel: 'subscription-runtime.booked-operation.cancel',
  }),
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const iso = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const exactOptional = (value, required, optional) => {
  if (!object(value)) return false;
  const allowed = new Set([...required.split(','), ...optional.split(',')]);
  return (
    required.split(',').every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const instant = (value) =>
  typeof value === 'string' && iso.test(value) && Number.isFinite(Date.parse(value));
const https = (value) => {
  if (typeof value !== 'string' || !/^https:\/\/\S+$/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};
const bad = () => {
  throw new Error('BOOKED_OPERATION_V3_CONTRACT_INVALID');
};

const parseTarget = (value) => {
  if (
    !exact(value, 'kind,id,expectedRevision') ||
    !['GAME', 'DRAFT_GAME'].includes(value.kind) ||
    !uuid.test(value.id) ||
    !integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER)
  )
    bad();
  return { kind: value.kind, id: value.id, expectedRevision: value.expectedRevision };
};
export const parseBookedOperationV3Target = parseTarget;

export const parseBookedOperationV3PreflightRequest = (value) => {
  if (
    !exact(value, 'contractVersion,action,target,paymentIntent') ||
    value.contractVersion !== 3 ||
    !['JOIN_GAME', 'CREATE_GAME'].includes(value.action) ||
    !['USE_SUBSCRIPTION', 'PAY_FULL_PRICE'].includes(value.paymentIntent)
  )
    bad();
  return {
    contractVersion: 3,
    action: value.action,
    target: parseTarget(value.target),
    paymentIntent: value.paymentIntent,
  };
};

export const parseBookedOperationV3Quote = (value) => {
  if (
    !exact(
      value,
      'quoteId,operationId,basis,durationMinutes,startsAt,endsAt,amountMinor,currency,' +
        'coveredMinutes,surchargeMinor,expiresAt,policyVersion,priceDigest',
    ) ||
    !uuid.test(value.quoteId) ||
    !uuid.test(value.operationId) ||
    !['SUBSCRIPTION', 'OWN_QUARTER', 'WHOLE_COURT'].includes(value.basis) ||
    ![60, 90, 120].includes(value.durationMinutes) ||
    !instant(value.startsAt) ||
    !instant(value.endsAt) ||
    Date.parse(value.endsAt) <= Date.parse(value.startsAt) ||
    !integer(value.amountMinor, 0, Number.MAX_SAFE_INTEGER) ||
    value.currency !== 'RUB' ||
    !integer(value.coveredMinutes, 0, 120) ||
    !integer(value.surchargeMinor, 0, Number.MAX_SAFE_INTEGER) ||
    !instant(value.expiresAt) ||
    !id.test(value.policyVersion) ||
    !digest.test(value.priceDigest)
  )
    bad();
  return { ...value };
};

export const parseBookedOperationV3Settlement = (value) => {
  if (
    !exact(value, 'mode,currency,toPayMinor,checkoutUrl,expiresAt,state') ||
    !['ZERO', 'SURCHARGE'].includes(value.mode) ||
    value.currency !== 'RUB' ||
    !integer(value.toPayMinor, 0, Number.MAX_SAFE_INTEGER) ||
    !['NOT_REQUIRED', 'OPEN', 'PAID', 'CLOSED', 'UNKNOWN'].includes(value.state) ||
    (value.checkoutUrl !== null && !https(value.checkoutUrl)) ||
    (value.expiresAt !== null && !instant(value.expiresAt)) ||
    (value.mode === 'ZERO' && value.toPayMinor !== 0) ||
    (value.mode === 'SURCHARGE' && value.toPayMinor <= 0) ||
    (value.state === 'OPEN' && (value.checkoutUrl === null || value.expiresAt === null))
  )
    bad();
  return { ...value };
};

export const parseBookedOperationV3Receipt = (value) => {
  if (
    !exactOptional(
      value,
      'receiptId,confirmedAt,bookingRef,appliedRule,priceCharged,provider',
      'usageRef',
    )
  )
    bad();
  if (
    !id.test(value.receiptId) ||
    !instant(value.confirmedAt) ||
    !id.test(value.bookingRef) ||
    !id.test(value.appliedRule) ||
    value.provider !== 'VIVA' ||
    !exact(value.priceCharged, 'amountMinor,currency') ||
    !integer(value.priceCharged.amountMinor, 0, Number.MAX_SAFE_INTEGER) ||
    value.priceCharged.currency !== 'RUB' ||
    (value.usageRef !== undefined && !id.test(value.usageRef))
  )
    bad();
  return { ...value };
};

export const parseBookedOperationV3PreflightResult = (value) => {
  if (
    !exact(
      value,
      'contractVersion,nonBinding,operationId,action,target,quote,settlement,requestSha256',
    ) ||
    value.contractVersion !== 3 ||
    value.nonBinding !== true ||
    !uuid.test(value.operationId) ||
    !['JOIN_GAME', 'CREATE_GAME'].includes(value.action) ||
    !digest.test(value.requestSha256)
  )
    bad();
  const target = parseTarget(value.target);
  const quote = value.quote === null ? null : parseBookedOperationV3Quote(value.quote);
  const settlement =
    value.settlement === null ? null : parseBookedOperationV3Settlement(value.settlement);
  if (quote && quote.operationId !== value.operationId) bad();
  if (quote && settlement && quote.surchargeMinor !== settlement.toPayMinor) bad();
  return { ...value, target, quote, settlement };
};

export const parseBookedOperationV3AdmissionRequest = (value) => {
  if (
    !exact(value, 'contractVersion,action,target,paymentIntent,quoteId,settlementConsent') ||
    value.contractVersion !== 3 ||
    !uuid.test(value.quoteId)
  )
    bad();
  const base = parseBookedOperationV3PreflightRequest({
    contractVersion: value.contractVersion,
    action: value.action,
    target: value.target,
    paymentIntent: value.paymentIntent,
  });
  const c = value.settlementConsent;
  if (
    !exact(c, 'quoteId,amountMinor,currency,expiresAt') ||
    !uuid.test(c.quoteId) ||
    c.quoteId !== value.quoteId ||
    c.currency !== 'RUB' ||
    !integer(c.amountMinor, 0, Number.MAX_SAFE_INTEGER) ||
    !instant(c.expiresAt)
  )
    bad();
  return { ...base, quoteId: value.quoteId, settlementConsent: { ...c } };
};

export const parseBookedOperationV3ReadOutcome = (value) => {
  if (
    !exact(
      value,
      'contractVersion,operationId,quoteId,requestSha256,status,asOf,payment,booking,visit,reason,receipt',
    ) ||
    value.contractVersion !== 3 ||
    !uuid.test(value.operationId) ||
    (value.quoteId !== null && !uuid.test(value.quoteId)) ||
    !digest.test(value.requestSha256) ||
    !['PENDING', 'UNKNOWN', 'CONFIRMED', 'CANCELLED'].includes(value.status) ||
    (value.asOf !== null && !instant(value.asOf)) ||
    !exact(value.payment, 'state,toPayMinor,paidMinor,checkoutUrl,expiresAt') ||
    !exactOptional(value.booking, 'state', 'bookingRef') ||
    !exactOptional(value.visit, 'state', 'usageRef') ||
    (value.reason !== null && !id.test(value.reason)) ||
    !['NOT_REQUIRED', 'OPEN', 'PAID', 'CLOSED', 'UNKNOWN'].includes(value.payment.state) ||
    !integer(value.payment.toPayMinor, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.payment.paidMinor, 0, Number.MAX_SAFE_INTEGER) ||
    (value.payment.checkoutUrl !== null && !https(value.payment.checkoutUrl)) ||
    (value.payment.expiresAt !== null && !instant(value.payment.expiresAt)) ||
    !['NONE', 'PENDING', 'CONFIRMED', 'CANCELLED', 'UNKNOWN'].includes(value.booking.state) ||
    (value.booking.bookingRef !== undefined && !id.test(value.booking.bookingRef)) ||
    !['NOT_CONSUMED', 'CONSUMED', 'RETURNED', 'NOT_APPLICABLE', 'UNKNOWN'].includes(
      value.visit.state,
    ) ||
    (value.visit.usageRef !== undefined && !id.test(value.visit.usageRef))
  )
    bad();
  const receipt = value.receipt === null ? null : parseBookedOperationV3Receipt(value.receipt);
  if ((value.status === 'CONFIRMED') !== (receipt !== null)) bad();
  return { ...value, receipt };
};

export const parseBookedOperationV3CancelRequest = (value) => {
  if (
    !exact(value, 'contractVersion,operationId,reason') ||
    value.contractVersion !== 3 ||
    !uuid.test(value.operationId) ||
    value.reason !== 'USER_CANCEL'
  )
    bad();
  return { contractVersion: 3, operationId: value.operationId, reason: 'USER_CANCEL' };
};

export const parseBookedOperationV3CancelResult = (value) => {
  if (
    !exact(value, 'contractVersion,operationId,status,cancelled,limitReleased,visitReturned') ||
    value.contractVersion !== 3 ||
    !uuid.test(value.operationId) ||
    !['CLOSING', 'CLOSED', 'PAID', 'UNKNOWN'].includes(value.status) ||
    typeof value.cancelled !== 'boolean' ||
    typeof value.limitReleased !== 'boolean' ||
    typeof value.visitReturned !== 'boolean'
  )
    bad();
  if (
    value.status === 'CLOSED'
      ? value.cancelled !== true
      : value.cancelled !== false || value.limitReleased !== false || value.visitReturned !== false
  )
    bad();
  return { ...value };
};

export const buildBookedOperationV3PreflightResult = (input) =>
  parseBookedOperationV3PreflightResult({
    contractVersion: 3,
    nonBinding: true,
    operationId: input.operationId,
    action: input.action,
    target: input.target,
    quote: input.quote,
    settlement: input.settlement,
    requestSha256: input.requestSha256,
  });

export const buildBookedOperationV3ReadOutcome = (input) =>
  parseBookedOperationV3ReadOutcome({
    contractVersion: 3,
    operationId: input.operationId,
    quoteId: input.quoteId ?? null,
    requestSha256: input.requestSha256,
    status: input.status,
    asOf: input.asOf ?? null,
    payment: input.payment,
    booking: input.booking,
    visit: input.visit,
    reason: input.reason ?? null,
    receipt: input.receipt ?? null,
  });

export const buildBookedOperationV3CancelResult = (input) =>
  parseBookedOperationV3CancelResult({
    contractVersion: 3,
    operationId: input.operationId,
    status: input.status,
    cancelled: input.status === 'CLOSED',
    limitReleased: input.limitReleased === true,
    visitReturned: input.visitReturned === true,
  });
