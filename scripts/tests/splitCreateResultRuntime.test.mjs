import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { composeSplitCreateResultFlow, SPLIT_CREATE_RESULT_IDS as ids } from '../lib/splitCreateResultFlow.mjs';
import { SPLIT_CREATE_RECEIPT_ANCHOR, SPLIT_CREATE_TIMING_TARGETS as targets } from '../lib/splitCreateTiming.mjs';

const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
test('real Node-RED GET recovery, CORS, crypto libs, receipt guards and inverse; zero provider writes',
  { skip: !runtimeRoot, timeout: 30000 }, async () => {
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'), express = require('express');
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-create-result-runtime-'));
    const uid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
    const opId = 'lk-split-create-synthetic';
    const createPayload = { directionId: 4588, typeId: 1613, timeFrom: '2035-01-02T07:00+03:00',
      timeTo: '2035-01-02T08:00+03:00', roomId: uid(4), maxClientsCount: 4 };
    const target = { category: 'GAME', eventId: uid(5), stationId: uid(3), roomId: uid(4),
      startsAt: createPayload.timeFrom, durationMinutes: 60, basePriceMinor: 75000 };
    const q = { rule: { planKey: 'synthetic' }, purchaseDate: '2035-01-01', createPayload, target,
      decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } } };
    q.fingerprint = JSON.stringify({ tenantKey: 'iSkq6G', actorClientId: uid(1), clientSubscriptionId: uid(2),
      action: 'CREATE_GAME', rule: q.rule, purchaseDate: q.purchaseDate, createPayload,
      target: { ...target, eventId: `preflight:${opId}` } });
    const op = { _id: `lk1-product:${JSON.stringify(['iSkq6G', uid(1), opId])}`, tenantKey: 'iSkq6G',
      actorClientId: uid(1), operationId: opId, clientSubscriptionId: uid(2), category: 'open_game',
      state: 'CONFIRMED', exerciseId: uid(5), bookingId: uid(6), lk1: q,
      confirmedAt: '2035-01-01T09:00:00Z', updatedAt: '2035-01-01T09:00:00Z',
      createReceipt: { schemaVersion: 1, paymentRef: 'original-ref', deadlineAt: '2035-01-01T09:25:00Z', assembleDeadlineAt: '2035-01-01T04:00:00Z' } };
    let cancelled = false, failTransport = false, providerReads = 0, providerWrites = 0, dbReads = 0;
    let transactionStatus = 'UNPAID', checkout = null;
    const readPaths = [];
    const logs = [];
    const provider = http.createServer((req, res) => {
      if (req.method !== 'GET') { providerWrites++; res.writeHead(405); res.end(); return; }
      if (failTransport) { req.socket.destroy(); return; }
      providerReads++; readPaths.push(req.url); res.setHeader('Content-Type', 'application/json');
      const body = req.url === '/api/v1/transactions/' + uid(7) ? {
        id: uid(7), status: transactionStatus, client: { id: uid(1) }, toPay: 21000,
        products: [{ id: uid(8), paymentBookingIds: [uid(6)] }],
        cardPaymentInfo: { status: transactionStatus === 'PAID' ? 'CONFIRMED' : 'NEW', paymentUrl: checkout },
        paymentDate: transactionStatus === 'PAID' ? new Date(Date.now() - 60_000).toISOString() : null,
      } : req.url.endsWith('/profile') ? { id: req.headers.authorization === 'Bearer synthetic-foreign' ? uid(9) : uid(1) }
        : req.url.includes('/bookings?') ? { content: [{ id: uid(6), client: { id: uid(1) }, clientSubscriptionId: uid(2), paymentType: 'SUBSCRIPTION', isCancelled: cancelled, spot: 1 }], number: 0, last: true, totalElements: 1 }
          : { id: uid(5), studio: { id: uid(3) }, room: { id: uid(4) }, canceled: false,
            maxClientsCount: 4, timeFrom: createPayload.timeFrom, timeTo: createPayload.timeTo };
      res.end(JSON.stringify(body));
    });
    const app = express(), server = http.createServer(app);
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: '/red', httpNodeRoot: '/', disableEditor: true,
      functionExternalModules: true, httpNodeCors: { origin: '*', methods: 'GET,POST,PUT,PATCH,DELETE,OPTIONS', allowedHeaders: 'Authorization,Content-Type' },
      functionGlobalContext: { vivacrm_access_token: 'synthetic-service', vivacrm_token_expires_at: Date.now() + 3600000 },
      logging: { console: { level: 'off' }, fixture: { level: 'warn', handler: () => entry => logs.push(entry) } } });
    app.use('/red', RED.httpAdmin); app.use(RED.httpNode);
    const deployed = new Set();
    RED.events.on('runtime-event', e => { if (e.id === 'runtime-deploy') deployed.add(e.payload.revision); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const fetchLocal = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(10000) });
    async function admin(method, body) {
      const r = await fetchLocal('/red/flows', { method, headers: { 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2',
        'Node-RED-Deployment-Type': 'nodes' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(r.status, 200); const data = await r.json();
      if (method === 'POST') {
        for (let i = 0; i < 500 && !deployed.has(data.rev); i++) await new Promise(r => setTimeout(r, 10));
        assert.ok(deployed.has(data.rev));
      }
      return data;
    }
    try {
      let bootstrapTimer;
      const bootstrap = new Promise((resolve, reject) => {
        bootstrapTimer = setTimeout(() => reject(Error('BOOTSTRAP_TIMEOUT')), 10000);
        RED.events.once('flows:started', () => { clearTimeout(bootstrapTimer); resolve(); });
      });
      await RED.start(); await bootstrap;
      RED.nodes.registerType('split-fixture-find', function(config) {
        RED.nodes.createNode(this, config);
        this.on('input', (msg, send, done) => {
          dbReads++;
          assert.equal(msg.payload[1].readConcern.level, 'majority'); assert.equal(msg.payload[1].limit, 2);
          msg.payload = msg.payload[0].actorClientId === uid(1) ? [structuredClone(op)] : [];
          send(msg); done();
        });
      });
      const funcs = [
        `msg._splitCtx = { action: msg.req.params.action, step: 'pricing_policy', paymentRef: 'synthetic-ref', deadlineAt: '2035-01-01T09:25:00Z', assembleDeadlineAt: '2035-01-01T04:00:00Z' }; return msg;`,
        `msg._subscriptionBooking = { step: 'profile' }; return msg;`,
        `const ctx = { managedAction: msg._splitCtx.action === 'create' ? 'CREATE_GAME' : 'JOIN_GAME', lk1: {} }; const record = {\n${SPLIT_CREATE_RECEIPT_ANCHOR}\n}; msg.payload = record; return msg;`,
        `return msg;`,
      ];
      const source = [{ id: 'tab', type: 'tab', label: 'synthetic recovery fixture' },
        { id: 'original-create', type: 'http in', z: 'tab', method: 'post', url: '/lk/games/split/create', wires: [[targets[0]]] },
        { id: 'timing-probe', type: 'http in', z: 'tab', method: 'get', url: '/timing/:action', wires: [[targets[0]]] },
        ...targets.map((id, i) => ({ id, type: 'function', z: 'tab', func: funcs[i], outputs: 1, libs: [], wires: [[targets[i + 1] || 'probe-response']] })),
        { id: 'probe-response', type: 'http response', z: 'tab', wires: [] },
        { id: 'lk_subscription_booking_find_20260804', type: 'split-fixture-find', clientNode: 'db', z: 'tab', wires: [] }];
      for (const n of source) if (n.type !== 'tab') Object.assign(n, { x: 0, y: 0 });
      // Candidate requires the real owning Mongo node shape, but it is never started.
      const buildSource = structuredClone(source);
      Object.assign(buildSource.at(-1), { type: 'mongodb4' });
      const bytes = Buffer.from(JSON.stringify(buildSource));
      const candidate = JSON.parse(composeSplitCreateResultFlow(bytes, createHash('sha256').update(bytes).digest('hex')).candidateBytes);
      candidate.find(n => n.id === 'lk_subscription_booking_find_20260804').type = 'split-fixture-find';
      candidate.find(n => n.id === ids.find).type = 'split-fixture-find';
      // Real HTTP request node, with a fixture-only loopback rewrite before transport.
      candidate.find(n => n.id === ids.handler).wires[0] = ['fixture-loopback'];
      candidate.push({ id: 'fixture-loopback', type: 'function', z: 'tab', x: 0, y: 0, outputs: 1,
        func: `if (msg.method !== 'GET' || !msg.url.startsWith('https://api.vivacrm.ru/')) throw Error('NETWORK_SCOPE'); msg.url = 'http://127.0.0.1:${provider.address().port}/' + msg.url.slice('https://api.vivacrm.ru/'.length); return msg;`, wires: [[ids.http]] });
      const confirmation = fs.readFileSync('scripts/nodered_games_nodes/fn_game_payment_confirm_router.js', 'utf8');
      const fixtureNode = (id, type, more) => ({ id, type, z: 'tab', x: 0, y: 0, ...more });
      candidate.push(
        fixtureNode('confirm-in', 'http in', { method: 'post', url: '/fixture/confirm', wires: [['confirm-draft']] }),
        fixtureNode('confirm-draft', 'function', { outputs: 1, wires: [['confirm-router']], func: `
          msg._gamePaymentConfirmCtx = { step: 'draft_lookup', paymentRef: 'original-ref' };
          msg.payload = [{
            id: 'synthetic-game', tenantKey: 'fixture', revision: 1, updatedAt: new Date().toISOString(), status: 'PAYMENT_PENDING',
            organizer: { id: '${uid(1)}' }, payment: { amount: 210, paymentRef: 'original-ref' },
            invite: { maxPlayers: 4 },
            booking: { studioId: '${uid(3)}', roomId: '${uid(4)}', exerciseId: '${uid(5)}',
              timeFromIso: '2035-01-02T07:00:00+03:00', timeToIso: '2035-01-02T08:30:00+03:00' },
            metadata: { source: 'games_split_widget', splitPayment: { selectedPaymentMode: 'subscription', shareCount: 4,
              clientSubscriptionId: '${uid(2)}', productId: '${uid(8)}', createOperationId: '${opId}',
              payments: [{ role: 'ORGANIZER', paymentRef: 'original-ref', clientId: '${uid(1)}', bookingId: '${uid(6)}',
                transactionId: '${uid(7)}', amount: 210, amountMinor: 21000 }] } },
          }];
          return msg;` }),
        fixtureNode('confirm-router', 'function', { outputs: 6, func: confirmation,
          wires: [['confirm-loopback'], [], ['probe-response'], [], ['confirm-claim-probe'], []] }),
        fixtureNode('confirm-loopback', 'function', { outputs: 1, wires: [['confirm-http']], func: `
          const prefix = 'http://127.0.0.1:1880/lk/games/split/create-result?operationId=';
          if (msg.method !== 'GET' || msg.url !== prefix + '${opId}' || msg.followRedirects !== false) throw Error('NETWORK_SCOPE');
          msg.url = '${base}' + msg.url.slice('http://127.0.0.1:1880'.length);
          return msg;` }),
        fixtureNode('confirm-http', 'http request', { method: 'use', ret: 'obj', wires: [['confirm-router']] }),
        fixtureNode('confirm-claim-probe', 'function', { outputs: 1, wires: [['probe-response']], func: `
          msg.statusCode = 200;
          msg.headers = { 'Content-Type': 'application/json' };
          msg.payload = { claim: msg.payload[0]._id, step: msg._gamePaymentConfirmCtx.step };
          return msg;` }),
      );
      await admin('POST', { rev: (await admin('GET')).rev, flows: source });
      const unchanged = RED.nodes.getNode('probe-response');
      await admin('POST', { rev: (await admin('GET')).rev, flows: candidate });
      assert.strictEqual(RED.nodes.getNode('probe-response'), unchanged);
      assert.equal(providerReads, 0); assert.equal(dbReads, 0);
      const preflight = await fetchLocal('/lk/games/split/create-result?operationId=' + opId, { method: 'OPTIONS',
        headers: { Origin: 'https://cabinet.example.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
      assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
      const endpoint = '/lk/games/split/create-result?operationId=' + opId;
      const auth = { Authorization: 'Bearer synthetic-user' };
      const unauth = await fetchLocal(endpoint); assert.equal(unauth.status, 401); assert.equal(providerReads, 0);
      const r = await fetchLocal(endpoint, { headers: auth }); const result = await r.json();
      assert.equal(r.status, 200, JSON.stringify(logs)); assert.equal(result.state, 'CONFIRMED');
      assert.equal(result.paymentRef, 'original-ref'); assert.equal(result.shareAmount, 750); assert.equal(result.toPay, 0);
      assert.equal(dbReads, 2); assert.equal(providerReads, 3); assert.equal(providerWrites, 0);
      checkout = 'https://payment.example.test/original';
      target.currency = 'RUB';
      createPayload.timeTo = '2035-01-02T08:30+03:00';
      target.durationMinutes = 90;
      q.decision.benefit = { finalPriceMinor: 21000, currency: 'RUB' };
      q.fingerprint = JSON.stringify({ tenantKey: 'iSkq6G', actorClientId: uid(1), clientSubscriptionId: uid(2),
        action: 'CREATE_GAME', rule: q.rule, purchaseDate: q.purchaseDate, createPayload,
        target: { ...target, eventId: `preflight:${opId}` } });
      Object.assign(q, { transactionId: uid(7), transactionAttemptedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        transactionIntent: { bookingId: uid(6), actorClientId: uid(1), studioId: uid(3), chargeMinor: 21000, productId: uid(8) },
        checkout: { transactionId: uid(7), toPayMinor: 21000, paymentUrl: checkout } });
      const unpaid = await fetchLocal(endpoint, { headers: auth });
      assert.equal(unpaid.status, 200, JSON.stringify(logs));
      assert.equal((await unpaid.json()).paymentUrl, checkout);
      transactionStatus = 'PAID';
      const paid = await fetchLocal(endpoint, { headers: auth });
      assert.equal(paid.status, 200, JSON.stringify(logs));
      const paidBody = await paid.json();
      assert.equal(paidBody.settlementState, 'PAID');
      assert.equal(paidBody.paymentUrl, null);
      assert.equal(paidBody.toPayMinor, 21000);
      assert.equal(paidBody.transactionId, uid(7));
      assert.equal(readPaths.filter(path => path === '/api/v1/transactions/' + uid(7)).length, 2);
      const confirmationResponse = await fetchLocal('/fixture/confirm', { method: 'POST', headers: auth });
      assert.equal(confirmationResponse.status, 200, JSON.stringify(logs));
      assert.deepEqual(await confirmationResponse.json(), { claim: 'viva_transaction:' + uid(7), step: 'claim_write' });
      const wrongActor = await fetchLocal('/fixture/confirm', {
        method: 'POST', headers: { Authorization: 'Bearer synthetic-foreign' },
      });
      assert.equal(wrongActor.status, 409);
      assert.equal((await wrongActor.json()).code, 'GAME_PAYMENT_PENDING');
      assert.equal(providerWrites, 0);
      assert.equal((await fetchLocal(endpoint, { headers: { Authorization: 'Bearer synthetic-foreign' } })).status, 202);
      cancelled = true; assert.equal((await fetchLocal(endpoint, { headers: auth })).status, 202);
      failTransport = true;
      const failed = await fetchLocal(endpoint, { headers: auth }); assert.equal(failed.status, 202);
      assert.doesNotMatch(JSON.stringify(await failed.json()), /ECONN|synthetic-user|synthetic-service|http:/);
      failTransport = false;
      const create = await (await fetchLocal('/timing/create')).json(); assert.equal(create.createReceipt.schemaVersion, 1);
      const join = await (await fetchLocal('/timing/join')).json(); assert.equal(join.createReceipt, undefined);
      const timings = logs.map(e => e.msg).filter(x => typeof x === 'string' && x.includes('SPLIT_CREATE_STAGE_TIMING_V1'));
      assert.ok(timings.length > 0, 'actual crypto libs must mint traces');
      assert.doesNotMatch(timings.join(''), /synthetic-user|synthetic-service|original-ref|11111111111/);
      await admin('POST', { rev: (await admin('GET')).rev, flows: source });
      assert.strictEqual(RED.nodes.getNode('probe-response'), unchanged);
      assert.equal((await fetchLocal(endpoint, { headers: auth })).status, 404);
      assert.equal(providerWrites, 0);
    } finally {
      await RED.stop(); server.closeAllConnections(); provider.closeAllConnections();
      await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]);
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });
