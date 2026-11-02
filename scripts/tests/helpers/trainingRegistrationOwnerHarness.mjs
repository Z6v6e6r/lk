import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { trainingOwnerRouterSource } from '../../patch_nodered_training_registration_owner.mjs';
import {
  trainingRegistrationOwnerSource,
  trainingContractSource,
} from '../../lib/trainingRegistrationOwnerSource.mjs';
const read = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
export const fixture = JSON.parse(
  read('tests/fixtures/training-registration-owner-v1-contract.json'),
);
export const actor = 'synthetic-training-actor-credential';
export const hash = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const environment = {
  LK1_BOOKED_OPERATION_RECEIVER_ENABLED: 'true',
  BOOKED_OPERATION_EXECUTION_ENABLED: 'true',
  LK2_BOOKED_OPERATION_DELEGATION_ISSUER: fixture.claims.admit.iss,
  LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: fixture.claims.admit.aud,
  LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: 'synthetic-training-key',
  LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: keys.publicKey.export({
    type: 'spki',
    format: 'pem',
  }),
  LK1_BOOKED_OPERATION_OWNER_BASE_URL: 'http://127.0.0.1:1880',
  LK1_BOOKED_OPERATION_OWNER_TENANT_KEY: 'iSkq6G',
};
export const globals = {
  crypto,
  vivacrm_access_token: 'synthetic-admin-credential',
  subscriptions_managed_enforcement_product_ids: [],
  subscriptions_lk1_plan_rules: { formatVersion: 1, rules: [] },
  subscriptions_lk1_station_exclusions: { formatVersion: 1, exclusions: [] },
};
export const exercise = {
  id: fixture.ids.providerExerciseId,
  type: { id: 605 },
  direction: { id: 1001 },
  studio: { id: 'fixture-training-studio-1' },
  room: { id: 'fixture-training-room-1' },
  timeFrom: '2035-04-02T12:00:00.000Z',
  timeTo: '2035-04-02T13:00:00.000Z',
  capacity: 8,
  availableClientSubscriptions: [
    {
      clientSubscriptionId: fixture.ids.providerClientSubscriptionId,
      clientId: fixture.ids.providerClientId,
      productId: '9eb8a7a4-c195-492a-95e4-3fb82899ac10',
      name: 'Synthetic academy subscription',
      purchaseDate: '2034-01-01',
    },
  ],
};
export const booking = {
  id: 'fixture-training-booking-1',
  clientId: fixture.ids.providerClientId,
  exerciseId: fixture.ids.providerExerciseId,
  clientSubscriptionId: fixture.ids.providerClientSubscriptionId,
  status: 'CONFIRMED',
  paymentType: 'SUBSCRIPTION',
  exercise: {
    id: fixture.ids.providerExerciseId,
    type: { id: 605 },
    direction: { id: 1001 },
    timeFrom: exercise.timeFrom,
    timeTo: exercise.timeTo,
  },
};
export const page = (content) => ({
  content: structuredClone(content),
  last: true,
  totalElements: content.length,
  number: 0,
  totalPages: 1,
});
export class Harness {
  constructor(options = {}) {
    this.options = options;
    this.now = Date.parse(fixture.requests.admit.preparation.observedAt);
    this.rows = new Map();
    this.calls = [];
    this.bookings = [];
    this.globals = { ...globals, ...options.globals };
    this.env = { ...environment, ...options.env };
    const h = this;
    this.Date = class extends Date {
      constructor(...a) {
        super(...(a.length ? a : [h.now]));
      }
      static now() {
        return h.now;
      }
    };
    this.functions = {};
    for (const mode of ['prepare', 'admit', 'read'])
      this.functions['verify_' + mode] = this.compile(
        trainingRegistrationOwnerSource('verify', mode),
      );
    this.functions.router = this.compile(trainingRegistrationOwnerSource('router'));
    this.functions.canonical = this.compile(trainingOwnerRouterSource());
    this.functions.options = this.compile(
      read('nodered_subscription_booking_nodes/fn_subscription_booking_options.js'),
    );
    this.functions.prepare = this.compile(
      read('nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js'),
    );
    this.functions.finalize = this.compile(
      read('nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js'),
    );
    this.contract = this.compile(
      trainingContractSource() +
        '\nreturn {trHash,trRequest,trCapsule,trTarget,trBinding,trOperationId,trPublicId,trReceipt,trBookingActive};',
    )({});
  }
  compile(s) {
    const fn = new Function('msg', 'env', 'nodeCrypto', 'global', 'Date', s);
    return (msg) =>
      fn(msg, { get: (k) => this.env[k] }, crypto, { get: (k) => this.globals[k] }, this.Date);
  }
  capability(replacements = {}) {
    const functions = { ...this.functions, ...replacements };
    let msg = {
      req: {
        method: 'GET',
        originalUrl: '/lk/subscription-bookings',
        query: {},
        headers: { 'x-training-registration-owner-contract': '1' },
      },
    };
    let step = 'options';
    for (let i = 0; i < 6; i++) {
      const outputs = functions[step](msg),
        index = outputs.findIndex(Boolean);
      msg = outputs[index];
      if (step === 'finalize') return msg;
      if (step === 'options') step = index === 2 ? 'prepare' : index === 1 ? 'canonical' : 'done';
      else if (step === 'prepare')
        step = index === 2 ? 'canonical' : index === 1 ? 'finalize' : 'forbidden';
      else if (step === 'canonical') step = index === 4 ? 'finalize' : 'forbidden';
      if (step === 'done') return msg;
      assert.notEqual(step, 'forbidden', 'capability must not reach provider/DB');
    }
    assert.fail('capability did not finish');
  }
  sign(c) {
    const h = Buffer.from(
      JSON.stringify({
        alg: 'RS256',
        kid: 'synthetic-training-key',
        typ: 'phub-subscription-runtime-actor-delegation+jwt',
      }),
    ).toString('base64url');
    const p = Buffer.from(JSON.stringify(c)).toString('base64url');
    return (
      h +
      '.' +
      p +
      '.' +
      crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), keys.privateKey).toString('base64url')
    );
  }
  message(mode = 'admit', extra = {}, body) {
    const c = {
      ...structuredClone(fixture.claims[mode]),
      iat: Math.floor(this.now / 1000),
      nbf: Math.floor(this.now / 1000),
      exp: Math.floor(this.now / 1000) + 60,
      actor_token_sha256: hash(actor),
      actor_token_expires_at: new Date(this.now + 300000).toISOString(),
      ...extra,
    };
    return {
      req: {
        method: c.method,
        originalUrl: c.path,
        query: {},
        headers: {
          'content-type': 'application/json',
          'x-subscription-actor-token': actor,
          'x-subscription-actor-delegation': this.sign(c),
          'x-correlation-id': c.correlation_id,
        },
      },
      payload:
        body === undefined
          ? mode === 'read'
            ? undefined
            : structuredClone(fixture.requests[mode])
          : body,
    };
  }
  matches(row, query) {
    return Object.entries(query).every(([k, v]) => {
      const x = k.split('.').reduce((o, key) => o?.[key], row);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('$exists' in v) return (x !== undefined) === v.$exists;
        if ('$in' in v) return v.$in.includes(x);
      }
      return JSON.stringify(x) === JSON.stringify(v);
    });
  }
  mongo(msg, kind) {
    if (this.options.beforeMongo) this.options.beforeMongo(msg, kind, this);
    const input = structuredClone(msg.payload);
    this.calls.push({
      kind,
      input: structuredClone(input),
      step: msg._subscriptionBooking?.step || msg._trainingRegistration?.step,
    });
    delete msg.error;
    if (kind === 'find') {
      msg.payload = [...this.rows.values()]
        .filter((row) => this.matches(row, input))
        .map((row) => structuredClone(row));
      return;
    }
    if (kind === 'insert') {
      if (this.rows.has(input._id)) {
        msg.error = { code: 11000 };
        msg.payload = {};
        return;
      }
      this.rows.set(input._id, input);
      msg.payload = { acknowledged: true, insertedId: input._id };
      return;
    }
    const [query, update] = input;
    const row = [...this.rows.values()].find((row) => this.matches(row, query));
    if (row) {
      Object.assign(row, structuredClone(update.$set || {}));
      for (const k of Object.keys(update.$unset || {})) delete row[k];
      for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
    }
    msg.payload = {
      acknowledged: true,
      matchedCount: row ? 1 : 0,
      modifiedCount: row ? 1 : 0,
      upsertedCount: 0,
      upsertedId: null,
    };
    if (this.options.loseMongoAck && this.options.loseMongoAck === msg._subscriptionBooking?.step) {
      msg.error = { code: 'SYNTHETIC_ACK_LOSS' };
      delete this.options.loseMongoAck;
    }
  }
  http(msg) {
    if (this.options.beforeHttp) this.options.beforeHttp(msg, this);
    const url = msg.url,
      step = msg._subscriptionBooking?.step || msg._trainingRegistration?.step;
    this.calls.push({
      kind: 'http',
      method: msg.method,
      url,
      step,
      body: structuredClone(msg.payload),
    });
    delete msg.error;
    msg.statusCode = 200;
    msg.responseUrl = url;
    if (url.startsWith('http://127.0.0.1:1880')) {
      if (msg.method === 'GET') {
        msg.payload = this.options.oldCapability
          ? {
              contractVersion: 1,
              owner: 'LK1_SUBSCRIPTION_BOOKING_OWNER',
              policy: 'ATOMIC_MANAGED_V1',
            }
          : this.capability(this.options.mixedCapability).payload;
        return;
      }
      const inner = {
        req: {
          method: 'POST',
          originalUrl: '/lk/subscription-bookings',
          body: structuredClone(msg.payload),
          headers: {
            authorization: msg.headers.Authorization,
            'idempotency-key': msg.payload.operationId,
          },
        },
        payload: msg.payload,
      };
      const out = this.canonical(inner);
      msg.statusCode = out.statusCode;
      msg.payload = out.payload;
      msg.responseUrl = url;
      if (this.options.loseCallback) {
        msg.error = { code: 'SYNTHETIC_ACK_LOSS' };
        this.options.loseCallback = false;
      }
      return;
    }
    if (msg.method === 'POST') {
      assert.equal(
        url,
        'https://api.vivacrm.ru/api/v2/exercises/' + fixture.ids.providerExerciseId + '/bookings',
      );
      assert.equal(msg.payload.paymentType, 'SUBSCRIPTION');
      this.bookings = [structuredClone(booking)];
      msg.statusCode = 201;
      msg.payload = { id: booking.id };
      if (this.options.loseProviderAck) {
        msg.error = { code: 'SYNTHETIC_ACK_LOSS' };
        msg.statusCode = 0;
        msg.payload = undefined;
        this.options.loseProviderAck = false;
      }
      return;
    }
    assert.equal(msg.method, 'GET');
    if (url.endsWith('/profile'))
      msg.payload = {
        id: fixture.ids.providerClientId,
        phone: '+12025550101',
        ...this.options.profile,
      };
    else if (url.includes('/exercises?')) msg.payload = page(this.options.schedule || [exercise]);
    else if (url.includes('/exercises/'))
      msg.payload = structuredClone(this.options.exercise || exercise);
    else if (url.includes('/bookings/history')) msg.payload = page(this.options.history || []);
    else if (url.includes('/bookings?')) msg.payload = page(this.options.bookings || this.bookings);
    else assert.fail('unexpected HTTP ' + url);
    if (this.options.onHttp) this.options.onHttp(msg, this);
  }
  canonical(msg) {
    let outputs = this.functions.prepare(msg);
    if (outputs[1]) return outputs[1];
    msg = outputs[0];
    this.http(msg);
    for (let i = 0; i < 80; i++) {
      outputs = this.functions.canonical(msg);
      const index = outputs.findIndex(Boolean);
      assert.ok(index >= 0);
      msg = outputs[index];
      if (index === 4) return this.functions.finalize(msg)[1];
      if (index === 0) this.http(msg);
      else if (index === 1) this.mongo(msg, 'find');
      else if (index === 2) this.mongo(msg, 'insert');
      else if (index === 3) this.mongo(msg, 'update');
      else assert.fail('forbidden canonical output ' + index);
    }
    assert.fail('canonical did not finish');
  }
  run(mode = 'admit', extra = {}, body) {
    let outputs = this.functions['verify_' + mode](this.message(mode, extra, body));
    if (outputs[1]) return outputs[1];
    let msg = outputs[0];
    for (let i = 0; i < 80; i++) {
      outputs = this.functions.router(msg);
      const index = outputs.findIndex(Boolean);
      assert.ok(index >= 0);
      msg = outputs[index];
      if (index === 4) return msg;
      if (index === 0) this.mongo(msg, 'find');
      else if (index === 1) this.mongo(msg, 'insert');
      else if (index === 2) this.mongo(msg, 'update');
      else if (index === 3) this.http(msg);
    }
    assert.fail('outer did not finish');
  }
}
