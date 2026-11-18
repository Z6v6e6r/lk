// Embedded before every legacy game create/draft/confirm route. This guard only
// denies writes; it grants no identity, payment, roster or read authority.
export function splitPublicationLegacyGuard(msg, env) {
  const fail = (status, code) => {
    delete msg._publicationLegacyGuard;
    delete msg.error;
    msg.statusCode = status;
    msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    msg.payload = { error: status === 409 ? 'Карточка создаётся сервером. Проверьте результат создания игры.'
      : 'Не удалось проверить создание игры. Повторите проверку позже.', code };
    return [null, null, msg];
  };
  if (msg._publicationLegacyGuard) {
    if (msg.error || !Array.isArray(msg.payload)) return fail(503, 'SERVER_PUBLICATION_CHECK_UNAVAILABLE');
    if (msg.payload.length) return fail(409, 'SERVER_PUBLICATION_OWNED');
    msg.payload = msg._publicationLegacyGuard.body;
    delete msg._publicationLegacyGuard;
    return [msg, null, null];
  }
  const tenantKey = env.get('PADLHUB_PLATFORM_TENANT_KEY');
  if (typeof tenantKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey))
    return fail(503, 'SERVER_PUBLICATION_CHECK_UNAVAILABLE');
  const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const body = object(msg.payload), query = object(msg.req?.query), meta = object(body.metadata);
  const payment = object(body.payment), booking = object(body.booking), split = object(meta.splitPayment);
  const header = object(msg.req?.headers);
  const sources = [body, query, meta, payment, booking, split];
  if (sources.some(s => ['id', 'gameId', 'recordId'].some(k => String(s[k] ?? '').trim().startsWith('gsp_'))
    || Object.hasOwn(s, 'serverPublication'))) return fail(409, 'SERVER_PUBLICATION_OWNED');
  const refs = new Set(), exercises = new Set(), bookings = new Set();
  const add = (set, value) => {
    if (typeof value === 'string') for (const item of value.split(/[\s,;]+/)) {
      if (item && item.length <= 200) set.add(item);
    }
    else if (Array.isArray(value)) for (const item of value) add(set, item);
  };
  for (const s of sources) {
    for (const k of ['operationId', 'paymentRef', 'phPaymentRef']) add(refs, s[k]);
    for (const k of ['exerciseId', 'vivaExerciseId']) add(exercises, s[k]);
    for (const k of ['bookingId', 'bookingIds', 'organizerBookingId']) add(bookings, s[k]);
  }
  add(refs, header['idempotency-key'] || header['Idempotency-Key']);
  // The canonical builder can recover locators from an internal confirm lookup.
  const lookup = object(msg._gameConfirmExerciseLookup);
  add(exercises, lookup.exerciseId); add(exercises, lookup.vivaExerciseId); add(bookings, lookup.bookingIds);
  if (refs.size + exercises.size + bookings.size > 128) return fail(503, 'SERVER_PUBLICATION_CHECK_UNAVAILABLE');
  const clauses = [];
  if (refs.size) for (const key of ['operationId', 'createReceipt.paymentRef']) clauses.push({ [key]: { $in: [...refs] } });
  if (exercises.size) clauses.push({ exerciseId: { $in: [...exercises] } });
  if (bookings.size) for (const key of ['bookingId', 'upstreamBookingId']) clauses.push({ [key]: { $in: [...bookings] } });
  if (!clauses.length) return [msg, null, null];
  msg._publicationLegacyGuard = { body: msg.payload };
  msg.payload = [{ tenantKey, 'lk1.publication.version': 1, $or: clauses },
    { limit: 1, projection: { _id: 1 }, readConcern: { level: 'majority' }, maxTimeMS: 2000 }];
  return [null, msg, null];
}

export const PUBLICATION_LEGACY_ROUTES = Object.freeze([
  '/lk/games', '/lk/games/records', '/lk/games/payment/confirm',
  '/lk/games/confirm', '/lk/games/drafts', '/lk/games/draft',
]);
export const PUBLICATION_GUARD_IDS = Object.fromEntries(['guard', 'find', 'catch', 'response']
  .map(k => [k, `lk_split_publication_legacy_${k}_20261118`]));

export function buildPublicationLegacyGuardNodes(tab, clientNode, createId) {
  const i = PUBLICATION_GUARD_IDS;
  return [
    { id: i.guard, type: 'function', z: tab, name: 'Guard legacy game publication',
      func: `return (${splitPublicationLegacyGuard.toString()})(msg, env);`, outputs: 3,
      timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 450, y: 5600,
      wires: [[createId], [i.find], [i.response]] },
    { id: i.find, type: 'mongodb4', z: tab, name: 'Find server publication ownership',
      clientNode, collection: 'lk_subscription_daily_booking_ops', operation: 'find',
      mode: 'collection', output: 'toArray', maxTimeMS: '2000', handleDocId: false,
      x: 750, y: 5640, wires: [[i.guard]] },
    { id: i.catch, type: 'catch', z: tab, name: 'Catch publication ownership read',
      scope: [i.find], uncaught: false, x: 750, y: 5690, wires: [[i.guard]] },
    { id: i.response, type: 'http response', z: tab, name: 'Legacy publication refusal',
      statusCode: '', headers: {}, x: 1050, y: 5600, wires: [] },
  ];
}
