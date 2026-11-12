import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { RESULT_AUTH_IDS as ids, RESULT_AUTH_ROUTES, patchResultAuthTransport, sha256 } from '../lib/resultAuthTransport.mjs';
import { authFlow } from './fixtures/resultAuthTransportFlow.mjs';

const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (file) => fs.readFileSync(new URL(`../nodered_result_nodes/${file}`, import.meta.url), 'utf8');

test('isolated Node-RED 4.0.9: real profile HTTP/Catch/response closes once, including the 10s deadline',
  { skip: !runtimeRoot, timeout: 90000 }, async (t) => {
    // This file runs in its own Node test process. Block non-fixture sockets,
    // including any accidental production URL or inherited HTTP proxy route.
    const evidencePath = process.env.RESULT_AUTH_RUNTIME_EVIDENCE;
    if (evidencePath && fs.existsSync(evidencePath)) throw new Error('Evidence destination must be new');
    let passedSubtests = 0, failedSubtests = 0, evidence;
    const check = async (name, fn) => t.test(name, async () => {
      try { await fn(); passedSubtests++; }
      catch (err) { failedSubtests++; throw err; }
    });
    const connect = net.Socket.prototype.connect;
    const allowedPorts = new Set(); let blockedConnections = 0;
    net.Socket.prototype.connect = function (...args) {
      const values = Array.isArray(args[0]) ? args[0] : args;
      const options = values[0];
      const host = typeof options === 'object' ? options.host : (typeof values[1] === 'string' ? values[1] : 'localhost');
      const port = typeof options === 'object' ? options.port : options;
      if (host !== '127.0.0.1' || !allowedPorts.has(Number(port))) {
        blockedConnections++;
        throw new Error('Runtime fixture blocked a non-fixture socket');
      }
      return connect.apply(this, args);
    };
    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
    const originalProxy = new Map(proxyKeys.map((key) => [key, process.env[key]]));
    proxyKeys.forEach((key) => { delete process.env[key]; });
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'); const express = require('express');
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-profile-runtime-'));
    fs.chmodSync(userDir, 0o700);
    const app = express(); const server = http.createServer(app);
    const counters = new Map(); const logs = []; const deployed = new Set();
    let scenario = 'valid', stubCalls = 0, lateAttempts = 0, stubListening = false;
    const timers = new Set();
    const actor = { id: 'fixture-player', phoneNorm: null, verified: true };
    const stub = http.createServer((req, res) => {
      stubCalls++; req.resume();
      const profile = req.method === 'POST'
        ? { ok: true, actor: { ...actor, clientId: actor.id, subject: 'fixture-subject', source: 'cup-keycloak-jwt' } }
        : { id: actor.id };
      const reply = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(profile)); };
      if (scenario === 'reset') { req.socket.destroy(); return; }
      if (scenario === 'late') {
        res.on('error', () => {});
        const timer = setTimeout(() => {
          timers.delete(timer); lateAttempts++;
          // A real late upstream response after the request has timed out.
          res.end(JSON.stringify(profile));
        }, 12000);
        timers.add(timer); return;
      }
      if (scenario === 'malformed') { res.setHeader('Content-Type', 'application/json'); res.end('not-json fixture-secret'); return; }
      if (scenario.startsWith('status-')) { res.statusCode = Number(scenario.slice(7)); reply(); return; }
      reply();
    });
    const listen = (s, port = 0) => new Promise((resolve, reject) => {
      s.once('error', reject); s.listen(port, '127.0.0.1', () => { s.removeListener('error', reject); resolve(); });
    });
    const close = (s) => new Promise((resolve) => {
      s.closeAllConnections(); s.close(() => resolve());
    });
    const getCounters = (msg) => counters.get(msg.req?.headers?.['x-runtime-case']);
    const requests = [];
    const call = (key, method, route, { auth = true, foreignActor = false, deadline = 15000 } = {}) => new Promise((resolve, reject) => {
      const data = JSON.stringify({ actor: { id: foreignActor ? 'fixture-foreign' : actor.id }, original: 'fixture-secret' });
      const start = performance.now();
      const c = { responseInputs: 0, finishes: 0, catches: 0, resolves: 0, business: 0, httpInputs: 0, budgets: [], preservedEnvelope: true, cleanFailure: true };
      counters.set(key, c);
      let aborted = false;
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: route.replace(':gameId', 'fixture-game').replace(':sessionId', 'fixture-session'), method,
        agent: false, headers: { 'x-runtime-case': key, ...(auth ? { Authorization: 'Bearer fixture-secret' } : {}),
          ...(method === 'get' ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body, elapsedMs: performance.now() - start, c });
        });
      });
      const timer = setTimeout(() => { aborted = true; req.destroy(); resolve({ aborted: true, c }); }, deadline);
      req.on('error', (err) => { clearTimeout(timer); if (!aborted) reject(err); });
      req.end(method === 'get' ? undefined : data);
    });
    try {
      await listen(stub); const stubPort = stub.address().port; allowedPorts.add(stubPort);
      await close(stub); // Reserve then close: actual ECONNREFUSED, no mock error injection.
      RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: false, httpNodeRoot: '/', disableEditor: true,
        functionExternalModules: false, telemetryEnabled: false,
        editorTheme: { palette: { editable: false, catalogues: [] } },
        externalModules: { autoInstall: false, palette: { allowInstall: false }, modules: { allowInstall: false } },
        logging: { console: { level: 'off' }, fixture: { level: 'warn', handler: () => (entry) => logs.push(entry) } } });
      app.use((req, res, next) => { res.on('finish', () => { const c = counters.get(req.headers['x-runtime-case']); if (c) c.finishes++; }); next(); });
      app.use(RED.httpNode);
      RED.nodes.registerType('fixture-write', function (config) {
        RED.nodes.createNode(this, config);
        this.on('input', (msg, send, done) => {
          const c = getCounters(msg); if (c) c.business++;
          msg.statusCode = 200; msg.payload = { ok: true }; send(msg); done();
        });
      });
      RED.events.on('runtime-event', (event) => { if (event.id === 'runtime-deploy') deployed.add(event.payload.revision); });
      // RED.start() returns before its initial asynchronous loadFlows/startFlows.
      // Wait for that start before setting our baseline, otherwise the initial
      // empty flow can overwrite the fixture and turn the control into a 404.
      const initialStarted = new Promise((resolve) => RED.events.once('flows:started', resolve));
      await listen(server); allowedPorts.add(server.address().port); await RED.start();
      await Promise.race([initialStarted, sleep(5000).then(() => { throw new Error('Initial isolated flow start timed out'); })]);

      async function load(patched) {
        let flow = authFlow();
        if (patched) flow = patchResultAuthTransport(flow, {
          budgetSource: read('fn_result_auth_request_budget.js'), failureSource: read('fn_result_auth_transport_error.js'),
        });
        const tab = flow.find((n) => n.id === ids.tab);
        tab.env = [
          { name: 'RESULT_AUTH_CUP_TARGETS', value: 'state', type: 'str' },
          { name: 'CUP_API_BASE_URL', value: `http://127.0.0.1:${stubPort}`, type: 'str' },
          { name: 'CUP_LK_IDENTITY_TOKEN', value: 'fixture-integration-secret', type: 'str' },
        ];
        // The only transport substitution: configured loopback URL overrides
        // msg.url for both sources; core HTTP request, auth code and Catch run.
        flow.find((n) => n.id === ids.request).url = `http://127.0.0.1:${stubPort}/profile`;
        for (const node of flow) {
          if (node.type !== 'tab') { node.x ??= 0; node.y ??= 0; }
          if (node.type === 'fixture-write') node.wires = [[ids.response]];
        }
        const revision = await RED.nodes.setFlows(flow, null, 'full', false, true);
        for (let i = 0; i < 500 && !deployed.has(revision); i++) await sleep(10);
        assert.equal(deployed.has(revision), true, 'real runtime start completion');
        assert.ok(RED.nodes.getNode(ids.prepare), JSON.stringify({
          functionType: Boolean(RED.nodes.getType('function')), requestType: Boolean(RED.nodes.getType('http request')),
          fixtureType: Boolean(RED.nodes.getType('fixture-write')),
          logMessageHashes: logs.slice(-12).map((entry) => sha256(String(entry.msg))),
        }));
        RED.nodes.getNode(ids.prepare).on('input', (msg) => {
          const c = getCounters(msg); if (!c) return;
          c.req = msg.req; c.res = msg.res;
          msg.requestTimeout = 600000; msg._resultActor = { verified: true, id: 'fixture-poison' };
        });
        RED.nodes.getNode(ids.request).on('input', (msg) => {
          const c = getCounters(msg); if (c) { c.httpInputs++; c.budgets.push(msg.requestTimeout); }
        });
        RED.nodes.getNode(ids.resolve).on('input', (msg) => { const c = getCounters(msg); if (c) c.resolves++; });
        if (patched) RED.nodes.getNode(ids.failure).on('input', (msg) => { const c = getCounters(msg); if (c) c.catches++; });
        RED.nodes.getNode(ids.response).on('input', (msg) => {
          const c = getCounters(msg); if (!c) return;
          c.responseInputs++;
          c.preservedEnvelope &&= c.req === msg.req && c.res === msg.res;
          if (c.catches) {
            c.cleanFailure &&= !msg.error && !msg._resultAuth && !msg._resultActor && !msg.headers.Authorization
              && !msg.req.headers.authorization && !msg.req.rawHeaders.some((x) => /fixture-secret|fixture-integration-secret/.test(String(x)));
          }
        });
      }
      function assert503(result, { transport = true } = {}) {
        assert.equal(result.status, 503);
        assert.deepEqual(JSON.parse(result.body), { code: 'RESULT_AUTH_SERVICE_UNAVAILABLE', error: 'Не удалось проверить профиль участника' });
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.doesNotMatch(result.body, /fixture-secret|fixture-integration-secret|fixture-poison|Bearer|ECONN|ETIMEDOUT/);
        assert.equal(result.c.responseInputs, 1); assert.equal(result.c.finishes, 1);
        assert.equal(result.c.business, 0); assert.equal(result.c.httpInputs, 1);
        assert.equal(result.c.catches, transport ? 1 : 0); assert.equal(result.c.resolves, transport ? 0 : 1);
        assert.equal(result.c.preservedEnvelope, true); assert.equal(result.c.cleanFailure, true);
        assert.deepEqual(result.c.budgets, [10000]);
      }

      await load(false);
      await check('old real runtime suppresses normal output and leaves refusal unanswered', async () => {
        const result = await call('baseline', 'get', RESULT_AUTH_ROUTES[0][1], { deadline: 500 });
        assert.equal(result.aborted, true); assert.equal(result.c.httpInputs, 1);
        assert.equal(result.c.responseInputs, 0); assert.equal(result.c.resolves, 0); assert.equal(result.c.business, 0);
      });
      await load(true);
      for (const [method, route] of RESULT_AUTH_ROUTES) {
        await check(`real refusal ${method} ${route}: one 503, no result branch`, async () => {
          const result = await call(`refused-${requests.length}`, method, route); assert503(result);
          assert.ok(result.elapsedMs < 3000); requests.push({ mechanism: 'ECONNREFUSED', elapsedMs: Math.round(result.elapsedMs) });
        });
      }
      await listen(stub, stubPort); stubListening = true;
      for (const method of ['get', 'post']) {
        const route = RESULT_AUTH_ROUTES[method === 'get' ? 0 : 1][1];
        await check(`real reset ${method}: one 503`, async () => {
          scenario = 'reset'; const result = await call(`reset-${method}`, method, route); assert503(result);
          requests.push({ mechanism: 'ECONNRESET', elapsedMs: Math.round(result.elapsedMs) });
        });
      }
      await check('CUP and Viva slow sockets: real 10s timeout, late response cannot complete twice', async () => {
        scenario = 'late'; const before = stubCalls;
        const results = await Promise.all([
          call('timeout-cup', 'get', RESULT_AUTH_ROUTES[0][1]),
          call('timeout-viva', 'post', RESULT_AUTH_ROUTES[1][1]),
        ]);
        for (const result of results) {
          assert503(result);
          assert.ok(result.elapsedMs >= 9000 && result.elapsedMs < 14000, `deadline observed ${Math.round(result.elapsedMs)}ms`);
          requests.push({ mechanism: 'TIMEOUT', elapsedMs: Math.round(result.elapsedMs) });
        }
        assert.equal(stubCalls - before, 2, 'one upstream call each, no retry');
        for (let i = 0; i < 400 && lateAttempts < 2; i++) await sleep(10);
        assert.equal(lateAttempts, 2); await sleep(150);
        for (const result of results) assert503(result);
      });
      for (const method of ['get', 'post']) {
        const route = RESULT_AUTH_ROUTES[method === 'get' ? 0 : 1][1];
        await check(`${method}: malformed profile is closed 503 through the normal mapper`, async () => {
          scenario = 'malformed'; assert503(await call(`malformed-${method}`, method, route), { transport: false });
        });
        await check(`${method}: valid identity reaches the synthetic result terminal`, async () => {
          scenario = 'valid'; const result = await call(`valid-${method}`, method, route);
          assert.equal(result.status, 200); assert.equal(result.c.catches, 0); assert.equal(result.c.business, 1);
          assert.equal(result.c.responseInputs, 1); assert.equal(result.c.finishes, 1);
        });
        for (const status of [401, 403, 503]) {
          await check(`${method}: upstream ${status} preserves authorization/error mapping`, async () => {
            scenario = `status-${status}`; const result = await call(`status-${method}-${status}`, method, route);
            assert.equal(result.status, status === 401 ? 401 : status === 403 && method === 'post' ? 401 : 503);
            assert.equal(result.c.catches, 0); assert.equal(result.c.business, 0); assert.equal(result.c.responseInputs, 1);
          });
        }
      }
      await check('foreign actor and missing Bearer remain denied', async () => {
        scenario = 'valid'; const spoof = await call('foreign', 'post', RESULT_AUTH_ROUTES[1][1], { foreignActor: true });
        assert.equal(spoof.status, 403); assert.equal(spoof.c.business, 0);
        const before = stubCalls; const missing = await call('missing-auth', 'get', RESULT_AUTH_ROUTES[0][1], { auth: false });
        assert.equal(missing.status, 401); assert.equal(missing.c.httpInputs, 0); assert.equal(stubCalls, before);
      });
      assert.equal(blockedConnections, 0, 'no non-fixture connection was even attempted');
      assert.equal(logs.filter((entry) => /headers.*sent|ERR_HTTP_HEADERS_SENT/i.test(String(entry.msg))).length, 0);
      assert.equal(failedSubtests, 0, 'Never publish evidence after a failed nested test');
      assert.equal(passedSubtests, 24);
      evidence = {
        nodeRedVersion: require('node-red/package.json').version, nodeVersion: process.version,
        httpNodeSha256: sha256(fs.readFileSync(require.resolve('@node-red/nodes/core/network/21-httprequest.js'))),
        budgetSourceSha256: sha256(read('fn_result_auth_request_budget.js')),
        failureSourceSha256: sha256(read('fn_result_auth_transport_error.js')),
        passedSubtests, failedSubtests, oldRuntimeHung: true, refusalRoutes: 9, resetSources: 2, timeoutSources: 2, lateAttempts,
        timings: requests, blockedConnections, actualProviderRequests: 0, actualDatabaseRequests: 0,
        responseInputsPerTransportFailure: 1, responseFinishesPerTransportFailure: 1,
        productionRequests: false, productionMutation: false,
      };
    } finally {
      for (const timer of timers) clearTimeout(timer);
      try { await RED.stop(); }
      finally {
        try { await close(server); if (stubListening) await close(stub); }
        finally {
          fs.rmSync(userDir, { recursive: true, force: true });
          net.Socket.prototype.connect = connect;
          for (const [key, value] of originalProxy) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        }
      }
    }
    // A nested test failure does not reject t.test(): explicit gates above and
    // successful cleanup are both required before publishing any PASS evidence.
    if (evidencePath) fs.writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, cleanupComplete: true }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  });
