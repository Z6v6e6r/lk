import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Harness, actor, hash } from './gameCreatePreparationHarness.mjs';
import { gameCreateOwnerSource, quarterCreateGatewaySource, quarterCreateSplitSource } from '../../lib/gameCreateOwnerSource.mjs';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const get = (o, key) => key.split('.').reduce((v, p) => v?.[p], o);
export const matches = (row, q, now = Date.now()) => Object.entries(q).every(([k, v]) => {
  if (k === '$or') return v.some(x => matches(row, x, now));
  if (k === '$expr') return Date.parse(v.$lte[0].$dateFromString.dateString.$literal) <= now && v.$lte[1] === '$$NOW';
  const actual = get(row, k);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('$exists' in v) return (actual !== undefined) === v.$exists;
    if ('$in' in v) return v.$in.some(x => equal(x, actual) || (x === null && actual === undefined));
    if ('$ne' in v) return !equal(v.$ne, actual);
  }
  return equal(actual, v);
});
export class OwnerHarness extends Harness {
  constructor({ key, revision = 1, now } = {}) {
    super();
    if (now !== undefined) {
      this.now = now; Object.assign(this.claims, { iat: Math.floor(now / 1000), nbf: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 120,
        actor_token_expires_at: new this.Date(now + 120000).toISOString() });
    }
    if (key) {
      this.claims.idempotency_key_sha256 = hash(key);
      const chars = hash('booked-operation-admission:v1\0lk2-api\0' + this.claims.tenant_id + '\0' + this.claims.sub
        + '\0' + this.claims.idempotency_key_sha256).slice(7, 39).split('');
      chars[12] = '8'; chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
      const s = chars.join(''); this.claims.operation_id = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    }
    this.body.target.durationMinutes = 60;
    this.body.target.expectedRevision = revision; this.claims.expected_revision = revision;
    this.claims.request_sha256 = hash('game-create-preparation:v1\0' + JSON.stringify(this.body));
    this.preparation = this.run().payload;
    assert.equal(this.preparation.schemaVersion, 1);
    this.admission = { ...this.body, preparation: this.preparation };
    this.rows = new Map(); this.trace = []; this.providerCreates = 0; this.bookingCreates = 0;
    this.reserveCalls = 0; this.confirmCalls = 0; this.releaseCalls = 0; this.bookingExists = false; this.diagnostics = [];
    Object.assign(this.globals, { subscriptions_runtime_environment: 'PROD', subscriptions_runtime_api_base_url: 'https://padlhub.su/api',
      subscriptions_runtime_context_integration_token: 'synthetic-runtime-token-at-least32',
      subscriptions_target_ingest_integration_token: 'synthetic-target-token-at-least32',
      subscriptions_entitlement_integration_token: 'synthetic-entitlement-token-at-least32',
      subscriptions_owner_evidence_enabled: true, subscriptions_owner_evidence_secret: 'synthetic-owner-evidence-secret-32',
      crypto, lkDiagnostics: { observe: (...args) => this.diagnostics.push(args) } });
    const source = (name) => fs.readFileSync(new URL('../../nodered_subscription_booking_nodes/fn_subscription_booking_' + name + '.js', import.meta.url), 'utf8');
    const sources = Object.fromEntries(['verify', 'router', 'response', 'bridge', 'observe'].map(n => [n, gameCreateOwnerSource(n)]));
    Object.assign(sources, { splitPrepare: quarterCreateSplitSource('create_prepare'), split: quarterCreateSplitSource('router'),
      gateway: quarterCreateGatewaySource(), gatewayPrepare: source('prepare'), finalize: source('finalize'), mongoError: source('mongo_error') });
    this.ownerFns = Object.fromEntries(Object.entries(sources).map(([name, text]) => [name,
      new Function('msg', 'env', 'global', 'nodeCrypto', 'Date', text)]));
    const p = this.preparation;
    this.runtime = { schemaVersion: 1, subscriptionInstanceId: 'instance:synthetic-create',
      clientSubscriptionId: this.claims.provider_client_subscription_id, policyDigest: hash('synthetic-quarter-policy'),
      policy: { subscriptionTypeId: 'type:synthetic-quarter', policyVersion: 3, createGame: { enabled: true, durationsMinutes: [60] } },
      instance: { subscriptionInstanceId: 'instance:synthetic-create', subscriptionTypeId: 'type:synthetic-quarter', policyVersion: 3,
        state: 'ACTIVE', activeFrom: '2035-01-01T00:00:00.000Z', activeTo: '2036-01-01T00:00:00.000Z',
        frozenUntil: null, homeStationId: this.claims.station_id, noShowBlockedUntil: null },
      evidence: { mappingId: 'mapping:synthetic-quarter', mappingRevision: 1, mappingVerifiedAt: this.preparation.observedAt,
        publicationId: 'publication:synthetic-quarter', publishedAt: '2035-01-01T00:00:00.000Z', instanceRevision: 1,
        instanceAsOf: this.preparation.observedAt } };
    this.expectations = { schemaVersion: 1, policyVersion: 3, policyDigest: this.runtime.policyDigest,
      targetSnapshot: { snapshotId: 'snapshot:synthetic-quarter', revision, evidenceRef: 'evidence:synthetic-quarter' },
      createQuarter: { schemaVersion: 1, createOperationId: this.claims.operation_id, draftId: this.claims.draft_id,
        clientRefHash: 'a'.repeat(64), publicationId: this.runtime.evidence.publicationId, descriptorDigest: hash('synthetic-quarter-descriptor') } };
    this.decision = { decisionKind: 'ENTITLEMENT', policyVersion: 3, policyDigest: this.runtime.policyDigest, action: 'CREATE_GAME',
      target: { targetId: 'create-draft:' + this.claims.draft_id, stationId: this.claims.station_id,
        eventTypeId: 'viva:direction:4588:type:1613', productTypeId: null, durationMinutes: 60, startsAt: p.target.startsAt },
      usageUnits: 1, money: { currency: 'RUB', basePriceMinor: p.pricing.quarterPriceMinor,
        discountMinor: p.pricing.quarterPriceMinor, surchargeMinor: 0, finalPriceMinor: 0 } };
  }
  invokeOwner(name, msg) {
    return this.ownerFns[name](msg, { get: k => this.env[k] }, { get: k => this.globals[k], set: (k, v) => { this.globals[k] = v; } }, crypto, this.Date);
  }
  message({ mode = 'admit', recoveryOnly = false, body, claims = {} } = {}) {
    const c = { ...this.claims, iat: Math.floor(this.now / 1000), nbf: Math.floor(this.now / 1000), exp: Math.floor(this.now / 1000) + 120,
      actor_token_expires_at: new this.Date(this.now + 120000).toISOString(), ...claims };
    c.scope = mode === 'read' ? 'subscription-runtime.game-create.read' : 'subscription-runtime.game-create.admit';
    c.path = mode === 'read' ? '/lk/integrations/v1/game-create-operations/' + c.operation_id + '/read'
      : '/lk/integrations/v1/game-create-operations/admissions';
    const request = body || (mode === 'read' ? { contractVersion: 1, operationId: c.operation_id,
      admissionRequestSha256: hash('game-create-admission:v1\0' + JSON.stringify(this.admission)) } : this.admission);
    c.request_sha256 = hash((mode === 'read' ? 'game-create-read:v1\0' : 'game-create-admission:v1\0') + JSON.stringify(request));
    if (recoveryOnly) c.recovery_only = true;
    return { req: { method: 'POST', originalUrl: c.path, query: {}, headers: {
      'content-type': 'application/json', 'x-correlation-id': c.correlation_id,
      'x-subscription-actor-delegation': this.sign(c), 'x-subscription-actor-token': actor } }, payload: structuredClone(request) };
  }
  update(msg) {
    this.onBeforeMongo?.(msg);
    const [query, update, options] = msg.payload;
    let row = [...this.rows.values()].find(r => matches(r, query, this.now));
    let inserted = false;
    if (!row && options?.upsert) {
      if (this.rows.has(query._id)) { msg.error = { code: 11000 }; return; }
      row = structuredClone(update.$setOnInsert || {}); this.rows.set(row._id, row); inserted = true;
    }
    if (row) {
      if (Array.isArray(update)) {
        assert.equal(update.length, 1); const set = update[0].$set;
        assert.equal(set.state, 'PRECREATE_ABORTING');
        assert.equal(set.updatedAt.$dateToString.date, '$$NOW');
        Object.assign(row, { state: set.state, quarterPrecreateAbort: { ...structuredClone(set.quarterPrecreateAbort.$mergeObjects[0].$literal),
          abortedAt: new this.Date().toISOString() }, updatedAt: new this.Date().toISOString() });
      } else Object.assign(row, structuredClone(update.$set || {}));
      for (const k of Object.keys(update.$unset || {})) delete row[k];
      for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
    }
    msg.payload = { acknowledged: true, matchedCount: row && !inserted ? 1 : 0, modifiedCount: row && !inserted ? 1 : 0,
      upsertedCount: inserted ? 1 : 0, upsertedId: inserted ? row._id : null };
  }
  provider(msg, lane) {
    const url = msg.url, method = msg.method;
    this.trace.push({ lane, url, method, step: msg._subscriptionBooking?.step || msg._gameCreateOwner?.step });
    let payload;
    if (url.endsWith('/runtime-context')) payload = this.runtime;
    else if (url.endsWith('/canonical-targets')) { this.targetInput = structuredClone(msg.payload); payload = {
      targetId: msg.payload.targetId, action: 'CREATE_GAME', revision: msg.payload.revision,
      snapshotId: this.expectations.targetSnapshot.snapshotId, replay: false }; }
    else if (url.endsWith('/entitlements/preflight')) payload = { schemaVersion: 1, nonBinding: true,
      subscriptionInstanceId: this.runtime.subscriptionInstanceId, action: 'CREATE_GAME', target: msg.payload.target,
      expectations: this.expectations };
    else if (url.endsWith('/entitlements/reserve')) { this.reserveCalls++; payload = { schemaVersion: 1, outcome: 'RESERVED',
      subscriptionInstanceId: this.runtime.subscriptionInstanceId, aggregateRevision: 2, operationId: 'usage:synthetic-create',
      operationState: 'RESERVED', replayed: this.reserveCalls > 1, blockers: [], decision: this.decision }; }
    else if (url.endsWith('/entitlements/confirm')) { this.confirmCalls++; payload = { schemaVersion: 1, outcome: 'CONFIRMED',
      subscriptionInstanceId: this.runtime.subscriptionInstanceId, operationId: 'usage:synthetic-create', operationState: 'CONFIRMED', aggregateRevision: 3 }; }
    else if (url.endsWith('/entitlements/release')) { this.releaseCalls++; this.lastReleaseReason = msg.payload.reason; payload = { schemaVersion: 1, outcome: 'RELEASED',
      subscriptionInstanceId: this.runtime.subscriptionInstanceId, operationId: 'usage:synthetic-create', operationState: 'FAILED', aggregateRevision: 3 }; }
    else if (url.endsWith('/entitlements/readback')) payload = { schemaVersion: 1, subscriptionInstanceId: this.runtime.subscriptionInstanceId,
      operationId: 'usage:synthetic-create', operationState: 'FAILED', compensationState: 'APPLIED', releaseReason: this.lastReleaseReason || 'PROVIDER_REJECTED', providerBookingId: null };
    else if (url.endsWith('/api/v1/exercises') && method === 'POST') { this.providerCreates++; payload = { id: 'exercise:original', roomId: this.claims.provider_room_id }; }
    else if (url.endsWith('/exercises/exercise%3Aoriginal/bookings') && method === 'POST') {
      this.bookingCreates++; this.bookingExists = true; payload = { id: 'booking:original', status: 'CONFIRMED' };
    } else if (url.endsWith('/bookings?size=1000')) payload = this.bookingExists ? [this.booking()] : [];
    else if (url.endsWith('/profile')) payload = this.response('profile', this.claims);
    else if (url.endsWith('/subscriptions?includeFinished=true&size=1000')) payload = this.response('subscriptions', this.claims);
    else if (url.endsWith('/exercises/exercise%3Aoriginal')) payload = this.exercise();
    else assert.fail('Unexpected business request ' + method + ' ' + url);
    msg.payload = structuredClone(payload); msg.statusCode = 200; msg.responseUrl = url;
    this.onHttp?.(msg, lane);
  }
  exercise() { return { id: 'exercise:original', roomId: this.claims.provider_room_id,
    studioId: this.claims.provider_station_id, status: 'ACTIVE',
    timeFrom: this.preparation.target.startsAt, timeTo: this.preparation.target.endsAt }; }
  booking() { return { id: 'booking:original', status: 'CONFIRMED', clientId: this.claims.provider_client_id,
    clientSubscriptionId: this.claims.provider_client_subscription_id, exerciseId: 'exercise:original', exercise: this.exercise(), spot: 1 }; }
  execute(options = {}) {
    let msg = this.message(options), node = 'verify';
    for (let turn = 0; turn < 180; turn++) {
      this.onNode?.(node, msg);
      if (node === 'response') return this.invokeOwner(node, msg);
      const outputs = this.invokeOwner(node, msg);
      const index = outputs?.findIndex(Boolean);
      if (index === undefined || index < 0) assert.fail('No output ' + node);
      msg = outputs[index];
      if (node === 'verify') { node = index === 0 ? 'router' : 'response'; continue; }
      if (node === 'router') {
        if (index === 0) { msg.payload = structuredClone([...this.rows.values()].filter(r => matches(r, msg.payload, this.now))); node = 'router'; }
        if (index === 1) { this.update(msg); this.onMongo?.(msg, 'outer'); node = 'router'; }
        if (index === 2) { this.provider(msg, 'outer'); node = 'router'; }
        if (index === 3) node = 'observe';
        if (index === 4) node = 'splitPrepare';
        if (index === 5) node = 'response';
      } else if (node === 'observe') {
        if (index === 1) { node = 'router'; continue; }
        assert.equal(msg.method, 'GET');
        msg.payload = this.response(msg._gameCreatePreparation.step, msg._gameCreatePreparation.claims);
        msg.statusCode = 200; msg.responseUrl = msg.url; this.onHttp?.(msg, 'observe'); node = 'observe';
      } else if (node === 'splitPrepare') node = index === 3 ? 'split' : 'router';
      else if (node === 'split') {
        if (index === 0) { this.provider(msg, 'split'); node = 'split'; }
        else node = index === 3 ? 'bridge' : 'router';
      } else if (node === 'bridge') {
        if (index === 0) { this.provider(msg, 'gateway'); node = 'gateway'; }
        else node = index === 2 ? 'gatewayPrepare' : 'gateway';
      } else if (node === 'gatewayPrepare') node = index === 2 ? 'gateway' : 'finalize';
      else if (node === 'gateway') {
        if (index === 0) { this.provider(msg, 'gateway'); node = 'gateway'; }
        if (index === 1) { msg.payload = structuredClone([...this.rows.values()].filter(r => matches(r, msg.payload, this.now))); node = 'gateway'; }
        if (index === 2) {
          const row = msg.payload;
          if (this.rows.has(row._id)) msg.error = { code: 11000 };
          else this.rows.set(row._id, structuredClone(row));
          msg.payload = { acknowledged: true, insertedId: row._id }; node = 'gateway';
        }
        if (index === 3) { this.update(msg); this.onMongo?.(msg, 'gateway'); node = 'gateway'; }
        if (index === 4) node = 'finalize';
        if (index > 4) assert.fail('Unexpected canonical fanout ' + index);
      } else if (node === 'finalize') node = index === 0 ? 'split' : 'router';
      else assert.fail('Unknown node ' + node);
    }
    assert.fail('Unbounded owner loop at ' + node + ' ' + (msg._gameCreateOwner?.step || '') + ' ' + (msg._subscriptionBooking?.step || ''));
  }
}
