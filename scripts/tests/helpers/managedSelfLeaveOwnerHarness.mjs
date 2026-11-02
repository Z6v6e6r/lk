import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { managedSelfLeaveOwnerSource } from '../../lib/managedSelfLeaveOwnerSource.mjs';
const f = JSON.parse(
  fs.readFileSync(new URL('../fixtures/managed-self-leave-v1-contract.json', import.meta.url)),
);
const join = JSON.parse(
  fs.readFileSync(new URL('../fixtures/managed-join-v2-contract.json', import.meta.url)),
);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const actor = 'synthetic-actor-credential-for-leave';
const hash = (text) => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const env = {
  LK1_BOOKED_OPERATION_RECEIVER_ENABLED: 'true',
  BOOKED_OPERATION_EXECUTION_ENABLED: 'true',
  LK2_BOOKED_OPERATION_DELEGATION_ISSUER: 'https://lk2.example.test',
  LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: 'lk1-owner',
  LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: 'synthetic-key',
  LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: publicKey,
};
const functions = Object.fromEntries(
  ['verify', 'router'].map((n) => [
    n,
    new Function('msg', 'env', 'nodeCrypto', 'global', managedSelfLeaveOwnerSource(n)),
  ]),
);
const run = (name, msg) =>
  functions[name](msg, { get: (k) => env[k] }, crypto, { get: () => undefined });
const legacy = (name, msg) =>
  new Function(
    'msg',
    'global',
    'env',
    fs.readFileSync(
      new URL('../../nodered_games_nodes/fn_split_leave_' + name + '.js', import.meta.url),
      'utf8',
    ),
  )(msg, { get: () => undefined }, { get: () => undefined });
