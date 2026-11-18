import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';

const source = fs.readFileSync(new URL('../nodered_game_publication_nodes/contract.js', import.meta.url), 'utf8');
export const normalizePublicationIntent = new Function(source + '\nreturn splitPublicationIntent;')();
export const normalizeBookingContract = new Function(source + '\nreturn splitPublicationBookingContract;')();
const gameIdFor = new Function('Buffer', source + '\nreturn splitPublicationGameId;')(Buffer);
const renderSource = fs.readFileSync(new URL('../nodered_games_nodes/fn_create.js', import.meta.url), 'utf8');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !Array.from(value).some(char => char.charCodeAt(0) <= 32 || /\s/.test(char));
export class PublicationError extends Error { constructor(code) { super(code); this.code = code; } }
const stop = code => { throw new PublicationError(code); };

export function publicationPlan(operation) {
  const o = operation, p = o?.lk1?.publication, q = o?.lk1;
  if (!p) return null; // Never backfill old operations or infer settings from a booking.
  if (p.version !== 1 || !['PENDING', 'PUBLISHED'].includes(p.state) || o.state !== 'CONFIRMED'
    || q.target?.category !== 'GAME' || o.category !== 'open_game'
    || q.decision?.benefit?.finalPriceMinor !== 0 || q.decision?.subscriptionVisitCount !== 1
    || q.checkout || q.transactionAttemptedAt || q.transactionId || !o.confirmedAt
    || ![o._id, o.tenantKey, o.operationId, o.actorClientId, o.clientSubscriptionId, o.bookingId, o.exerciseId].every(id)
    || o.exerciseId.startsWith('preflight:') || o.exerciseId.startsWith('split-create:')
    || o.upstreamBookingId !== o.bookingId || q.target.eventId !== o.exerciseId
    || p.actorClientId !== o.actorClientId || p.tenantKey !== o.tenantKey || p.operationId !== o.operationId
    || !/^\d{10,15}$/.test(p.actorPhone || '') || p.createPayloadJson !== JSON.stringify(q.createPayload)) stop('PUBLICATION_BINDING_INVALID');
  const intent = normalizePublicationIntent(p.intent);
  if (!intent || JSON.stringify(intent) !== p.intentJson) stop('PUBLICATION_INTENT_INVALID');
  const bookingContract = normalizeBookingContract(p.bookingContract);
  if (!bookingContract || JSON.stringify(bookingContract) !== p.bookingContractJson) stop('PUBLICATION_BOOKING_CONTRACT_INVALID');
  const c = q.createPayload, start = Date.parse(c?.timeFrom), end = Date.parse(c?.timeTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || c.roomId !== q.target.roomId
    || q.target.stationId == null || ![2, 4].includes(c.maxClientsCount)
    || end - start !== q.target.durationMinutes * 60000 || Date.parse(q.target.startsAt) !== start
    || !Number.isFinite(Date.parse(o.confirmedAt))) stop('PUBLICATION_TARGET_INVALID');
  const gameId = gameIdFor(o.tenantKey, o.exerciseId);
  const binding = { version: 1, operationId: o.operationId, actorClientId: o.actorClientId,
    tenantKey: o.tenantKey, exerciseId: o.exerciseId, bookingId: o.bookingId, intentDigest: digest(intent) };
  binding.bookingContractDigest = digest(bookingContract);
  // Alphabetic nibble encoding survives the existing phone-shaped string redactor.
  const bindingDigest = digest(binding).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
  return { gameId, intent, binding, bookingContract, marker: { version: 1, bindingDigest }, operation: o };
}

