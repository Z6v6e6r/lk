// Disposable HTTP fixture using the installed Node-RED auth/permission middleware.
// It never loads production settings, sessions, flows or credentials.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const [nodeRedRoot, moduleFile] = process.argv.slice(2);
if (!path.isAbsolute(nodeRedRoot || '') || !path.isAbsolute(moduleFile || '')) throw Error('ABSOLUTE_FIXTURE_PATHS_REQUIRED');
const require = createRequire(path.join(nodeRedRoot, 'package.json'));
const authRoot = path.join(nodeRedRoot, 'node_modules/@node-red/editor-api/lib/auth');
const auth = require(authRoot), express = require('express');
const { createFlowReadTokenAuth } = require(moduleFile);
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-flow-auth-fixture-')));
fs.chmodSync(directory, 0o700);
const file = path.join(directory, 'service.token'), token = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(file, token + '\n', { mode: 0o600 });
const sessions = {
  'fixture-admin': { user: 'fixture-editor', scope: '*', expires: Number.MAX_SAFE_INTEGER },
  'fixture-expiring': { user: 'fixture-editor', scope: '*', expires: Date.parse('2026-11-17T21:25:00Z') },
};
auth.init({ adminAuth: { type: 'credentials', users: [{ username: 'fixture-editor', permissions: '*' }],
  tokens: createFlowReadTokenAuth(file) } }, { getSessions: async () => sessions, saveSessions: async () => {} });
const app = express(); let writes = 0;
app.get('/flows', auth.needsPermission('flows.read'), (_req, res) => res.json({ rev: 'fixture', flows: [] }));
app.post('/flows', auth.needsPermission('flows.write'), (_req, res) => { writes++; res.json({ fixture: true }); });
app.get('/settings', auth.needsPermission('settings.read'), (_req, res) => res.json({ fixture: true }));
app.get('/nodes', auth.needsPermission('nodes.read'), (_req, res) => res.json({ fixture: true }));
app.put('/context', auth.needsPermission('context.write'), (_req, res) => { writes++; res.json({ fixture: true }); });
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const url = `http://127.0.0.1:${server.address().port}`;
const request = (route, bearer, method = 'GET') => fetch(url + route, { method,
  headers: bearer ? { Authorization: 'Bearer ' + bearer } : {}, signal: AbortSignal.timeout(4000) });
const originalNow = Date.now;
try {
  assert.equal((await request('/flows', 'fixture-admin')).status, 200);
  assert.equal((await request('/flows', 'fixture-expiring')).status, 200);
  assert.equal((await request('/flows', token)).status, 200);
  for (const [route, method] of [['/flows', 'POST'], ['/settings', 'GET'], ['/nodes', 'GET'], ['/context', 'PUT']]) {
    assert.equal((await request(route, token, method)).status, 401);
  }
  assert.equal(writes, 0);
  for (const bad of [null, 'wrong-fixture-token', crypto.randomBytes(32).toString('hex')]) {
    assert.equal((await request('/flows', bad)).status, 401);
  }
  Date.now = () => Date.parse('2099-11-19T00:00:00Z');
  assert.equal((await request('/flows', 'fixture-expiring')).status, 401);
  assert.equal((await request('/flows', token)).status, 200);
  assert.equal((await request('/flows', 'fixture-admin')).status, 200);
  Date.now = originalNow;
  const next = crypto.randomBytes(32).toString('hex'), pending = path.join(directory, 'next');
  fs.writeFileSync(pending, next, { mode: 0o600 }); fs.renameSync(pending, file);
  assert.equal((await request('/flows', token)).status, 401);
  assert.equal((await request('/flows', next)).status, 200);
  fs.chmodSync(file, 0o644); assert.equal((await request('/flows', next)).status, 401);
  assert.equal((await request('/flows', 'fixture-admin')).status, 200);
  assert.equal(writes, 0);
  const owningSourceHashes = Object.fromEntries(['index.js', 'strategies.js', 'users.js', 'tokens.js', 'permissions.js']
    .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(authRoot, name))).digest('hex')]));
  console.log(JSON.stringify({ version: require(path.join(nodeRedRoot, 'package.json')).version,
    serviceFlowsRead: true, writesAndUnrelatedReadsDenied: 4, unknownTokensDenied: 3,
    legacySessionExpiredIn2099: true, serviceSurvives2099: true, existingAdminPreserved: true,
    rotationImmediate: true, unsafeFileDenied: true, fixtureWrites: writes, productionWrites: 0, owningSourceHashes }));
} finally { Date.now = originalNow; await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
// Node-RED owns a session-expiry timer in this disposable process.
process.exit(0);
