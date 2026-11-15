// Offline proposal only. No database client, network transport, or apply mode.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const fail = code => { throw Error(code); };
const requireFact = (fact, code) => { if (!fact) fail(code); };
const clone = value => JSON.parse(JSON.stringify(value));
export const bookingLinkDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const aliasesAgree = (values, expected) => values.filter(v => v !== undefined && v !== null)
  .every(v => v === expected);
const normalizePhone = value => {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return '7' + digits;
  if (digits.length === 11) return digits[0] === '8' ? '7' + digits.slice(1) : digits;
  return null;
};
const bookingReferences = row => [row.bookingId, row.vivaBookingId,
  ...(Array.isArray(row.bookingIds) ? row.bookingIds : []),
  ...(Array.isArray(row.vivaBookingIds) ? row.vivaBookingIds : [])].filter(v => v != null);
const splitOrganizerBookingIds = split => [split?.organizerBookingId,
  ...(Array.isArray(split?.organizerBookingIds) ? split.organizerBookingIds : [])].filter(v => v != null);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const at = (value, key) => key.split('.').reduce((v, k) => v?.[k], value);
const has = (value, key) => {
  const parts = key.split('.'); const last = parts.pop();
  const parent = parts.length ? at(value, parts.join('.')) : value;
  return record(parent) && own(parent, last);
};
const set = (value, key, next) => {
  const parts = key.split('.'); const last = parts.pop();
  let parent = value;
  for (const part of parts) parent = parent[part];
  parent[last] = next;
};

// Bind every root field, including null presence, and reject newly added fields.
// Mongo _id is intentionally omitted from equality: JSON snapshots lose its BSON type.
const exactGameFilter = game => {
  const filter = {};
  for (const [key, value] of Object.entries(game)) {
    requireFact(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && !['__proto__', 'constructor', 'prototype'].includes(key), 'GAME_KEY_UNSUPPORTED');
    if (key !== '_id') filter[key] = { $eq: value, $exists: true };
  }
  filter.$expr = { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, Object.keys(game).length] };
  return filter;
};