export function renderPublication(plan) {
  const { operation: o, intent: i, bookingContract: bc, marker, gameId } = plan, q = o.lk1, c = q.createPayload;
  const organizer = { id: o.actorClientId, phone: q.publication.actorPhone, name: 'Организатор', source: 'ORGANIZER', status: 'CONFIRMED' };
  const date = c.timeFrom.slice(0, 10), from = c.timeFrom.slice(11, 16), to = c.timeTo.slice(11, 16);
  const body = { id: gameId, tenantKey: o.tenantKey, paymentRef: o.operationId, status: 'PAID', organizer,
    booking: { studioId: q.target.stationId, studioName: i.studioName, roomId: c.roomId, roomName: i.roomName,
      masterServiceId: bc.masterServiceId, subServiceIds: bc.subServiceIds,
      date, timeFrom: from, timeTo: to, timeFromIso: c.timeFrom, timeToIso: c.timeTo,
      durationMinutes: q.target.durationMinutes, bookingIds: [o.bookingId], exerciseId: o.exerciseId, vivaExerciseId: o.exerciseId },
    payment: { paid: true, amount: 0, paidAt: o.confirmedAt, paymentRef: o.operationId, bookingIds: [o.bookingId] },
    settings: { ...i.settings, payMode: 'split' }, invite: { maxPlayers: c.maxClientsCount, waitlistEnabled: true },
    participants: [organizer], waitlist: [], metadata: { source: 'games_split_widget', sourceMode: 'create',
      paymentRef: o.operationId, gameFormat: i.gameFormat, gameTitle: i.gameTitle, participantComment: i.participantComment,
      joinPrice: i.joinPrice, serverPublication: marker, exerciseId: o.exerciseId, vivaExerciseId: o.exerciseId,
      splitPayment: { enabled: true, mode: 'group_booking', status: 'ACTIVE', shareCount: c.maxClientsCount,
        shareAmountMinor: bc.shareAmountMinor, shareAmount: bc.shareAmountMinor === null ? null : bc.shareAmountMinor / 100,
        totalAmount: bc.totalAmount, oneTimeBaseAmount: bc.oneTimeBaseAmount, pricingPolicy: bc.pricingPolicy,
        deadlineAt: bc.deadlineAt, assembleDeadlineAt: bc.assembleDeadlineAt,
        vivaExerciseId: o.exerciseId, organizerBookingId: o.bookingId, selectedPaymentMode: 'subscription',
        clientSubscriptionId: o.clientSubscriptionId, payments: [{ role: 'ORGANIZER', status: 'PAID',
          clientId: o.actorClientId, phone: q.publication.actorPhone, bookingId: o.bookingId, paymentRef: o.operationId,
          amount: 0, amountMinor: 0, paidAt: o.confirmedAt }] } } };
  const msg = { payload: body, req: { method: 'POST', url: '/lk/games', originalUrl: '/lk/games', headers: {} },
    _gamePaymentVerified: { verified: true, source: 'subscription_operation_readback',
      paymentRef: o.operationId, bookingId: o.bookingId, exerciseId: o.exerciseId } };
  // Reuse the canonical roster/record builder. It is pure: only its DB message is consumed;
  // its parallel HTTP/autojoin messages are deliberately never executed by this worker.
  const context = vm.createContext({ msg, node: { warn() {}, error() {} }, global: { get() {} },
    env: { get(key) { return key === 'PADLHUB_PLATFORM_TENANT_KEY' ? o.tenantKey : undefined; } }, Buffer });
  const result = new vm.Script('(function(){\n' + renderSource + '\n})()').runInContext(context, { timeout: 1000 });
  const record = result?.[0]?.payload?.$set;
  if (!record || record.id !== gameId || record.tenantKey !== o.tenantKey || record.status !== 'PAID'
    || record.booking?.exerciseId !== o.exerciseId || !record.resultRosterSnapshot) stop('PUBLICATION_RENDER_FAILED');
  // Dotted audit keys in the update are not document fields.
  const doc = structuredClone(record);
  for (const k of Object.keys(doc)) if (k.includes('.') || k.startsWith('$')) delete doc[k];
  return { ...doc, revision: 1, createdAt: o.confirmedAt };
}

