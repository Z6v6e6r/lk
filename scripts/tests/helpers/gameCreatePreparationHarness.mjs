import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  gameCreatePreparationSource,
  gameCreateServiceTable,
} from '../../lib/gameCreatePreparationSource.mjs';
export const hash = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
export const actor = 'synthetic-create-actor-token';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const uuid = (n) => '11111111-1111-4111-8111-' + String(n).padStart(12, '0');
export const path = '/lk/integrations/v1/game-create-preparations';
export class Harness {
  constructor() {
    this.now = Date.parse('2035-04-01T09:00:00.000Z');
    this.calls = [];
    this.env = {
      LK1_BOOKED_OPERATION_RECEIVER_ENABLED: 'true',
      BOOKED_OPERATION_EXECUTION_ENABLED: 'true',
      LK2_BOOKED_OPERATION_DELEGATION_ISSUER: 'synthetic-lk2',
      LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: 'synthetic-owner',
      LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: 'synthetic-key',
      LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: keys.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
    };
    this.globals = { vivacrm_access_token: 'synthetic-create-admin-token' };
    const h = this;
    this.Date = class extends Date {
      constructor(...a) {
        super(...(a.length ? a : [h.now]));
      }
      static now() {
        return h.now;
      }
    };
    this.fns = Object.fromEntries(
      ['verify', 'router', 'response'].map((k) => [
        k,
        new Function('msg', 'env', 'global', 'nodeCrypto', 'Date', gameCreatePreparationSource(k)),
      ]),
    );
    this.body = {
      contractVersion: 1,
      action: 'CREATE_GAME',
      subscriptionId: uuid(1),
      target: {
        draftId: uuid(2),
        expectedRevision: 1,
        stationId: uuid(3),
        courtId: uuid(4),
        startsAt: '2035-04-02T09:00:00.000Z',
        durationMinutes: 90,
      },
    };
    this.claims = {
      iss: 'synthetic-lk2',
      aud: 'synthetic-owner',
      sub: uuid(5),
      iat: this.now / 1000,
      nbf: this.now / 1000,
      exp: this.now / 1000 + 120,
      jti: uuid(6),
      sid: uuid(7),
      contract_version: 1,
      caller: 'lk2-api',
      scope: 'subscription-runtime.game-create.prepare',
      method: 'POST',
      path,
      tenant_id: uuid(8),
      tenant_key: 'iSkq6G',
      provider: 'VIVA',
      provider_client_id: 'synthetic-player',
      provider_mapping_id: uuid(9),
      subscription_id: uuid(1),
      provider_client_subscription_id: 'synthetic-subscription',
      operation_id: uuid(10),
      idempotency_key_sha256: hash('synthetic-key'),
      request_sha256: hash('game-create-preparation:v1\0' + JSON.stringify(this.body)),
      correlation_id: 'synthetic-create-correlation',
      actor_token_sha256: hash(actor),
      actor_token_expires_at: new Date(this.now + 120000).toISOString(),
      draft_id: uuid(2),
      expected_revision: 1,
      station_id: uuid(3),
      court_id: uuid(4),
      station_mapping_id: uuid(11),
      court_mapping_id: uuid(12),
      mapping_version: 'synthetic-v1',
      provider_station_id: Object.keys(gameCreateServiceTable)[0],
      provider_room_id: 'synthetic-room',
    };
    const hex = hash(
      'booked-operation-admission:v1\0lk2-api\0' +
        this.claims.tenant_id +
        '\0' +
        this.claims.sub +
        '\0' +
        this.claims.idempotency_key_sha256,
    )
      .slice(7, 39)
      .split('');
    hex[12] = '8';
    hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
    const s = hex.join('');
    this.claims.operation_id = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  invoke(k, msg) {
    return this.fns[k](
      msg,
      { get: (n) => this.env[n] },
      { get: (n) => this.globals[n] },
      crypto,
      this.Date,
    );
  }
  sign(c) {
    const h = Buffer.from(
        JSON.stringify({
          alg: 'RS256',
          kid: 'synthetic-key',
          typ: 'phub-subscription-runtime-actor-delegation+jwt',
        }),
      ).toString('base64url'),
      p = Buffer.from(JSON.stringify(c)).toString('base64url');
    return (
      h +
      '.' +
      p +
      '.' +
      crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), keys.privateKey).toString('base64url')
    );
  }
  response(step, c) {
    const service = gameCreateServiceTable[c.provider_station_id];
    if (step === 'profile')
      return { id: c.provider_client_id, name: 'PRIVATE_PROFILE', phone: 'PRIVATE_PHONE' };
    if (step === 'subscriptions')
      return [
        { clientSubscriptionId: c.provider_client_subscription_id, clientId: c.provider_client_id },
      ];
    if (step === 'room') return { id: c.provider_room_id, studioId: c.provider_station_id };
    if (step === 'studios') return [{ id: c.provider_station_id }];
    if (step === 'subservices')
      return [{ id: service.subServiceId, roomIds: [c.provider_room_id] }];
    if (step === 'price') return { total: 600000, currency: 'RUB' };
    assert.fail(step);
  }
  run({ claims = {}, body = this.body, mutate, request } = {}) {
    const c = { ...this.claims, ...claims };
    let msg = {
      req: {
        method: 'POST',
        originalUrl: path,
        query: {},
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': c.correlation_id,
          'x-subscription-actor-delegation': this.sign(c),
          'x-subscription-actor-token': actor,
        },
      },
      payload: structuredClone(body),
    };
    request?.(msg);
    let out = this.invoke('verify', msg);
    if (out[1]) return this.invoke('response', out[1]);
    msg = out[0];
    for (let i = 0; i < 10; i++) {
      out = this.invoke('router', msg);
      if (out[1]) return this.invoke('response', out[1]);
      msg = out[0];
      assert.equal(msg.method, 'GET');
      assert.ok(msg.url.startsWith('https://api.vivacrm.ru/'));
      this.calls.push({ step: msg._gameCreatePreparation.step, url: msg.url, method: msg.method });
      msg.payload = this.response(msg._gameCreatePreparation.step, c);
      msg.statusCode = 200;
      msg.responseUrl = msg.url;
      mutate?.(msg, msg._gameCreatePreparation.step, this);
    }
    assert.fail('unbounded request loop');
  }
}
