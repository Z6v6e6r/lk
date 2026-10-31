import crypto from 'node:crypto';
import { stationMembershipReceiverSource } from '../../lib/stationMembershipReceiverSource.mjs';
import { smHash, smEqual } from '../../lib/stationMembershipLifetime.mjs';
export const uid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const environment = {
  LK_STATION_MEMBERSHIP_LIFETIME_ENABLED: 'true', LK2_BOOKED_OPERATION_DELEGATION_ISSUER: 'https://issuer.example.test',
  LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE: 'station-owner-test', LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: 'synthetic-key',
  LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }),
};
export const community = () => ({ id: 'station-community', communityType: 'STATION', typeSettingsRevision: 1,
  typeSettings: { stationId: 'station-a' }, members: [], pendingMembers: [], bannedMembers: [], archived: false });
export const admissionBody = (op = 1) => ({ contractVersion: 1, operationId: uid(op), requestSha256: 'sha256:' + 'a'.repeat(64), activity: { kind: 'GAME', id: uid(90) }, stationId: 'station-a' });
export const confirmationBody = (admission, generation = 80) => ({ contractVersion: 1, operationId: admission.operationId, admissionId: admission.admission.admissionId,
  admissionBindingSha256: admission.admission.bindingSha256, confirmation: { kind: 'GAME_PARTICIPATION', generationId: uid(generation), activityId: uid(90) } });
export function message(mode, body, override = {}) {
  const now = Math.floor(Date.now() / 1000), path = '/lk/integrations/v1/station-memberships/operations/' + body.operationId + '/' + mode;
  const claims = { iss: environment.LK2_BOOKED_OPERATION_DELEGATION_ISSUER, aud: environment.LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE,
    sub: uid(20), jti: uid(21), iat: now, nbf: now, exp: now + 60, tenant_id: uid(22), provider_client_id: 'player-a', provider_mapping_id: uid(23),
    operation_id: body.operationId, caller: mode === 'admission' ? 'lk2-api' : 'lk2-worker',
    scope: mode === 'admission' ? 'communities.station-membership.admit' : 'communities.station-membership.confirm', method: 'POST', path,
    body_sha256: smHash('station-membership-body:v1', body), correlation_id: 'synthetic-correlation', contract_version: 1,
    ...(mode === 'admission' ? { sid: uid(24), fresh_operation: true, adoption_version: 1 } : { persisted_fact: true }), ...override };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signing = encode({ alg: 'RS256', typ: 'phub-station-membership-delegation+jwt', kid: 'synthetic-key' }) + '.' + encode(claims);
  const token = signing + '.' + crypto.sign('RSA-SHA256', Buffer.from(signing), keys.privateKey).toString('base64url');
  return { req: { method: 'POST', originalUrl: path, params: { operationId: body.operationId }, query: {}, headers: { 'x-station-membership-delegation': token, 'x-correlation-id': claims.correlation_id } }, payload: structuredClone(body) };
}
export const evaluate = (name, msg, envValues = environment, mode) => new Function('msg','env','nodeCrypto', stationMembershipReceiverSource(name, mode))(msg, { get: key => envValues[key] }, crypto);
export async function run(db, mode, body, options = {}) {
  const verified = evaluate('verify', options.message || message(mode, body), options.env || environment, mode);
  if (verified[1]) return verified[1];
  let outputs = [verified[0], null, null, null, null, null, null];
  const stores = ['lk_station_membership_admissions','lk_station_membership_admissions','lk_communities','lk_communities','lk_station_membership_generation_claims','lk_station_membership_generation_claims'];
  for (let i = 0; i < 50; i++) {
    if (outputs[6]) return outputs[6];
    const port = outputs.findIndex(Boolean), msg = outputs[port];
    if (port < 0 || port > 5) throw Error('Invalid owner output');
    const step = msg._stationMembership.step, args = msg.payload;
    const before = await options.before?.({ step, port, msg, db });
    try {
      if (before?.skip) { msg.payload = before.payload; msg.error = before.error; }
      else msg.payload = port % 2 === 0 ? await db.collection(stores[port]).find(...args).toArray() : await db.collection(stores[port]).updateOne(...args);
    } catch { msg.error = { message: 'synthetic storage ambiguity' }; }
    await options.after?.({ step, port, msg, db });
    outputs = evaluate('router', msg, options.env || environment);
  }
  throw Error('Owner did not terminate');
}
const get = (row, path) => path.split('.').reduce((o, key) => o?.[key], row);
export function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    const actual = get(row, key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
      if ('$ne' in value) return !smEqual(actual ?? null, value.$ne);
    }
    return smEqual(actual ?? null, value);
  });
}
export function memoryDb(initial = [community()]) {
  const tables = new Map([['lk_communities', structuredClone(initial)]]);
  return { tables, collection(name) {
    if (!tables.has(name)) tables.set(name, []);
    const rows = tables.get(name);
    return {
      find(query, options = {}) { return { async toArray() { return structuredClone(rows.filter(row => matches(row, query)).slice(0, options.limit || Infinity)); } }; },
      async findOne(query) { return structuredClone(rows.find(row => matches(row, query)) || null); },
      async updateOne(query, update, options = {}) {
        const row = rows.find(row => matches(row, query));
        if (!row && options.upsert) { rows.push(structuredClone(update.$setOnInsert)); return { acknowledged: true, matchedCount: 0, upsertedCount: 1 }; }
        if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        if (update.$set) Object.assign(row, structuredClone(update.$set));
        return { acknowledged: true, matchedCount: 1, modifiedCount: update.$set ? 1 : 0 };
      },
    };
  } };
}