function matchesGame(game, plan) {
  return game?.id === plan.gameId && game.tenantKey === plan.binding.tenantKey
    && game.organizer?.id === plan.binding.actorClientId && game.booking?.exerciseId === plan.binding.exerciseId
    && game.booking?.bookingIds?.length === 1 && game.booking.bookingIds[0] === plan.binding.bookingId
    && JSON.stringify(game.metadata?.serverPublication) === JSON.stringify(plan.marker);
}
function matchesInitialProjection(game, expected) {
  const project = record => {
    const snapshot = structuredClone(record.resultRosterSnapshot);
    if (snapshot) { delete snapshot.capturedAt; delete snapshot.capturedAtTs; }
    return { status: record.status, organizer: record.organizer, booking: record.booking, payment: record.payment,
      settings: record.settings, invite: record.invite, participants: record.participants, waitlist: record.waitlist,
      participantPhones: record.participantPhones, waitlistPhones: record.waitlistPhones,
      invitedPhones: record.invitedPhones, allRelatedPhones: record.allRelatedPhones,
      metadata: record.metadata, resultRosterSnapshot: snapshot };
  };
  return isDeepStrictEqual(project(game), project(expected));
}

export async function publishConfirmedOperation({ operations, games, operation, apply = false, session }) {
  const plan = publicationPlan(operation);
  if (!plan) return { state: 'IGNORED' };
  if (!apply) return { state: 'DRY_RUN' };
  const key = { _id: operation._id, operationId: operation.operationId, tenantKey: operation.tenantKey,
    actorClientId: operation.actorClientId, state: 'CONFIRMED', bookingId: operation.bookingId,
    exerciseId: operation.exerciseId, 'lk1.publication.intentJson': operation.lk1.publication.intentJson };
  const opts = session ? { session } : {};
  const current = await operations.findOne(key, opts);
  if (!current || JSON.stringify(publicationPlan(current)?.binding) !== JSON.stringify(plan.binding)) stop('PUBLICATION_OPERATION_CHANGED');
  if (current.lk1.publication.state === 'PUBLISHED') {
    const existing = await games.findOne({ tenantKey: operation.tenantKey, id: plan.gameId }, opts);
    if (!matchesGame(existing, plan) || current.lk1.publication.gameId !== plan.gameId) stop('PUBLICATION_RECEIPT_CONFLICT');
    return { state: 'PUBLISHED', gameId: plan.gameId }; // Preserve receipt and legitimate later edits.
  }
  const expected = renderPublication(plan);
  const linked = await games.find({ tenantKey: operation.tenantKey, $or: [
    { id: plan.gameId }, { dedupeKey: 'viva:' + operation.exerciseId },
    { 'booking.exerciseId': operation.exerciseId }, { 'booking.bookingIds': operation.bookingId },
  ] }, opts).limit(3).toArray();
  if (linked.length > 1 || (linked.length === 1 && (!matchesGame(linked[0], plan)
    || !matchesInitialProjection(linked[0], expected)))) stop('PUBLICATION_EXISTING_GAME_CONFLICT');
  if (!linked.length) {
    try { await games.updateOne({ tenantKey: operation.tenantKey, id: plan.gameId },
      { $setOnInsert: expected }, { upsert: true, ...opts, ...(!session ? { writeConcern: { w: 'majority', j: true } } : {}) }); }
    catch (error) {
      // Both duplicate-key races and lost acknowledgements require exact readback.
      // Never repeat the provider write or overwrite the existing game.
      if (session) throw error; // withTransaction owns rollback/retry, never continue an aborted transaction.
    }
  }
  const game = await games.findOne({ tenantKey: operation.tenantKey, id: plan.gameId }, opts);
  if (!matchesGame(game, plan) || !matchesInitialProjection(game, expected)) stop('PUBLICATION_READBACK_FAILED');
  const ack = await operations.updateOne(key, { $set: { 'lk1.publication.state': 'PUBLISHED',
    'lk1.publication.gameId': plan.gameId, 'lk1.publication.publishedAt': new Date().toISOString() } },
  { ...opts, ...(!session ? { writeConcern: { w: 'majority', j: true } } : {}) });
  const done = await operations.findOne(key, opts);
  if (ack?.acknowledged !== true || ack.matchedCount !== 1 || done?.lk1?.publication?.state !== 'PUBLISHED'
    || done.lk1.publication.gameId !== plan.gameId) stop('PUBLICATION_ACK_UNKNOWN');
  return { state: 'PUBLISHED', gameId: plan.gameId };
}
