import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import test from 'node:test';

const source = role => fs.readFileSync(new URL(`../nodered_games_nodes/fn_live_ratings_${role}.js`, import.meta.url), 'utf8');
const bodies = { get: source('get_token'), store: source('store_token') };
const now = 2_000_000;
const keys = {
  token: 'vivacrm_access_token', expiry: 'vivacrm_token_expires_at',
  owner: 'vivacrm_token_refresh_owner', lock: 'vivacrm_token_refresh_lock_until',
};
const marker = 'synthetic-private-do-not-log';
const players = [{ clientId: marker, phone: marker, name: marker, ratingNumeric: 2.5 }];
const serviceEnv = { VIVA_SERVICE_USERNAME: marker, VIVA_SERVICE_PASSWORD: marker };
const input = () => ({
  _liveRatingsCtx: { players: structuredClone(players) },
  headers: { authorization: marker, cookie: marker },
  req: { originalUrl: `/synthetic?secret=${marker}`, ip: marker, body: { private: marker } },
  url: marker, error: { code: marker, message: marker },
});
function run(role, { msg = input(), values = {}, envValues = {}, logger = 'capture', body = bodies[role] } = {}) {
  const store = structuredClone(values), records = [], writes = [], reads = [], envReads = [];
  const context = {
    msg,
    global: {
      get(key) { reads.push(key); return store[key]; },
      set(key, value) { writes.push([key, value]); store[key] = value; },
    },
    env: { get(key) { envReads.push(key); return envValues[key]; } },
    Date: class extends Date { static now() { return now; } },
    Math: Object.assign(Object.create(Math), { random: () => 0.25 }),
  };
  if (logger === 'capture') context.node = { warn(value) { records.push(value); } };
  else if (logger !== 'absent') context.node = logger;
  const output = vm.runInNewContext(`(function(){\n${body}\n})()`, context, { timeout: 500 });
  return { output, msg, store, writes, reads, envReads, records };
}
const plain = value => JSON.parse(JSON.stringify(value));
const common = {
  code: 'LK_LIVE_RATINGS_503', route_key: 'games_ratings_live', downstream_status: 503,
};
function record(result, expected) {
  assert.equal(result.records.length, 1);
  assert.equal(typeof result.records[0], 'string');
  assert.deepEqual(JSON.parse(result.records[0]), { ...common, ...expected });
  assert(!result.records[0].includes(marker));
  assert(!result.records[0].includes('synthetic?'));
}
function guardResponse(result, reason, retry) {
  assert.equal(result.output[0], null);
  assert.equal(result.output[1], null);
  assert.strictEqual(result.output[2], result.msg);
  assert.equal(result.msg.statusCode, 503);
  assert.equal(result.msg.payload.code, reason);
  assert.deepEqual(Object.keys(result.msg.payload).sort(), ['code', 'error']);
  assert.deepEqual(plain(result.msg.headers), {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    ...(retry ? { 'Retry-After': String(retry) } : {}),
  });
  assert.deepEqual(result.writes, []);
}

test('refresh guard emits one allowlisted record and preserves the 503/Retry-After/output contract', () => {
  const result = run('get', { values: { [keys.lock]: now + 1000, [keys.owner]: marker } });
  record(result, { stage:'token_guard', reason_code:'VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS', cache_state:'missing', lock_state:'active' });
  guardResponse(result, 'VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS', 1);
  assert.deepEqual(result.envReads, []);
  assert.deepEqual(result.reads, [keys.token, keys.expiry, keys.lock]);
});

test('missing config emits one record without adding env/context reads, token requests or locks', () => {
  const result = run('get');
  record(result, { stage:'token_guard', reason_code:'VIVA_SERVICE_AUTH_NOT_CONFIGURED', cache_state:'missing', lock_state:'absent' });
  guardResponse(result, 'VIVA_SERVICE_AUTH_NOT_CONFIGURED');
  assert.deepEqual(result.envReads, ['VIVA_SERVICE_USERNAME','VIVA_SERVICE_PASSWORD','VIVA_SERVICE_CLIENT_ID','VIVA_SERVICE_TOKEN_URL']);
  assert.deepEqual(result.reads, [keys.token, keys.expiry, keys.lock]);
});