const claims = (mode = 'admit', extra = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: env.LK2_BOOKED_OPERATION_DELEGATION_ISSUER,
    aud: env.LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE,
    sub: f.identity.userId,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 60,
    contract_version: 1,
    scope: 'subscription-runtime.managed-self-leave.' + mode,
    caller: 'lk2-api',
    method: mode === 'admit' ? 'POST' : 'GET',
    path: mode === 'admit' ? f.paths.admission : f.paths.read,
    operation_id: f.identity.operationId,
    tenant_id: f.identity.tenantId,
    tenant_key: 'iSkq6G',
    sid: '77777777-7777-4777-8777-777777777777',
    provider: 'VIVA',
    provider_client_id: f.originalJoinReceipt.providerClientId,
    provider_mapping_id: f.originalJoinReceipt.providerMappingId,
    correlation_id: 'synthetic-managed-leave-correlation',
    ...(mode === 'admit'
      ? {
          request_sha256: f.requestSha256,
          idempotency_key_sha256: f.identity.idempotencyKeySha256,
          actor_token_sha256: hash(actor),
          actor_token_expires_at: new Date(Date.now() + 300000).toISOString(),
          legacy_game_id: 'fixture-legacy-game',
          legacy_game_mapping_id: f.confirmed.receipt.legacyGameMappingId,
          legacy_game_mapping_version: f.confirmed.receipt.legacyGameMappingVersion,
        }
      : { receipt_version: 1 }),
    ...extra,
  };
};
const sign = (c) => {
  const h = Buffer.from(
    JSON.stringify({
      alg: 'RS256',
      typ: 'phub-subscription-runtime-actor-delegation+jwt',
      kid: 'synthetic-key',
    }),
  ).toString('base64url');
  const p = Buffer.from(JSON.stringify(c)).toString('base64url');
  return (
    h +
    '.' +
    p +
    '.' +
    crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url')
  );
};
const message = (mode = 'admit', extra = {}) => {
  const c = claims(mode, extra);
  return {
    req: {
      method: c.method,
      url: c.path,
      originalUrl: c.path,
      query: {},
      headers: {
        'x-subscription-actor-delegation': sign(c),
        'x-correlation-id': c.correlation_id,
        ...(mode === 'admit' ? { 'x-subscription-actor-token': actor } : {}),
      },
    },
    payload: mode === 'admit' ? structuredClone(f.request) : undefined,
  };
};
const accepted = (extra = {}) => {
  const output = run('verify', message('admit', extra));
  assert.ok(output[0]);
  return output[0];
};
const capability = (msg) => {
  for (const name of [
    'prepare',
    'authorize',
    'operation_start',
    'operation_route',
    'operation_claim',
    'router',
  ]) {
    const output = legacy(name, msg);
    assert.equal(output.filter(Boolean).length, 1);
    msg = output.at(-1);
    assert.ok(msg, name);
  }
  return msg;
};
const original = () => {
  const r = f.originalJoinReceipt;
  return {
    stored: {
      ...r,
      _id: r.operationId,
      kind: 'BOOKED_OPERATION_ADMISSION',
      tenantKey: 'iSkq6G',
      contractVersion: 2,
      targetId: r.gameId,
      managedJoinV2: structuredClone(join.admission.request),
      expectedRevision: 7,
    },
    booking: {
      _id: 'fixture-booking-operation-key',
      operationId: r.operationId,
      tenantKey: 'iSkq6G',
      actorClientId: r.providerClientId,
      exerciseId: r.providerExerciseId,
      clientSubscriptionId: r.providerClientSubscriptionId,
      serviceDate: '2026-10-31',
      state: 'CONFIRMED',
      bookingId: r.bookingId,
      confirmedAt: r.verifiedAt,
      activationState: 'NOT_REQUIRED',
      managedJoinV2: structuredClone(join.admission.request),
      managedSubscriptionInstanceId: r.entitlement.subscriptionInstanceId,
      managedEntitlementOperationId: r.entitlement.usageRef.usageRef,
      managedEntitlementState: 'CONFIRMED',
      managedDecision: {
        decisionKind: 'ENTITLEMENT',
        action: 'JOIN_GAME',
        target: { targetId: r.providerExerciseId },
        policyVersion: r.entitlement.policyRef.policyVersion,
        policyDigest: r.entitlement.policyRef.policyDigest,
        usageUnits: 1,
        money: { currency: 'RUB', finalPriceMinor: 0 },
      },
    },
    game: {
      id: 'fixture-legacy-game',
      archived: false,
      metadata: { vivaExerciseId: r.providerExerciseId },
      organizer: { id: 'different-organizer' },
      participants: [],
      waitlist: [],
    },
  };
};
function freshToInsert(change = {}) {
  const facts = original();
  Object.assign(facts, change);
  let msg = accepted();
  msg.payload = [];
  let out = run('router', msg);
  assert.equal(out[6], msg);
  capability(msg);
  out = run('router', msg);
  assert.equal(out[0], msg);
  msg.payload = [facts.stored];
  out = run('router', msg);
  assert.equal(out[0], msg);
  msg.payload = [facts.booking];
  out = run('router', msg);
  if (!out[5]) return { msg, out, facts };
  msg.statusCode = 200;
  msg.responseUrl = msg.url;
  msg.payload = { id: f.originalJoinReceipt.providerClientId };
  out = run('router', msg);
  assert.equal(out[4], msg);
  msg.payload = [facts.game];
  out = run('router', msg);
  if (!out[5]) return { msg, out, facts };
  msg.statusCode = 200;
  msg.responseUrl = msg.url;
  msg.payload = { cancellationOptions: { subscription: { available: true } } };
  out = run('router', msg);
  return { msg, out, facts };
}
function ownerDoc() {
  const { msg } = freshToInsert();
  return structuredClone(msg.payload[1].$setOnInsert);
}
function readMessage(doc, mode = 'read', extra = {}) {
  const m = mode === 'read' ? run('verify', message('read'))[0] : accepted(extra);
  m.payload = [structuredClone(doc)];
  return { m, out: run('router', m) };
}
function terminal(doc) {
  const b = doc.originalJoinReceipt;
  const bind = {
    schemaVersion: 1,
    tenantId: doc.tenantId,
    userId: doc.userId,
    tenantKey: doc.tenantKey,
    gameId: doc.request.target.id,
    legacyGameId: doc.legacyGameId,
    providerClientId: doc.providerClientId,
    providerMappingId: doc.providerMappingId,
    legacyGameMappingId: doc.legacyGameMappingId,
    legacyGameMappingVersion: doc.legacyGameMappingVersion,
    participationId: doc.request.participationId,
    reservationId: doc.request.reservationId,
    joinOperationId: doc.request.joinOperationId,
    joinReceiptSha256: doc.request.joinReceiptSha256,
    bookingOperationKey: doc.bookingOperationKey,
    providerExerciseId: b.providerExerciseId,
    providerClientSubscriptionId: b.providerClientSubscriptionId,
    providerBookingId: b.bookingId,
    subscriptionInstanceId: b.entitlement.subscriptionInstanceId,
    entitlementOperationId: b.entitlement.usageRef.usageRef,
    membershipVersion: doc.membershipVersion,
    ownerLeaveOperationId: doc.ownerLeaveOperationId,
    ownerLeaveOperationKey: doc.ownerLeaveOperationKey,
  };
  const leave = {
    _id: doc.ownerLeaveOperationKey,
    operationId: doc.ownerLeaveOperationId,
    tenantKey: doc.tenantKey,
    mode: 'SELF',
    actorClientId: doc.providerClientId,
    targetClientId: doc.providerClientId,
    gameId: doc.legacyGameId,
    exerciseId: b.providerExerciseId,
    clientSubscriptionId: b.providerClientSubscriptionId,
    membershipVersion: doc.membershipVersion,
    bookingIds: [b.bookingId],
    managedSelfLeaveOwner: bind,
    state: 'DONE',
    outcome: 'REMOVED',
    lkAppliedAt: f.confirmed.asOf,
    doneAt: f.confirmed.asOf,
    dailyLimitReleaseOutcome: 'RELEASED',
    subscriptionReturnState: 'RETURN_VERIFIED',
    vivaVerification: 'active_absent_history_cancelled',
  };
  const booking = {
    ...original().booking,
    state: 'RELEASED',
    managedSelfLeaveReceipt: structuredClone(f.confirmed.receipt.compensation),
    managedSelfLeaveCancellation: {
      schemaVersion: 1,
      observedAt: '2026-10-31T12:00:00.000Z',
      binding: {
        schemaVersion: 1,
        tenantKey: doc.tenantKey,
        actorClientId: doc.providerClientId,
        exerciseId: b.providerExerciseId,
        clientSubscriptionId: b.providerClientSubscriptionId,
        bookingId: b.bookingId,
        serviceDate: '2026-10-31',
        bookingOperationKey: doc.bookingOperationKey,
        bookingOperationId: doc.request.joinOperationId,
        entitlementOperationId: b.entitlement.usageRef.usageRef,
        subscriptionInstanceId: b.entitlement.subscriptionInstanceId,
        leaveOperationKey: doc.ownerLeaveOperationKey,
        leaveOperationId: doc.ownerLeaveOperationId,
        gameId: doc.legacyGameId,
        membershipVersion: doc.membershipVersion,
      },
    },
  };
  return { leave, booking, bind };
}
function readTerminal(doc, mutate = () => {}) {
  const rows = terminal(doc);
  mutate(rows);
  const { m, out } = readMessage(doc);
  if (!out[3]) return { m, out, rows };
  assert.equal(out[3], m);
  m.payload = [rows.leave];
  const next = run('router', m);
  if (!next[0]) return { m, out: next, rows };
  m.payload = [rows.booking];
  return { m, out: run('router', m), rows };
}

export {
  f,
  env,
  actor,
  run,
  legacy,
  claims,
  message,
  accepted,
  capability,
  original,
  freshToInsert,
  ownerDoc,
  terminal,
  readMessage,
  readTerminal,
  hash,
};
function resumeFreshToClaim(doc) {
  const facts = original();
  const { m } = readMessage(doc, 'admit');
  m.payload = [];
  assert.ok(run('router', m)[6]);
  capability(m);
  run('router', m);
  m.payload = [facts.stored];
  run('router', m);
  m.payload = [facts.booking];
  run('router', m);
  m.statusCode = 200;
  m.responseUrl = m.url;
  m.payload = { id: doc.providerClientId };
  run('router', m);
  m.payload = [facts.game];
  run('router', m);
  m.statusCode = 200;
  m.responseUrl = m.url;
  m.payload = { cancellationOptions: { subscription: { available: true } } };
  assert.ok(run('router', m)[2]);
  return m;
}
export { resumeFreshToClaim };
