import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { RESULT_AUTH_IDS as ids, RESULT_AUTH_ROUTES, patchResultAuthTransport, sha256 } from '../lib/resultAuthTransport.mjs';
import { buildCandidate } from '../build_result_auth_transport_candidate.mjs';
import { authFlow } from './fixtures/resultAuthTransportFlow.mjs';

const read = (file) => fs.readFileSync(new URL(`../nodered_result_nodes/${file}`, import.meta.url), 'utf8');
const sources = {
  budgetSource: read('fn_result_auth_request_budget.js'),
  failureSource: read('fn_result_auth_transport_error.js'),
};
const run = (source, msg, values = {}) => new Function('msg', 'env', source)(msg, { get: (key) => values[key] });
const patched = () => patchResultAuthTransport(authFlow(), sources);

function message(url, extra = {}) {
  const req = {
    route: { path: url }, headers: { Authorization: 'Bearer fixture-secret' },
    rawHeaders: ['Authorization', 'Bearer fixture-secret', 'Accept', 'application/json'],
  };
  return { _msgid: 'fixture-message', req, res: { fixture: 'response' },
    payload: { actor: { id: 'fixture-player' }, sets: [{ left: 6, right: 3 }] }, ...extra };
}

// Executes real committed functions and graph wiring. The HTTP test double uses
// the core senderr=true contract: Catch gets the original msg; normal output is
// suppressed on transport error. No HTTP, provider, Mongo or wall-clock sleeps.
function dispatch(flow, initial, { failure, profile, status = 200, env = {} } = {}) {
  const byId = new Map(flow.map((n) => [n.id, n]));
  const queue = [[ids.prepare, initial]];
  const result = { terminal: [], writes: [], requests: [] };
  while (queue.length) {
    const [id, msg] = queue.shift();
    const node = byId.get(id);
    let outputs;
    if (node.type === 'function') {
      const value = run(node.func, msg, env);
      outputs = Array.isArray(value) ? value : [value];
    } else if (node.type === 'http request') {
      result.requests.push({ requestTimeout: msg.requestTimeout, method: msg.method });
      if (failure) {
        msg.error = { message: `fixture-secret ${failure}`, source: { id } };
        msg.payload = 'fixture-secret upstream body';
        for (const catcher of flow.filter((n) => n.type === 'catch' && n.scope?.includes(id))) {
          for (const target of catcher.wires.flat()) queue.push([target, msg]);
        }
        if (node.senderr) continue;
      }
      msg.statusCode = status;
      msg.payload = profile;
      outputs = [msg];
    } else if (node.type === 'http response') {
      result.terminal.push(msg); continue;
    } else if (node.type === 'fixture-write') {
      result.writes.push({ id, msg }); continue;
    } else throw new Error('Unexpected fixture node');
    outputs.forEach((out, index) => {
      if (out) for (const target of node.wires[index] || []) queue.push([target, out]);
    });
  }
  return result;
}

test('regression: senderr without Catch leaves the result request unanswered', () => {
  const result = dispatch(authFlow(), message(RESULT_AUTH_ROUTES[0][1]), { failure: 'ECONNREFUSED' });
  assert.equal(result.requests.length, 1);
  assert.equal(result.terminal.length, 0);
  assert.equal(result.writes.length, 0);
});

for (const failure of ['ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET']) {
  for (const [method, url] of RESULT_AUTH_ROUTES) {
    test(`${method} ${url}: ${failure} closes once with safe 503 and no writes/retry`, () => {
      const msg = message(url, { requestTimeout: 600000, _resultActor: { verified: true } });
      const req = msg.req; const res = msg.res;
      const result = dispatch(patched(), msg, { failure,
        env: { RESULT_AUTH_CUP_TARGETS: 'state', CUP_LK_IDENTITY_TOKEN: 'fixture-server-secret' } });
      assert.equal(result.requests.length, 1);
      assert.equal(result.requests[0].requestTimeout, 10000);
      assert.equal(result.terminal.length, 1);
      assert.equal(result.writes.length, 0);
      const out = result.terminal[0];
      assert.equal(out.req, req); assert.equal(out.res, res);
      assert.equal(out.statusCode, 503);
      assert.deepEqual(out.payload, { code: 'RESULT_AUTH_SERVICE_UNAVAILABLE', error: 'Не удалось проверить профиль участника' });
      assert.equal(out.headers['Cache-Control'], 'no-store');
      assert.deepEqual(Object.keys(out).sort(), ['_msgid', 'req', 'res', 'statusCode', 'headers', 'payload'].sort());
      assert.doesNotMatch(JSON.stringify(out), /fixture-secret|fixture-server-secret|Bearer|upstream body/);
    });
  }
}

