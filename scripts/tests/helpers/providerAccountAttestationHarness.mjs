import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { providerAccountAttestationSource } from '../../lib/providerAccountAttestationSource.mjs';

export const hash = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
export const actor = 'synthetic-attestation-actor-token';
export const path = '/lk/integrations/v1/provider-account-attestations';
export const fixture = JSON.parse(fs.readFileSync(
  new URL('../fixtures/viva-end-user-subscriptions.redacted.json', import.meta.url), 'utf8'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const uuid = (n) => '11111111-1111-4111-8111-' + String(n).padStart(12, '0');
export const requestHash = (body) => hash('provider-account-attestation:v1\0' + JSON.stringify({
  contractVersion: body.contractVersion, operationId: body.operationId,
  target: body.target ? { exerciseId: body.target.exerciseId } : null }));
const sources = Object.fromEntries(['verify', 'router', 'response', 'probe']
  .map((k) => [k, providerAccountAttestationSource(k)]));

export class Harness {
  constructor() {
    this.now = Date.parse('2035-04-01T09:00:00.000Z');
    this.calls = [];
    this.logs = [];
    this.store = new Map();
    this.env = {
      LK1_BOOKED_OPERATION_RECEIVER_ENABLED: 'true',
      LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED: 'true',
      LK2_BOOKED_OPERATION_DELEGATION_ISSUER: 'synthetic-lk2',
      LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: 'synthetic-owner',
      LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: 'synthetic-key',
      LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    };
    const h = this;
    this.Date = class extends Date {
      constructor(...a) { super(...(a.length ? a : [h.now])); }
      static now() { return h.now; }
    };
    this.fns = Object.fromEntries(Object.entries(sources).map(([k, src]) => [k,
      new Function('msg', 'env', 'global', 'context', 'nodeCrypto', 'Date', 'node', 'console', src)]));
    this.profile = { id: 'synthetic-client-1', name: 'PRIVATE_NAME', phone: 'PRIVATE_PHONE_VALUE', email: 'PRIVATE_EMAIL_VALUE' };
    this.subscriptions = structuredClone(fixture.response);
    this.exercise = {
      id: 'synthetic-exercise-1', timeFrom: '2035-04-02T09:00:00.000Z', timeTo: '2035-04-02T10:30:00.000Z',
      availableClientSubscriptions: [{ subscriptionId: 'synthetic-client-subscription-active', name: 'PRIVATE' }],
    };
    this.statuses = {};
    this.body = { contractVersion: 1, operationId: uuid(10) };
    this.typ = 'phub-provider-account-attestation+jwt';
  }
  claimsFor(body) {
    const s = this.now / 1000;
    return {
      iss: 'synthetic-lk2', aud: 'synthetic-owner', sub: uuid(5), sid: uuid(7), iat: s, nbf: s, exp: s + 60,
      jti: uuid(6), contract_version: 1, caller: 'lk2-api', scope: 'lk1:provider-account:attest', method: 'POST', path,
      tenant_id: uuid(8), tenant_key: 'iSkq6G', provider: 'VIVA', operation_id: body.operationId,
      correlation_id: 'synthetic-attestation-correlation', request_sha256: requestHash(body),
      actor_token_sha256: hash(actor), actor_token_expires_at: new Date(this.now + 120000).toISOString(),
    };
  }
  sign(c, typ = this.typ) {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key', typ })).toString('base64url');
    const p = Buffer.from(JSON.stringify(c)).toString('base64url');
    return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), keys.privateKey).toString('base64url');
  }
  invoke(k, msg) {
    const store = { get: (key) => this.store.get(key), set: (key, value) => this.store.set(key, value) };
    const log = (...a) => this.logs.push(a);
    return this.fns[k](msg, { get: (n) => this.env[n] }, { get: () => assert.fail('global read') }, store, crypto,
      this.Date, { warn: log, error: log, log, status: log }, { log, warn: log, error: log });
  }
  message({ claims = {}, body = this.body, typ, request, signedBody } = {}) {
    const c = { ...this.claimsFor(signedBody || body), ...claims };
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete c[k];
    const msg = {
      _msgid: 'm1',
      req: { method: 'POST', originalUrl: path, query: {}, headers: {
        'content-type': 'application/json', 'x-correlation-id': c.correlation_id,
        'x-subscription-actor-delegation': this.sign(c, typ), 'x-subscription-actor-token': actor } },
      res: {},
      payload: structuredClone(body),
    };
    request?.(msg);
    return msg;
  }
  provider(step) {
    if (step === 'profile') return this.profile;
    if (step === 'subscriptions') return this.subscriptions;
    if (step === 'exercise') return this.exercise;
    return assert.fail(step);
  }
  run(options = {}) {
    let msg = options.msg || this.message(options);
    let out = this.invoke('verify', msg);
    if (out[1]) return this.invoke('response', out[1]);
    msg = out[0];
    for (let i = 0; i < 6; i++) {
      out = this.invoke('router', msg);
      if (out[1]) return this.invoke('response', out[1]);
      msg = out[0];
      const step = msg._providerAccountAttestation.step;
      this.calls.push({ step, url: msg.url, method: msg.method, auth: msg.headers.Authorization,
        followRedirects: msg.followRedirects, payload: msg.payload });
      if (options.transportError === step) {
        // Node-RED http request with senderr:false: error code as status, text payload, no responseUrl.
        msg.statusCode = 'ETIMEDOUT';
        msg.payload = 'RequestError: timeout : ' + msg.url;
        continue;
      }
      msg.statusCode = this.statuses[step] ?? 200;
      msg.payload = structuredClone(this.provider(step));
      msg.responseUrl = options.redirect === step ? msg.url + '?x=1' : msg.url;
      if (options.rawBody === step) msg.payload = '<html>not json</html>';
      options.mutate?.(msg, step);
    }
    return assert.fail('unbounded request loop');
  }
  probe(headers = { 'x-provider-account-attestation-contract': '1' }, method = 'GET') {
    const msg = { _msgid: 'p1', req: { method, originalUrl: path, query: {}, headers }, res: {} };
    return this.invoke('response', this.invoke('probe', msg));
  }
}
