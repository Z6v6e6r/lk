import fs from 'node:fs';
import assert from 'node:assert/strict';
import { prepareChanges, replaceOnce, sha256, PREIMAGES, patchGamePrivateProjectionFlow } from '../../prepare_game_private_projection_candidate.mjs';

const read = file => fs.readFileSync(file, 'utf8');
export function originalFunctions() {
  let base = read('scripts/nodered_games_nodes/fn_patch.js');
  for (const [before, after] of [...prepareChanges].reverse()) base = replaceOnce(base, after, before);
  assert.equal(sha256(base), '04d4565f740ac2179b0bb76756eccad4f7a7e88e2a3569f3a0670f32d3ed672b');
  base = base.slice(base.indexOf('const isObj ='));
  base = replaceOnce(base, 'if (\n  Object.prototype.hasOwnProperty.call(body, "participants")\n    || Object.prototype.hasOwnProperty.call(body, "waitlist")\n)', `const canonicalRosterBridgeEnabled = (() => {
  try {
    return ["1", "true", "yes", "on"].includes(
      String(env.get("PADLHUB_LEGACY_ROSTER_PATCH_GUARD_ENABLED") || "").trim().toLowerCase(),
    );
  } catch {
    return false;
  }
})();
if (
  canonicalRosterBridgeEnabled
  && (Object.prototype.hasOwnProperty.call(body, "participants")
    || Object.prototype.hasOwnProperty.call(body, "waitlist"))
)`);
  base = replaceOnce(base, 'return [dbMsg, responseMsg, responseMsg, autojoinProbeMsg];', `
if (!msg._organizerGuardSnapshot) return [null, null, null, null];
dbMsg.query = { ...dbMsg.query, updatedAt: msg._organizerGuardSnapshot.updatedAt ?? { $exists: false },
  organizer: msg._organizerGuardSnapshot.organizer, membershipMutation: { $exists: false } };
dbMsg._organizerPatchResponse = responseMsg.payload;
dbMsg._organizerPatchAutojoin = autojoinProbeMsg._gameAutojoinPatch;
return [dbMsg, null, null, null];`);
  let wrapper = read('scripts/nodered_partner_roster_nodes/fn_wrapper.js');
  wrapper = wrapper.slice(wrapper.indexOf('const outputs ='));
  const prepare = wrapper.replace('__LIVE_SOURCE__', base);
  let guard = read('scripts/nodered_organizer_handoff_nodes/fn_patch_authority_check.js');
  const start = guard.indexOf('if (Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt")');
  guard = guard.slice(0, start) + guard.slice(guard.indexOf('if (body.resultRosterSnapshot)', start));
  guard = guard.replace(', privateGame: game', '');
  let ack = read('scripts/nodered_organizer_handoff_nodes/fn_patch_write_ack.js');
  ack = ack.slice(0, ack.indexOf('const isObj =')) + ack.slice(ack.indexOf('const followup ='));
  ack = ack.replace('redactPhoneData(msg._organizerPatchResponse)', 'msg._organizerPatchResponse');
  const functions = { e0d7883bc1a9fa8c: prepare, organizer_handoff_20260913_patch_check: guard, organizer_handoff_20260913_patch_ack: ack };
  for (const [id, func] of Object.entries(functions)) assert.equal(sha256(func), PREIMAGES[id], id);
  return functions;
}
export function candidateFunctions() {
  return Object.fromEntries(patchGamePrivateProjectionFlow(Object.entries(originalFunctions()).map(([id, func]) => ({ id, func, type: 'function', name: 'synthetic fixture', wires: [] }))).map(n => [n.id, n.func]));
}
export const ids = { organizer: '00000000-0000-4000-8000-000000000001', player: '00000000-0000-4000-8000-000000000002', waiting: '00000000-0000-4000-8000-000000000003', actor: '00000000-0000-4000-8000-000000000004' };
export const phone = n => '7' + '0'.repeat(9) + n;
export const fixture = () => ({
  _id: 'synthetic-document', id: 'fixture-game', tenantKey: 'fixture-tenant', archived: false, status: 'PAID', updatedAt: '2099-11-15T10:00:00.000Z',
  organizer: { id: ids.organizer, name: 'Organizer fixture', phone: phone(1), phoneNorm: phone(1), rating: 'D', ratingNumeric: 2 },
  participants: [{ id: ids.organizer, name: 'Organizer fixture', phone: phone(1), source: 'ORGANIZER', status: 'CONFIRMED' }, { id: ids.player, name: 'Player fixture', phone: phone(2), source: 'INVITE_LINK', status: 'CONFIRMED' }],
  waitlist: [{ id: ids.waiting, name: 'Waiting fixture', phone: phone(3), status: 'WAITLIST' }], invitedPhones: [phone(5)],
  booking: { exerciseId: 'fixture-exercise', vivaExerciseId: 'fixture-exercise', date: '2099-11-16', timeFrom: '10:00', timeTo: '12:00', durationMinutes: 120 }, invite: { maxPlayers: 4, waitlistEnabled: true },
  metadata: { organizerInMatch: true, allRelatedPhones: [phone(1), phone(2), phone(3), phone(5)], bookingIds: ['existing-booking'], teamSlots: [{ id: ids.player, phone: phone(2) }], splitPayment: { enabled: true, status: 'ACTIVE', bookingIds: ['existing-booking'], payments: [{ role: 'PARTICIPANT', status: 'PAID', clientId: ids.player, bookingId: 'existing-booking', phone: phone(2), paymentUrl: 'https://fixture.invalid/pay?clientPhone=' + phone(2) + '&bookingId=existing-booking', amount: 0, amountMinor: 0 }] } },
  audit: { version: 1, events: [] },
});
export function getPublic(game) {
  const msg = { payload: [structuredClone(game)] };
  return new Function('msg', read('scripts/nodered_games_nodes/fn_get_by_id_resp.js'))(msg)[0].payload;
}
export function prepare(game, body, functions = candidateFunctions(), enabled = false) {
  const msg = { payload: [game], _organizerGuardBody: structuredClone(body), req: { params: { gameId: game.id }, path: '/lk/games/' + game.id } };
  const checked = new Function('msg', functions.organizer_handoff_20260913_patch_check)(msg);
  if (!checked[0]) return { response: checked[1], write: null };
  const outputs = new Function('msg', 'env', functions.e0d7883bc1a9fa8c)(checked[0], { get: () => enabled ? 'true' : '' });
  return { write: outputs[0], response: outputs[1] };
}
export function acknowledge(write, result = { acknowledged: true, matchedCount: 1 }, functions = candidateFunctions()) {
  return new Function('msg', functions.organizer_handoff_20260913_patch_ack)({ ...write, payload: result });
}
export function applyFixtureUpdate(game, write) {
  for (const [key, value] of Object.entries(write.payload.$set)) {
    const parts = key.split('.'); let target = game;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = structuredClone(value);
  }
  game.audit.events.push(...write.payload.$push['audit.events'].$each);
  return game;
}