test('Catch sanitizer also closes malformed/no-context errors without passing arbitrary fields', () => {
  for (const error of [undefined, null, 'malformed', { nested: { credentials: 'fixture-secret' } }]) {
    const msg = message('/fixture', { error, _error: error, _resultAuth: { secret: 'fixture-secret' },
      headers: { Authorization: 'fixture-secret', 'X-CUP-Integration-Token': 'fixture-secret' },
      url: 'fixture-secret', query: { secret: 'fixture-secret' }, _resultActor: { verified: true } });
    msg.req.headers['x-CUP-Integration-Token'] = 'fixture-secret';
    msg.req.rawHeaders.push('X-CUP-Integration-Token', 'fixture-secret');
    const out = run(sources.failureSource, msg);
    assert.equal(out.statusCode, 503);
    assert.equal(out.req, msg.req); assert.equal(out.res, msg.res);
    assert.doesNotMatch(JSON.stringify(out), /fixture-secret|Bearer|verified/);
    assert.deepEqual(out.req.rawHeaders, ['Accept', 'application/json']);
  }
  assert.equal(run(sources.failureSource, {}).statusCode, 503);
});

for (const cup of [false, true]) {
  const env = cup ? { RESULT_AUTH_CUP_TARGETS: 'state', CUP_LK_IDENTITY_TOKEN: 'fixture-server-secret' } : {};
  const valid = cup ? { ok: true, actor: { verified: true, source: 'cup-keycloak-jwt', subject: 'fixture-subject', clientId: 'fixture-player' } } : { id: 'fixture-player' };
  test(`${cup ? 'CUP' : 'Viva'} valid profile and identity rejection behavior stays unchanged`, () => {
    const url = RESULT_AUTH_ROUTES[0][1];
    const success = dispatch(patched(), message(url), { profile: valid, env });
    assert.equal(success.terminal.length, 0); assert.equal(success.writes.length, 1);
    assert.equal(success.writes[0].msg._resultActor.verified, true);
    assert.equal(success.writes[0].msg._resultActor.id, 'fixture-player');
    for (const [status, profile, expected] of [[401, {}, 401], [403, {}, cup ? 503 : 401], [500, {}, 503], [200, 'bad-json', 503], [200, {}, cup ? 503 : 403], [200, valid, 403]]) {
      const msg = message(url);
      if (profile === valid) msg.payload.actor.id = 'fixture-foreign-player';
      const result = dispatch(patched(), msg, { status, profile, env });
      assert.equal(result.terminal.length, 1); assert.equal(result.terminal[0].statusCode, expected);
      assert.equal(result.writes.length, 0);
    }
  });
}

test('missing/invalid Bearer remains 401 without issuing any profile request', () => {
  for (const header of [undefined, '', 'Basic fixture', 'Bearer']) {
    const msg = message(RESULT_AUTH_ROUTES[0][1]); msg.req.headers = { authorization: header };
    const result = dispatch(patched(), msg);
    assert.equal(result.requests.length, 0); assert.equal(result.writes.length, 0);
    assert.equal(result.terminal[0].statusCode, 401);
  }
});