test('cache and lock facts are bounded enums, with no expiry/token/owner values', () => {
  for (const [expiry, cacheState] of [[now - 1,'expired'],[now + 30_000,'within_grace'],[marker,'unknown']]) {
    for (const [lock, lockState] of [[0,'absent'],[now - 1,'expired'],[marker,'unknown']]) {
      const result = run('get', { values:{[keys.token]:marker,[keys.expiry]:expiry,[keys.lock]:lock} });
      record(result, {stage:'token_guard',reason_code:'VIVA_SERVICE_AUTH_NOT_CONFIGURED',cache_state:cacheState,lock_state:lockState});
      guardResponse(result, 'VIVA_SERVICE_AUTH_NOT_CONFIGURED');
    }
  }
});

test('fresh cache and refresh leader are silent; cache grace, payload and lock lifecycle are preserved', () => {
  const fresh = run('get', { values:{[keys.token]:marker,[keys.expiry]:now + 30_001,[keys.lock]:now + 1000} });
  assert.strictEqual(fresh.output[0], fresh.msg);
  assert.equal(fresh.output[1], null);
  assert.equal(fresh.output[2], null);
  assert.equal(fresh.msg.vivaToken, marker);
  assert.deepEqual(plain(fresh.msg.payload), players);
  assert.deepEqual(fresh.records, []);
  assert.deepEqual(fresh.writes, []);
  assert.deepEqual(fresh.envReads, []);
  const leader = run('get', { envValues:serviceEnv, values:{[keys.lock]:now - 1} });
  assert.strictEqual(leader.output[1], leader.msg);
  assert.equal(leader.output[0], null);
  assert.equal(leader.output[2], null);
  assert.equal(leader.msg.method, 'POST');
  const form = new URLSearchParams(leader.msg.payload);
  assert.equal(form.get('username'), marker);
  assert.equal(form.get('password'), marker);
  assert.equal(leader.store[keys.lock], now + 10_000);
  assert.equal(leader.msg._vivaTokenRefreshOwner, leader.store[keys.owner]);
  assert.deepEqual(leader.records, []);
});

const failedToken = status => ({ ...input(), statusCode:status,
  _vivaTokenRefreshOwner:'synthetic-owned-lock', payload:{error:marker,error_description:marker} });
function tokenResponse(result) {
  assert.equal(result.output[0], null);
  assert.strictEqual(result.output[1], result.msg);
  assert.strictEqual(result.output[2], result.msg);
  assert.equal(result.msg.statusCode, 503);
  assert.deepEqual(plain(result.msg.payload), {
    error:'Сервисная авторизация Viva временно недоступна', code:'VIVA_SERVICE_AUTH_UNAVAILABLE',
  });
  assert.deepEqual(plain(result.msg.headers), {
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Retry-After':'2',
  });
}

test('token failures preserve numeric upstream status before replacing downstream status with 503', () => {
  for (const status of [200,400,401,403,429,500,503,'401','503']) {
    const result = run('store', {msg:failedToken(status),values:{[keys.owner]:'synthetic-owned-lock',[keys.lock]:now + 1000}});
    record(result, {stage:'token_http',reason_code:'VIVA_SERVICE_AUTH_UNAVAILABLE',token_http_status:Number(status),transport_class:'none'});
    tokenResponse(result);
    assert.equal(result.store[keys.owner], null);
    assert.equal(result.store[keys.lock], 0);
    assert.equal(result.store[keys.token], undefined);
  }
});