/** Requires fresh, private, complete read receipts; never authorizes execution. */
export function prepareExistingBookingLink(evidence, now = new Date().toISOString()) {
  requireFact(record(evidence), 'EVIDENCE_REQUIRED');
  const { expected: e, game, operation: op, booking: b, subscription: sub, guard, reads } = evidence;
  const time = instant(now), observed = instant(evidence.observedAt);
  requireFact(Number.isFinite(time) && Number.isFinite(observed) && observed <= time && time - observed <= 60_000,
    'EVIDENCE_STALE');
  requireFact(record(e) && ['tenantKey', 'gameId', 'actorClientId', 'bookingId', 'exerciseId',
    'clientSubscriptionId', 'operationId'].every(key => text(e[key])), 'EXPECTED_IDENTITY_REQUIRED');
  requireFact(reads?.gameComplete === true && reads.gameMatches === 1
    && reads.bookingStatus === 200 && reads.subscriptionStatus === 200
    && reads.subscriptionsComplete === true && Number.isFinite(instant(reads.startedAt))
    && instant(reads.startedAt) <= observed && observed - instant(reads.startedAt) <= 60_000
    && reads.operationsComplete === true && reads.operationMatches === 1 && reads.guardMatches === 1,
  'READ_RECEIPTS_INCOMPLETE');
  requireFact(record(game) && game.id === e.gameId && game.status === 'PAID'
    && game.archived !== true && !own(game, 'membershipMutation') && text(game.updatedAt), 'GAME_NOT_STABLE');
  requireFact(!own(game, 'revision') || Number.isSafeInteger(game.revision)
    && game.revision >= 0 && game.revision < Number.MAX_SAFE_INTEGER, 'GAME_REVISION_INVALID');
  requireFact(record(op) && op.state === 'CONFIRMED' && op.operationId === e.operationId
    && op.tenantKey === e.tenantKey && op.actorClientId === e.actorClientId
    && op.clientSubscriptionId === e.clientSubscriptionId && op.exerciseId === e.exerciseId
    && op.bookingId === e.bookingId && aliasesAgree([op.upstreamBookingId], e.bookingId)
    && text(op._id) && Number.isFinite(instant(op.confirmedAt))
    && instant(op.createdAt) <= instant(op.confirmedAt) && instant(op.confirmedAt) <= observed,
  'OPERATION_NOT_CONFIRMED');
  const d = op.lk1?.decision, target = op.lk1?.target;
  requireFact(d?.eligible === true && d.subscriptionVisitCount === 1
    && d.benefit?.finalPriceMinor === 0 && d.gameMinutes?.paidOverageMinutes === 0
    && Number.isSafeInteger(target?.durationMinutes) && target.durationMinutes > 0
    && d.gameMinutes.freeMinutes === target.durationMinutes
    && target.category === 'GAME' && target.eventId === e.exerciseId
    && Number.isFinite(instant(target.startsAt)) && day(target.startsAt) === op.serviceDate
    && d.gameMinutes.localDate === op.serviceDate
    && !op.lk1.freeCancellationReturn && !op.lk1.seatRelease, 'ZERO_COST_RECEIPT_INVALID');
  requireFact(record(b) && b.id === e.bookingId && b.client?.id === e.actorClientId
    && b.exerciseId === e.exerciseId && b.clientSubscriptionId === e.clientSubscriptionId
    && b.paymentType === 'SUBSCRIPTION' && b.isCancelled === false && b.cancelled === false
    && instant(b.exerciseDate) === instant(target.startsAt)
    && instant(b.exerciseDateTo) === instant(target.startsAt) + target.durationMinutes * 60_000,
  'PROVIDER_BOOKING_MISMATCH');
  requireFact(record(sub) && sub.subscriptionId === e.clientSubscriptionId && sub.status === 'ACTIVE'
    && text(sub.product?.id) && text(op.lk1.rule?.productId)
    && sub.product.id === op.lk1.rule.productId && sub.expirationDate >= op.serviceDate
    && Number.isSafeInteger(sub.visitsLeft) && sub.visitsLeft >= 0
    && Number.isSafeInteger(sub.visitsTotal) && sub.visitsLeft <= sub.visitsTotal
    && Array.isArray(sub.bookings), 'SUBSCRIPTION_MISMATCH');
  const consumed = sub.bookings.filter(row => row.id === e.bookingId);
  requireFact(consumed.length === 1 && consumed[0].client?.id === e.actorClientId
    && consumed[0].exerciseId === e.exerciseId
    && consumed[0].clientSubscriptionId === e.clientSubscriptionId
    && consumed[0].paymentType === 'SUBSCRIPTION'
    && consumed[0].isCancelled === false && consumed[0].cancelled === false, 'CONSUMPTION_NOT_PROVEN');
  requireFact(record(guard) && guard.kind === 'LK1_DAILY_VISIT_V1'
    && guard._id === `lk1-daily-visit:${JSON.stringify([e.tenantKey, e.clientSubscriptionId, op.serviceDate])}`
    && guard.tenantKey === e.tenantKey && guard.clientSubscriptionId === e.clientSubscriptionId
    && guard.serviceDate === op.serviceDate && guard.ownerOperationKey === op._id
    && guard.ownerOperationId === op.operationId, 'GUARD_OWNER_MISMATCH');
  requireFact(record(game.booking) && game.booking.date === op.serviceDate
    && aliasesAgree([game.booking.exerciseId, game.booking.vivaExerciseId], e.exerciseId)
    && [game.booking.exerciseId, game.booking.vivaExerciseId].includes(e.exerciseId)
    && instant(game.booking.timeFromIso) === instant(target.startsAt)
    && instant(game.booking.timeToIso) === instant(b.exerciseDateTo)
    && game.booking.roomId === target.roomId && b.room?.id === target.roomId
    && game.booking.studioId === target.stationId && b.studio?.id === target.stationId,
  'GAME_BOOKING_MISMATCH');
  requireFact(![game.organizer?.id, game.organizer?.clientId].includes(e.actorClientId), 'ACTOR_IS_ORGANIZER');
  requireFact(!bookingReferences(game.booking).includes(e.bookingId)
    && splitOrganizerBookingIds(game.metadata?.splitPayment).every(id => id !== e.bookingId),
  'BOOKING_IN_ORGANIZER_REFERENCES');
  requireFact(Array.isArray(game.participants) && Array.isArray(game.waitlist), 'ROSTER_INCOMPLETE');
  const actorPhone = normalizePhone(b.client?.phone);
  const identifiesActor = row => {
    requireFact(record(row), 'IDENTITY_ROW_INVALID');
    const ids = [row.clientId, row.playerId, row.userId, row.client?.id, row.id]
      .filter(value => value != null && value !== '');
    const phones = [row.phoneNorm, row.phone, row.mobile, row.clientPhoneNorm, row.clientPhone]
      .filter(value => value != null && value !== '').map(normalizePhone);
    requireFact(ids.every(text) && phones.every(Boolean), 'IDENTITY_ALIASES_INVALID');
    const related = ids.includes(e.actorClientId) || actorPhone && phones.includes(actorPhone);
    if (related) requireFact(ids.every(id => id === e.actorClientId)
      && phones.every(phone => actorPhone && phone === actorPhone), 'IDENTITY_ALIAS_CONFLICT');
    else requireFact(ids.length || phones.length === 0 || actorPhone, 'PHONE_IDENTITY_UNRESOLVED');
    return Boolean(related);
  };
  const matches = game.participants.filter(identifiesActor);
  requireFact(matches.length === 1 && matches[0].status === 'CONFIRMED'
    && aliasesAgree([matches[0].id, matches[0].clientId], e.actorClientId)
    && !game.waitlist.some(identifiesActor), 'PARTICIPANT_NOT_UNIQUE');
  requireFact(!bookingReferences(game.organizer || {}).includes(e.bookingId)
    && game.participants.every(row => row === matches[0] || !bookingReferences(row).includes(e.bookingId))
    && game.waitlist.every(row => !bookingReferences(row).includes(e.bookingId)), 'ROSTER_BOOKING_CONFLICT');
  requireFact(bookingReferences(matches[0]).every(id => id === e.bookingId)
    && ['bookingIds', 'vivaBookingIds'].every(key => !own(matches[0], key) || Array.isArray(matches[0][key])),
  'PARTICIPANT_BOOKING_CONFLICT');
  requireFact(reads.linkedGames?.complete === true && reads.linkedGames.bookingId === e.bookingId
    && Array.isArray(reads.linkedGames.gameIds)
    && reads.linkedGames.gameIds.every(id => id === e.gameId), 'OTHER_GAME_BINDING_UNRESOLVED');
  const split = game.metadata?.splitPayment;
  requireFact(record(split) && split.enabled === true && split.status === 'ACTIVE'
    && Array.isArray(split.payments), 'SPLIT_METADATA_INVALID');
  requireFact(split.payments.every(row => record(row)
    && ['bookingIds', 'vivaBookingIds'].every(key => !own(row, key) || Array.isArray(row[key]))),
  'PAYMENT_REFERENCES_INVALID');
  const related = split.payments.filter(row => identifiesActor(row) || bookingReferences(row).includes(e.bookingId));
  requireFact(related.length <= 1 && related.every(row => row.role === 'PARTICIPANT'
    && row.clientId === e.actorClientId && row.bookingId === e.bookingId
    && bookingReferences(row).every(id => id === e.bookingId)
    && ['bookingIds', 'vivaBookingIds'].every(key => !own(row, key) || Array.isArray(row[key]))
    && row.status === 'PAID' && row.amount === 0 && row.amountMinor === 0
    && !row.transactionId && !row.paymentUrl), 'PAYMENT_BINDING_CONFLICT');
  const arrays = [game.metadata.bookingIds, split.bookingIds];
  requireFact(arrays.every(ids => ids === undefined || Array.isArray(ids)
    && ids.every(text) && new Set(ids).size === ids.length), 'BOOKING_REFERENCES_INVALID');
  if (related.length === 1 && arrays.every(ids => ids?.includes(e.bookingId))) {
    return { status: 'ALREADY_LINKED', command: null, providerWrites: 0 };
  }
  const payment = { role: 'PARTICIPANT', status: 'PAID', clientId: e.actorClientId,
    bookingId: e.bookingId, amount: 0, amountMinor: 0,
    createdAt: op.createdAt, paidAt: op.confirmedAt };
  requireFact(Number.isFinite(instant(payment.createdAt)), 'OPERATION_TIME_INVALID');
  const changes = {
    'metadata.bookingIds': [...new Set([...(arrays[0] || []), e.bookingId])],
    'metadata.splitPayment.bookingIds': [...new Set([...(arrays[1] || []), e.bookingId])],
    'metadata.splitPayment.payments': related.length ? split.payments : [...split.payments, payment],
    updatedAt: now,
    ...(own(game, 'revision') ? { revision: game.revision + 1 } : {}),
  };
  const postimage = clone(game), restore = {}, unset = {};
  for (const [key, value] of Object.entries(changes)) {
    if (has(game, key)) restore[key] = at(game, key);
    else unset[key] = '';
    set(postimage, key, clone(value));
  }
  requireFact(isDeepStrictEqual(game.organizer, postimage.organizer)
    && isDeepStrictEqual(game.participants, postimage.participants)
    && isDeepStrictEqual(game.booking, postimage.booking), 'PROTECTED_GAME_FIELDS_CHANGED');
  const options = { upsert: false, writeConcern: { w: 'majority', j: true } };
  return { schemaVersion: 1, status: 'PREPARED_REVIEW_ONLY', createdAt: now,
    expiresAt: new Date(time + 60_000).toISOString(), expected: e,
    preimageSha256: bookingLinkDigest(game), postimageSha256: bookingLinkDigest(postimage),
    proof: { operationSha256: bookingLinkDigest(op), bookingSha256: bookingLinkDigest(b),
      subscriptionSha256: bookingLinkDigest(sub), guardSha256: bookingLinkDigest(guard),
      visitsLeft: sub.visitsLeft, visitsTotal: sub.visitsTotal },
    command: { collection: 'lk_games', filter: exactGameFilter(game), update: { $set: changes }, options },
    rollback: { collection: 'lk_games', filter: exactGameFilter(postimage),
      update: { $set: restore, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, options },
    providerWrites: 0, operationWrites: 0, guardWrites: 0,
  };
}

export function main(args) {
  requireFact(args.length === 4 && args[0] === '--input' && args[2] === '--output', 'USAGE_INPUT_OUTPUT_ONLY');
  const repo = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const input = fs.realpathSync(args[1]);
  const parent = fs.realpathSync(path.dirname(path.resolve(args[3])));
  const outside = name => name !== repo && !name.startsWith(repo + path.sep);
  const inCheckout = name => {
    let dir = name;
    while (true) {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
      const next = path.dirname(dir);
      if (next === dir) return false;
      dir = next;
    }
  };
  requireFact(outside(input) && outside(parent) && !inCheckout(path.dirname(input))
    && !inCheckout(parent) && (fs.statSync(parent).mode & 0o077) === 0,
    'PRIVATE_EXTERNAL_PATHS_REQUIRED');
  const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
  const result = prepareExistingBookingLink(evidence);
  const target = path.join(parent, path.basename(args[3]));
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, providerWrites: 0, databaseWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