test('candidate changes only prepare wiring plus three narrowly scoped nodes', () => {
  const input = authFlow(); const original = structuredClone(input); const flow = patched();
  assert.deepEqual(input, original);
  const changed = flow.slice(0, input.length).filter((n, i) => !isDeepStrictEqual(n, input[i]));
  assert.deepEqual(changed.map((n) => n.id), [ids.prepare]);
  assert.equal(changed[0].func, input.find((n) => n.id === ids.prepare).func);
  assert.equal(flow.length, input.length + 3);
  const catcher = flow.find((n) => n.id === ids.catch);
  assert.deepEqual(catcher.scope, [ids.request]); assert.equal(catcher.uncaught, false);
  assert.deepEqual(flow.find((n) => n.id === ids.failure).wires, [[ids.response]]);
});

test('patcher rejects drift, duplicate IDs, overlap, collisions and unexpected predecessors', () => {
  const mutations = [
    (f) => { f.find((n) => n.id === ids.request).senderr = false; },
    (f) => { f.find((n) => n.id === ids.prepare).func += '\n// changed'; },
    (f) => { f.find((n) => n.id === ids.resolve).wires[5] = []; },
    (f) => { f.find((n) => n.id === ids.response).headers = { Authorization: 'fixture-secret' }; },
    (f) => { f.find((n) => n.type === 'http in').wires = [[ids.request]]; },
    (f) => { f.find((n) => n.type === 'http in').d = true; },
    (f) => f.push({ id: ids.budget, type: 'function', wires: [] }),
    (f) => f.push({ id: 'fixture-catch', type: 'catch', z: ids.tab, scope: [ids.request], wires: [] }),
    (f) => f.push({ id: 'fixture-catch', type: 'catch', z: ids.tab, scope: null, wires: [] }),
    (f) => f.push({ id: 'fixture-extra', type: 'function', wires: [[ids.request]] }),
    (f) => f.push({ id: 'fixture-extra', type: 'function', wires: [[ids.prepare]] }),
    (f) => f.push(structuredClone(f[0])),
    (f) => f.push({ id: 'fixture-broken', type: 'function', wires: [['missing-node']] }),
  ];
  for (const mutate of mutations) {
    const flow = authFlow(); mutate(flow);
    assert.throws(() => patchResultAuthTransport(flow, sources));
  }
  assert.throws(() => patchResultAuthTransport(patched(), sources), /preimage|collision/);
});

test('CLI builder preserves private source, writes only private external candidate and refuses stale/alias outputs', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'result-auth-builder-')));
  try {
    const workspace = path.join(root, 'input-workspace');
    const input = path.join(workspace, 'input');
    fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(input, { mode: 0o700 });
    const sourcePath = path.join(input, 'source.flow.json');
    const metaPath = path.join(input, 'source.flow.meta.json');
    const serialized = `${JSON.stringify(authFlow(), null, 2)}\n`;
    const meta = {
      formatVersion: 1, sourceKind: 'live-147', sourceHost: 'lk-primary-147', sourceUser: 'root',
      sourcePort: '22', remoteFlowPath: '/root/.node-red/flows.json', localSourcePath: sourcePath,
      sourceSha256: sha256(serialized), nodeCount: authFlow().length, pulledAt: new Date().toISOString(),
    };
    fs.writeFileSync(sourcePath, serialized, { mode: 0o600 });
    fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
    const output = path.join(root, 'candidate'); const report = buildCandidate(workspace, output);
    assert.equal(report.addedNodes, 3);
    assert.equal(report.changedAuthFunctions, 0); assert.equal(report.liveApply, false);
    assert.equal(fs.statSync(output).mode & 0o777, 0o700);
    for (const file of ['candidate.flow.json', 'report.json']) {
      assert.equal(fs.statSync(path.join(output, file)).mode & 0o777, 0o600);
    }
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), serialized);
    assert.throws(() => buildCandidate(workspace, output), /new/);
    assert.throws(() => buildCandidate(workspace, input), /new/);
    const alias = path.join(root, 'alias'); fs.symlinkSync(input, alias);
    assert.throws(() => buildCandidate(workspace, alias), /new/);
    assert.throws(() => buildCandidate(workspace, path.resolve('candidate-test-output')), /outside repository/);
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, pulledAt: '2000-01-01T00:00:00Z' }));
    assert.throws(() => buildCandidate(workspace, path.join(root, 'stale')), /stale/);
    assert.equal(fs.existsSync(path.join(root, 'stale')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