test('transport classes use exact code allowlists and never reflect exception text or payload', () => {
  for (const [status, transport] of [
    ['ETIMEDOUT','timeout'],['ESOCKETTIMEDOUT','timeout'],['ECONNABORTED','timeout'],
    ['ECONNREFUSED','connect'],['ECONNRESET','connect'],['ENOTFOUND','connect'],['EAI_AGAIN','connect'],
    ['EHOSTUNREACH','connect'],['ENETUNREACH','connect'],['CERT_HAS_EXPIRED','tls'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT','tls'],['UNABLE_TO_VERIFY_LEAF_SIGNATURE','tls'],['ERR_TLS_CERT_ALTNAME_INVALID','tls'],
    ['HPE_INVALID_CONSTANT','parse'],['HPE_INVALID_HEADER_TOKEN','parse'],['ERR_JSON_PARSE','parse'],
    [marker,'unknown'],[`ETIMEDOUT ${marker}`,'unknown'],[undefined,'unknown'],[null,'unknown'],
    [0,'unknown'],[600,'unknown'],[503.5,'unknown'],[Infinity,'unknown'],[{private:marker},'unknown'],
  ]) {
    const msg = failedToken(status);
    Object.defineProperty(msg.error, 'message', {get(){ throw Error(marker); }});
    const result = run('store', {msg});
    record(result, {stage:'token_http',reason_code:'VIVA_SERVICE_AUTH_UNAVAILABLE',token_http_status:'unknown',transport_class:transport});
    tokenResponse(result);
  }
});

test('token failure cannot clear a newer refresh owner and diagnostics add no shared writes', () => {
  const result = run('store', {msg:failedToken(503),values:{[keys.owner]:marker,[keys.lock]:now + 1000}});
  assert.equal(result.store[keys.owner], marker);
  assert.equal(result.store[keys.lock], now + 1000);
  assert.deepEqual(result.writes, []);
  tokenResponse(result);
});

test('successful refresh is silent and preserves cache/expiry/owner cleanup and output identity', () => {
  const result = run('store', {msg:{...input(),statusCode:200,payload:{access_token:marker,expires_in:120},_vivaTokenRefreshOwner:'synthetic-owned-lock'},
    values:{[keys.owner]:'synthetic-owned-lock',[keys.lock]:now + 1000}});
  assert.strictEqual(result.output[0], result.msg);
  assert.equal(result.output[1], null);
  assert.equal(result.output[2], null);
  assert.deepEqual(plain(result.msg.payload), players);
  assert.equal(result.msg.vivaToken, marker);
  assert.equal(result.store[keys.token], marker);
  assert.equal(result.store[keys.expiry], now + 120_000);
  assert.equal(result.store[keys.owner], null);
  assert.equal(result.store[keys.lock], 0);
  assert.deepEqual(result.records, []);
});

test('absent, missing, throwing and getter-throwing sinks cannot affect outputs or cache/lock state', () => {
  const sinks = ['absent',null,{}, {warn(){throw Error(marker);}}, {get warn(){throw Error(marker);}}];
  const scenarios = [
    ['get',{}], ['get',{values:{[keys.lock]:now + 1000}}],
    ['store',{msg:failedToken(401),values:{[keys.owner]:'synthetic-owned-lock',[keys.lock]:now + 1000}}],
  ];
  for (const [role,options] of scenarios) {
    const expected = run(role, structuredClone(options));
    for (const logger of sinks) {
      const actual = run(role, {...structuredClone(options),logger});
      for (const field of ['output','store','writes','reads','envReads']) assert.deepEqual(plain(actual[field]),plain(expected[field]));
      assert.deepEqual(actual.records, []);
    }
  }
});

// Optional private local snapshot: no source/flow, credentials or node IDs are copied into the repo.
test('private preimage: diagnostic-only change preserves complete function behavior across failure and success cases',
  {skip:!process.env.LIVE_RATINGS_503_PREIMAGE}, () => {
    const flow = JSON.parse(fs.readFileSync(process.env.LIVE_RATINGS_503_PREIMAGE,'utf8'));
    const hashes = {get:'6e937ed12d7e453040184b10d8f14551bc185191a980e152a9c7b4b58b16338b',store:'cabb2f7254399bf4901bf379fc52829de97a645df4fc738e9bc851395dc984ad'};
    const original = {};
    for (const [role,hash] of Object.entries(hashes)) {
      const matches = flow.filter(n => n.type === 'function' && crypto.createHash('sha256').update(n.func).digest('hex') === hash);
      assert.equal(matches.length, 1, 'private function preimage must match exactly');
      original[role] = matches[0].func;
    }
    const scenarios = [
      ['get',{}], ['get',{values:{[keys.lock]:now + 1000}}],
      ['get',{values:{[keys.token]:marker,[keys.expiry]:now + 30_000}}],
      ['get',{values:{[keys.token]:marker,[keys.expiry]:now + 30_001}}],
      ['get',{envValues:serviceEnv}],
      ...[200,401,403,429,500,503,'ETIMEDOUT',marker].map(status => ['store',{msg:failedToken(status),values:{[keys.owner]:'synthetic-owned-lock',[keys.lock]:now + 1000}}]),
      ['store',{msg:{...input(),statusCode:200,payload:{access_token:marker,expires_in:120}}}],
    ];
    for (const [role,options] of scenarios) {
      const before = run(role, {...structuredClone(options),body:original[role]});
      const after = run(role, structuredClone(options));
      for (const field of ['output','store','writes','reads','envReads']) assert.deepEqual(plain(after[field]),plain(before[field]));
    }
  });
