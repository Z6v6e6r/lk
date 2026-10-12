import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BSON } from 'mongodb';

export const hashDocument = (doc) => crypto.createHash('sha256').update(BSON.serialize(doc)).digest('hex');
const same = (left, right) => hashDocument({ value: left }) === hashDocument({ value: right });
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const rows = (value) => Array.isArray(value) ? value : [];
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const exact = (value) => ({ $eq: value, ...(value === null ? { $exists: true } : {}) });

function bookingIsActive(booking) {
  const evidence = []; let decisive = false;
  if (booking.active != null) {
    requireCondition(typeof booking.active === 'boolean', 'Invalid provider active flag');
    evidence.push(booking.active); decisive = true;
  }
  for (const key of ['isCancelled', 'cancelled', 'canceled']) {
    if (booking[key] == null) continue;
    requireCondition(typeof booking[key] === 'boolean', 'Invalid provider cancellation flag');
    evidence.push(!booking[key]); if (booking[key]) decisive = true;
  }
  if (booking.cancellationDate !== undefined) {
    requireCondition(booking.cancellationDate === null || typeof booking.cancellationDate === 'string' && booking.cancellationDate.trim(), 'Invalid provider cancellation date');
    evidence.push(booking.cancellationDate === null); decisive = true;
  }
  const states = [booking.status, booking.state].filter((value) => value != null && value !== '').map((value) => String(value).trim().toUpperCase());
  requireCondition(new Set(states).size <= 1, 'Conflicting provider state aliases');
  if (states.length) {
    const state = states[0];
    requireCondition(['ACTIVE', 'BOOKED', 'CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'CANCELLED', 'CANCELED', 'DELETED', 'REMOVED'].includes(state), 'Unknown provider lifecycle state');
    evidence.push(!['CANCELLED', 'CANCELED', 'DELETED', 'REMOVED'].includes(state)); decisive = true;
  }
  requireCondition(decisive && new Set(evidence).size === 1, 'Conflicting or incomplete provider lifecycle evidence');
  return evidence[0];
}

function verifyVivaRoster(vivaRoster, membership, scope) {
  requireCondition(vivaRoster?.complete === true && Array.isArray(vivaRoster.bookings)
    && vivaRoster.exerciseId === membership.exerciseId
    && Number.isFinite(Date.parse(vivaRoster.readAt))
    && Math.abs(Date.now() - Date.parse(vivaRoster.readAt)) <= 60_000, 'Provider roster must be fresh, complete and scoped');
  const bookings = vivaRoster.bookings;
  const target = bookings.filter((booking) => booking.id === scope.bookingId);
  requireCondition(target.length === 1, 'Provider booking identity is not unique');
  const booking = target[0];
  requireCondition(bookingIsActive(booking) === true && booking.client?.id === scope.technicalClientId
    && (!booking.exercise?.id || booking.exercise.id === membership.exerciseId)
    && (!booking.exerciseId || booking.exerciseId === membership.exerciseId)
    && (booking.paymentType == null || booking.paymentType === 'ON_PLACE'), 'Exact active provider booking mismatch');
  const activeTechnical = bookings.filter((row) => row.client?.id === scope.technicalClientId
    && bookingIsActive(row) === true);
  requireCondition(activeTechnical.length === 1, 'Technical client has another active booking; cannot identify legacy row');
  return booking;
}

export function planPartnerDuplicateRepair({ game, membership, operation, vivaRoster, scope }) {
  requireCondition(game && membership && operation, 'Missing exact game, membership or operation');
  requireCondition(game.id === scope.gameId && game._id != null && own(game, 'tenantKey') && same(game._id, membership.gameDocumentId)
    && game.tenantKey === membership.tenantKey && membership.gameId === scope.gameId, 'Game/tenant/document binding mismatch');
  requireCondition(membership._id === scope.membershipId && membership.membershipId === scope.membershipId
    && membership.state === 'ACTIVE' && membership.bookingId === scope.bookingId
    && membership.technicalVivaClientId === scope.technicalClientId, 'Active membership booking mismatch');
  requireCondition(operation._id === scope.operationId && membership.operationId === scope.operationId
    && operation.state === 'COMPLETED' && operation.action === 'ADD_MEMBER'
    && operation.membershipId === scope.membershipId && operation.gameId === scope.gameId
    && operation.clientId === membership.clientId && operation.tenantKey === membership.tenantKey, 'Completed operation mismatch');
  requireCondition(game.archived !== true && game.status === 'PAID', 'Game is no longer active/paid');
  requireCondition(!game.resultId && !game.lastResultAt
    && (!game.resultStatus || game.resultStatus === 'NO_RESULT')
    && !game.metadata?.matchResult, 'Game result requires a separate correction');
  verifyVivaRoster(vivaRoster, membership, scope);
  const named = rows(game.participants).filter((p) => p.id === `partner:${scope.membershipId}`
    && p.membershipId === scope.membershipId && p.source === 'PARTNER_API' && p.status === 'CONFIRMED');
  const technical = rows(game.participants).filter((p) => p.id === scope.technicalClientId);
  requireCondition(named.length === 1 && technical.length === 1, 'Expected one named member and one technical duplicate');
  requireCondition(game.organizer?.id !== scope.technicalClientId && technical[0].source === 'ADMIN'
    && technical[0].status === 'CONFIRMED' && !technical[0].membershipId
    && (!technical[0].vivaBookingId || technical[0].vivaBookingId === scope.bookingId), 'Technical row is not a removable legacy duplicate');
  requireCondition(!named[0].vivaBookingId || named[0].vivaBookingId === scope.bookingId, 'Named booking conflicts');
  requireCondition(named[0].membershipGeneration == null || named[0].membershipGeneration === membership.generation,
    'Named generation conflicts');
  const payments = rows(game.payments).filter((p) => p.membershipId === scope.membershipId);
  requireCondition(payments.length === 1 && payments[0].playerId === named[0].id
    && payments[0].bookingId === scope.bookingId && payments[0].status === 'PAID'
    && payments[0].settlementSource === 'EXTERNAL_PARTNER' && payments[0].membershipGeneration === membership.generation,
    'Exact external payment binding mismatch');
  requireCondition(!own(game, 'revision') || Number.isSafeInteger(game.revision) && game.revision >= 0,
    'Invalid game revision');
  const nextParticipants = game.participants.filter((p) => p !== technical[0]).map((p) => p === named[0]
    ? { ...p, vivaBookingId: scope.bookingId, membershipGeneration: membership.generation } : p);
  return { nextParticipants, removedCount: 1, beforeCount: game.participants.length, afterCount: nextParticipants.length,
    preimageHash: hashDocument({ game, membership, operation }), nextRevision: (game.revision ?? 0) + 1 };
}

export function verifyPartnerDuplicateRepair({ before, after, membershipBefore, membershipAfter, operationBefore, operationAfter, plan }) {
  requireCondition(same(after.participants, plan.nextParticipants), 'Postcheck roster differs from the planned survivors');
  requireCondition(after.revision === plan.nextRevision && after.updatedAt !== before.updatedAt, 'Version fence did not change');
  const omit = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !['participants', 'revision', 'updatedAt'].includes(key)));
  requireCondition(same(omit(before), omit(after)), 'Non-roster game fields changed');
  requireCondition(same(membershipBefore, membershipAfter) && same(operationBefore, operationAfter), 'Partner state changed');
  return true;
}

