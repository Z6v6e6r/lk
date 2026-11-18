import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { buildBookingPaymentCancellationNodes, BOOKING_PAYMENT_CANCEL_IDS as ids, BOOKING_PAYMENT_CANCEL_PATH as route } from '../lib/bookingPaymentCancellationFlow.mjs';
import { paymentAttemptReleased } from '../lib/bookingPaymentAttempt.mjs';
import { runBookingPaymentCancelRequest } from '../lib/bookingPaymentAttemptWorker.mjs';
import { splitBookingPaymentAttemptSource } from '../prepare_booking_payment_lifecycle.mjs';
import { fixture } from './fixtures/bookingPaymentCancellationFixtures.mjs';
const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
const get = (v, key) => key.split('.').reduce((x, k) => x?.[k], v);
const match = (d, q) => Object.entries(q).every(([k, v]) => k === '$expr'
  ? JSON.stringify(d) === JSON.stringify(v.$eq[1].$literal)
  : v && typeof v === 'object' && '$ne' in v ? get(d, k) !== v.$ne
  : v && typeof v === 'object' && '$exists' in v ? (get(d, k) !== undefined) === v.$exists : get(d, k) === v);
test('real isolated Node-RED: authenticated cancellation request/status, no startup calls, single financial owner',
  { skip: !runtimeRoot, timeout: 30000 }, async () => {
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'), express = require('express');
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-payment-cancel-runtime-'));
    const f = fixture(), op = f.docs.get(f.op._id), now = Date.now();
    op.createdAt = new Date(now - 120000).toISOString();
    op.lk1.transactionAttemptedAt = op.createdAt;
    Object.assign(op.lk1.checkout, { createdAt: op.createdAt, expiresAt: new Date(now + 780000).toISOString() });
    op.lk1.target.startsAt = new Date(now + 7200000).toISOString();
    delete f.game.metadata.splitPayment.payments[0].operationId;
    f.game.waitlist = [{ id: 'actor', name: 'Synthetic player' }];
    const cohort = new Date(now - 86400000).toISOString();
    const vars = { PADLHUB_PLATFORM_TENANT_KEY: 'tenant', LK1_UNPAID_CANCEL_MODE: 'ENFORCE_NEW', LK1_UNPAID_CANCEL_COHORT_FROM: cohort };
    const beforeEnv = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]])); Object.assign(process.env, vars);
    let serviceReads = 0, profileReads = 0, dbReads = 0, dbWrites = 0, providerWrites = 0;
    const db = {
      async findOne(q) { dbReads++; return structuredClone([...f.docs.values()].find(d => match(d, q)) || null); },
      async updateOne(q, u, options) {
        dbWrites++; assert.equal(options.writeConcern.w, 'majority'); assert.equal(options.writeConcern.j, true);
        const d = [...f.docs.values()].find(d => match(d, q));
        if (u.$setOnInsert) {
          if (d) return { acknowledged: true, matchedCount: 1, modifiedCount: 0 };
          f.docs.set(q._id, structuredClone(u.$setOnInsert)); return { acknowledged: true, upsertedCount: 1, modifiedCount: 0 };
        }
        if (!d) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        for (const [key, v] of Object.entries(u.$set)) {
          const keys = key.split('.'); let target = d;
          for (const k of keys.slice(0, -1)) target = target[k] ||= {};
          target[keys.at(-1)] = structuredClone(v);
        }
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      },
    };
    const app = express(), server = http.createServer(app);
    RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: '/red', httpNodeRoot: '/', disableEditor: true,
      functionGlobalContext: { vivacrm_access_token: 'synthetic-service', vivacrm_token_expires_at: now + 3600000 },
      logging: { console: { level: 'off' } } });
    RED.nodes.registerType('payment-cancel-profile-fixture', function(config) {
      RED.nodes.createNode(this, config);
      this.on('input', (msg, send, done) => {
        assert.equal(msg.method, 'GET');
        if (msg.url.endsWith('/api/v1/transactions/transaction')) {
          serviceReads++; assert.equal(msg.headers.Authorization, 'Bearer synthetic-service');
          msg.payload = { id: 'transaction', clientId: 'actor', exerciseId: 'exercise', toPay: 100000, status: 'PAID',
            products: [{ id: 'product', paymentBookingIds: ['booking'] }] };
          msg.statusCode = 200; msg.responseUrl = msg.url; send(msg); done(); return;
        }
        profileReads++; assert.match(msg.url, /\/profile$/);
        const foreign = msg.headers.Authorization === 'Bearer synthetic-other';
        msg.payload = { id: foreign ? 'other' : 'actor' }; msg.statusCode = 200; msg.responseUrl = msg.url;
        send(msg); done();
      });
    });
    RED.nodes.registerType('payment-cancel-db-fixture', function(config) {
      RED.nodes.createNode(this, config);
      this.on('input', async (msg, send, done) => {
        try {
          if (config.operation === 'canonicalUpdate') {
            assert.ok(match(f.game, msg.query), 'canonical cleanup must retain its exact revision fence');
            const u = msg.payload;
            for (const [key, value] of Object.entries(u.$set)) {
              const keys = key.split('.'); let target = f.game;
              for (const k of keys.slice(0, -1)) target = target[k] ||= {};
              target[keys.at(-1)] = structuredClone(value);
            }
            f.game.revision += u.$inc.revision;
            f.game.audit.events = [...(f.game.audit.events || []), ...u.$push['audit.events'].$each];
            msg.payload = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
          } else if (config.operation === 'updateOne') msg.payload = await db.updateOne(...msg.payload);
          else {
            dbReads++; const q = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
            msg.payload = (config.collection === 'lk_games' ? [f.game] : [...f.docs.values()]).filter(d => match(d, q)).map(d => structuredClone(d));
          }
          send(msg); done();
        } catch (e) { done(e); }
      });
    });
    app.use('/red', RED.httpAdmin); app.use(RED.httpNode);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (method, payload = f.input, token = 'synthetic-session') => fetch(base + route
      + (method === 'GET' ? '?' + new URLSearchParams(payload) : ''), { method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(5000) });
    try {
      await RED.start();
      const nodes = buildBookingPaymentCancellationNodes('tab', 'db', 'cancel-cleanup-prepare');
      for (const n of nodes) {
        assert.equal(typeof n.x, 'number'); assert.equal(typeof n.y, 'number');
        if (n.id === ids.profile) n.type = 'payment-cancel-profile-fixture';
        if ([ids.find, ids.update, ids.games].includes(n.id)) n.type = 'payment-cancel-db-fixture';
      }
      const func = (id, file, outputs, wires, prefix = '') => ({ id, type: 'function', z: 'tab', x: 10, y: 10,
        name: id, func: prefix + fs.readFileSync(file, 'utf8'), outputs, wires });
      const mongo = (id, operation, collection, owner) => ({ id, type: 'payment-cancel-db-fixture', z: 'tab', x: 10, y: 10,
        operation, collection, wires: [[owner]] });
      const namespace = splitBookingPaymentAttemptSource();
      nodes.push(
        func('cancel-cleanup-prepare', 'scripts/nodered_games_nodes/fn_split_cleanup_prepare.js', 3,
          [['cancel-task'], [ids.response], [ids.response]]),
        { id: 'cancel-task', type: 'function', z: 'tab', x: 10, y: 10, outputs: 1,
          func: 'if(msg.payload.length!==1)throw Error("Expected one cancellation task");msg.payload=msg.payload[0];return msg;', wires: [['cancel-cleanup-router']] },
        func('cancel-cleanup-router', 'scripts/nodered_games_nodes/fn_split_cleanup_router.js', 8,
          [[], ['cancel-game-write'], [], [], [], [], [], ['cancel-native-read']], namespace),
        mongo('cancel-native-read', 'find', 'lk_subscription_daily_booking_ops', 'cancel-cleanup-router'),
        mongo('cancel-game-write', 'canonicalUpdate', 'lk_games', 'cancel-cleanup-ack'),
        func('cancel-cleanup-ack', 'scripts/nodered_games_nodes/fn_split_cleanup_write_ack.js', 6,
          [['cancel-game-read'], [ids.response], [], [], [], []], namespace),
        mongo('cancel-game-read', 'find', 'lk_games', 'cancel-cleanup-ack'),
      );
      const deployed = await fetch(base + '/red/flows', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2' },
        body: JSON.stringify({ flows: [{ id: 'tab', type: 'tab', label: 'Isolated cancellation fixture' }, ...nodes] }) });
      assert.equal(deployed.status, 200);
      // A v2 ACK/event alone is insufficient. Observe the actual runtime nodes.
      for (let i = 0; i < 500 && ![ids.handler, ids.post, ids.get].every(id => RED.nodes.getNode(id)); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(RED.nodes.getNode(ids.handler)); assert.ok(RED.nodes.getNode(ids.post));
      assert.equal(profileReads, 0); assert.equal(dbReads, 0); assert.equal(dbWrites, 0); assert.equal(providerWrites, 0);
      assert.equal((await request('POST', f.input, null)).status, 401);
      const first = await request('POST'); assert.equal(first.status, 202); const body = await first.json();
      assert.equal(body.accepted, true); assert.equal(body.limitReleased, false); assert.equal(body.paymentUrl, null);
      assert.equal(f.docs.get(op._id).state, 'CONFIRMED'); assert.equal(providerWrites, 0);
      assert.equal((await (await request('POST')).json()).state, 'CLOSING');
      const writes = dbWrites;
      assert.equal((await (await request('GET')).json()).state, 'CLOSING'); assert.equal(dbWrites, writes);
      assert.equal((await request('POST', f.input, 'synthetic-other')).status, 404); assert.equal(dbWrites, writes);
      const transaction = { id: 'transaction', clientId: 'actor', status: 'UNPAID', toPay: 100000,
        products: [{ id: 'product', paymentBookingIds: ['booking'] }], cardPaymentInfo: { status: 'NEW' } };
      const booking = { id: 'booking', clientId: 'actor', exerciseId: 'exercise', paymentType: 'ON_PLACE', isCancelled: false };
      const provider = { async readTransaction() { return structuredClone(transaction); },
        async readBooking() { return structuredClone(booking); },
        async readCancelOptions() { return { bookingId: 'booking', cancellationOptions: { cancellationOnly: { available: true } } }; },
        async expireTransaction() { providerWrites++; transaction.cardPaymentInfo = { status: 'REJECTED', declineOutcome: 'EXPIRED' }; },
        async cancelBooking() { providerWrites++; booking.isCancelled = true; } };
      const job = [...f.docs.values()].find(d => d.kind === 'BOOKING_PAYMENT_CANCEL_REQUEST_V1');
      const result = await runBookingPaymentCancelRequest({ job: structuredClone(job), operations: db, provider,
        tenantKey: 'tenant', cohortFrom: cohort, mode: 'ENFORCE_NEW' });
      assert.equal(result.state, 'CLOSED'); assert.equal(providerWrites, 2); assert.ok(paymentAttemptReleased(f.docs.get(op._id)));
      const pendingRoster = await (await request('GET')).json();
      assert.equal(pendingRoster.state, 'CLOSING'); assert.equal(pendingRoster.financiallyClosed, true);
      assert.equal(pendingRoster.needsFinalization, true); assert.equal(pendingRoster.limitReleased, false);
      assert.equal(f.game.waitlist.length, 1);
      const finalized = await request('POST'); const finalBody = await finalized.json();
      assert.equal(finalized.status, 200, JSON.stringify(finalBody)); assert.equal(finalBody.cancelledInLk, true);
      assert.equal(f.game.waitlist.length, 0); assert.equal(f.game.metadata.splitPayment.payments[0].status, 'EXPIRED');
      assert.equal(providerWrites, 2, 'canonical-only finalization must not issue another provider command');
      const closed = await (await request('GET')).json(); assert.equal(closed.cancelled, true); assert.equal(closed.limitReleased, true);
      assert.equal((await (await request('POST')).json()).state, 'CLOSED'); assert.equal(providerWrites, 2);
      // A PAID game projection is insufficient: the real function performs a
      // separate, bound service GET before reporting that cancellation lost.
      f.docs.clear(); f.docs.set(f.head._id, { ...f.head, createdAt: op.createdAt });
      f.game.metadata.splitPayment.payments[0].status = 'PAID';
      const paid = await (await request('GET')).json();
      assert.equal(paid.state, 'PAID'); assert.equal(paid.limitReleased, false);
      assert.equal(serviceReads, 1); assert.equal(providerWrites, 2);
    } finally {
      await RED.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fs.rmSync(userDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(beforeEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