export async function repairPartnerDuplicate({ db, client, readVivaRoster, scope, apply = false, expectedPreimageHash, backupDirectory, verifyQuiescence }) {
  const games = db.collection('lk_games');
  const members = db.collection('lk_partner_game_memberships');
  const operations = db.collection('lk_partner_game_operations');
  const read = async (session) => {
    let gameRows; let membership; let operation;
    if (session) {
      gameRows = await games.find({ id: scope.gameId }, { session }).limit(2).toArray();
      membership = await members.findOne({ _id: scope.membershipId }, { session });
      operation = await operations.findOne({ _id: scope.operationId }, { session });
    } else {
      [gameRows, membership, operation] = await Promise.all([
        games.find({ id: scope.gameId }).limit(2).toArray(),
        members.findOne({ _id: scope.membershipId }),
        operations.findOne({ _id: scope.operationId }),
      ]);
    }
    requireCondition(gameRows.length === 1, 'Game identity is not unique');
    return { game: gameRows[0], membership, operation };
  };
  if (apply) requireCondition(typeof verifyQuiescence === "function" && await verifyQuiescence() === true, "Partner mutations must be drained/stopped for this correction");
  const before = await read();
  const vivaRoster = await readVivaRoster(before.membership);
  const plan = planPartnerDuplicateRepair({ ...before, vivaRoster, scope });
  const receipt = { mode: apply ? 'apply' : 'dry-run', preimageHash: plan.preimageHash,
    removedCount: plan.removedCount, beforeCount: plan.beforeCount, afterCount: plan.afterCount,
    preserved: ['Viva booking', 'Partner membership', 'operation', 'payments', 'result snapshots', 'other game fields'] };
  if (!apply) return receipt;
  requireCondition(expectedPreimageHash === plan.preimageHash, 'Approved dry-run preimage changed');
  requireCondition(backupDirectory && path.isAbsolute(backupDirectory) && !fs.existsSync(backupDirectory), 'A new private backup directory is required');
  const parent = path.dirname(backupDirectory);
  requireCondition(fs.realpathSync(parent) === parent && !fs.lstatSync(parent).isSymbolicLink(), 'Backup parent must be canonical');
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  const backupFd = fs.openSync(path.join(backupDirectory, 'preimage.bson'), 'wx', 0o600);
  try { fs.writeFileSync(backupFd, BSON.serialize(before)); fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
  const directoryFd = fs.openSync(backupDirectory, 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  const parentFd = fs.openSync(parent, 'r');
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  requireCondition(await verifyQuiescence() === true, 'Partner mutation boundary changed');
  const session = client.startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    const current = await read(session);
    requireCondition(hashDocument(current) === plan.preimageHash, 'Preimage changed before transaction');
    const query = { _id: before.game._id, id: scope.gameId, tenantKey: exact(before.game.tenantKey),
      participants: { $eq: before.game.participants }, payments: { $eq: before.game.payments },
      updatedAt: own(before.game, 'updatedAt') ? exact(before.game.updatedAt) : { $exists: false },
      revision: own(before.game, 'revision') ? { $eq: before.game.revision } : { $exists: false } };
    const updatedAt = new Date().toISOString();
    requireCondition(updatedAt !== before.game.updatedAt, 'Timestamp has not advanced');
    const result = await games.updateOne(query, { $set: { participants: plan.nextParticipants, updatedAt, revision: plan.nextRevision } }, { session });
    requireCondition(result.acknowledged === true && result.matchedCount === 1 && result.modifiedCount === 1, 'CAS repair not acknowledged; do not retry blindly');
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally { await session.endSession(); }
  const after = await read();
  verifyPartnerDuplicateRepair({ before: before.game, after: after.game,
    membershipBefore: before.membership, membershipAfter: after.membership,
    operationBefore: before.operation, operationAfter: after.operation, plan });
  const postViva = await readVivaRoster(after.membership);
  verifyVivaRoster(postViva, after.membership, scope);
  requireCondition(await verifyQuiescence() === true, "Partner mutation boundary changed during correction");
  const postcheck = { ...receipt, verified: true, gameHashAfter: hashDocument(after.game), partnerStateUnchanged: true, vivaBookingActive: true };
  fs.writeFileSync(path.join(backupDirectory, 'postcheck.json'), JSON.stringify(postcheck, null, 2), { mode: 0o600, flag: 'wx' });
  return postcheck;
}
