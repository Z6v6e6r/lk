import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { buildSources, prepareCandidate } from '../prepare_max_response_guard.mjs';

const require = createRequire(import.meta.url);
const { parseMaxJsonResponse } = require('../max-response-guard.cjs');
const fixtures = new URL('./fixtures/max-response-guard/', import.meta.url);
const fixture = file => fs.readFileSync(new URL(file + '.js.txt', fixtures), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const clientFile = 'dist/core/network/api/client.js';
const messagesFile = 'dist/core/network/api/modules/messages/api.js';
const helperFile = 'dist/core/network/api/max-response-guard.cjs';
const sources = buildSources(fixture('client'), fixture('messages-api'));

function load(source, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  const script = vm.runInNewContext(`(function(require,module,exports) { ${source}\n})`, {
    URL, Buffer, Error, SyntaxError, ...globals,
  });
  script(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

function sdk(fetchImpl, patched = true) {
  const debug = [];
  const { createClient } = load(patched ? sources[clientFile] : fixture('client'), {
    debug: () => (...args) => debug.push(args),
    './max-response-guard.cjs': { parseMaxJsonResponse },
  }, { fetch: fetchImpl });
  const { MaxError } = load(fixture('error'));
  const { BaseApi } = load(fixture('base-api'), { './error': { MaxError } });
  const { MessagesApi } = load(patched ? sources[messagesFile] : fixture('messages-api'), { '../../base-api': { BaseApi },
    '../../error': { MaxError }, 'node:timers/promises': { setTimeout: () => { throw new Error('UNEXPECTED_SEND_RETRY'); } }, });
  const client = createClient('synthetic-auth-marker');
  return { messages: new MessagesApi(client), client, debug, MaxError, BaseApi, createClient };
}

function jsonResponse(data, status = 200, mime = 'application/json') {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': mime } });
}

for (const [status, mime, type, body] of [
  [307, 'text/html', 'html', '<html>synthetic-body-marker</html>'],
  [308, 'text/html', 'html', '<html>synthetic-body-marker</html>'],
  [200, 'text/html; charset=utf-8', 'html', '<html>synthetic-body-marker</html>'],
  [502, 'TEXT/HTML; charset=synthetic-mime-marker', 'html', '<html>synthetic-body-marker</html>'],
  [503, 'application/xhtml+xml', 'html', '<html>synthetic-body-marker</html>'],
  [200, 'application/json', 'json', '<html>synthetic-body-marker</html>'],
  [504, 'text/plain', 'text', 'synthetic-body-marker'],
  [429, 'application/octet-stream', 'other', 'synthetic-body-marker'],
  [200, '', 'missing', '<html>synthetic-body-marker</html>'],
  [200, 'application/problem+json', 'json', '{synthetic-body-marker'],
  [200, 'application/json', 'json', ''],
]) {
  test(`safe format diagnostic: ${status}/${mime || 'missing'}`, async () => {
    let calls = 0;
    const transport = sdk(async (url, init) => {
      calls++;
      assert.equal(new URL(url).pathname, '/messages');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(new URL(url).searchParams.get('chat_id'), 'synthetic-recipient-marker');
      const headers = new Headers();
      if (mime) headers.set('content-type', mime);
      return new Response(Buffer.from(body), { status, headers });
    });
    let failure;
    try { await transport.messages.send({ chat_id: 'synthetic-recipient-marker', text: 'synthetic-request-marker' }); }
    catch (error) { failure = error; }
    assert.equal(calls, 1);
    assert.equal(failure?.name, 'MaxResponseFormatError');
    const diagnostic = JSON.parse(failure.message);
    assert.deepEqual(diagnostic, {
      event: 'max_response_format_failed', code: 'MAX_RESPONSE_FORMAT_INVALID',
      upstreamStatus: status, responseType: type, reason: 'invalid_json', delivery: 'unknown', retryable: false,
    });
    assert.equal(Object.hasOwn(failure, 'cause'), false);
    assert.equal(Object.hasOwn(failure, 'response'), false);
    const visible = JSON.stringify(failure) + failure.stack + JSON.stringify(transport.debug);
    for (const marker of ['synthetic-body-marker', 'synthetic-request-marker', 'synthetic-recipient-marker',
      'synthetic-auth-marker', 'synthetic-mime-marker', 'platform-api.max.ru']) assert.ok(!visible.includes(marker));
    assert.deepEqual(transport.debug.map(args => Array.from(args)), [['MAX_HTTP_REQUEST']]);
  });
}

test('body read errors are replaced; no native error/cause is retained', async () => {
  const error = await parseMaxJsonResponse({ status: 502, headers: new Headers({ 'content-type': 'text/html' }),
    json: async () => { throw new TypeError('synthetic-body-marker'); },
  }).then(() => null, error => error);
  assert.equal(error.reason, 'body_read_failed');
  assert.equal(error.upstreamStatus, 502);
  assert.ok(!(JSON.stringify(error) + error.stack).includes('synthetic-body-marker'));
  assert.equal(error.cause, undefined);
});

test('diagnostic status is limited to integer HTTP statuses', async () => {
  for (const status of [0, 600, '502', NaN, 502.5]) {
    const error = await parseMaxJsonResponse({ status, headers: new Headers(), json: async () => { throw new SyntaxError(); } })
      .then(() => null, error => error);
    assert.equal(error.upstreamStatus, null);
  }
});

test('valid JSON returns unchanged with JSON, missing, or misleading MIME', async () => {
  for (const mime of ['application/json', 'text/html', 'application/problem+json', '']) {
    let calls = 0;
    const headers = new Headers();
    if (mime) headers.set('content-type', mime);
    const result = { message: { body: { mid: 'synthetic-result' } } };
    const transport = sdk(async () => { calls++; return new Response(Buffer.from(JSON.stringify(result)), { headers }); });
    assert.deepEqual(await transport.messages.send({ chat_id: 'synthetic-chat', text: 'synthetic-text' }), result);
    assert.equal(calls, 1);
  }
});

test('401 keeps existing auth contract and does not parse the body', async () => {
  let reads = 0, calls = 0;
  const transport = sdk(async () => {
    calls++;
    return { status: 401, headers: new Headers({ 'content-type': 'text/html' }), json: async () => { reads++; throw new SyntaxError(); } };
  });
  await assert.rejects(transport.messages.send({ chat_id: 'synthetic-chat', text: 'synthetic-text' }), error => {
    assert.ok(error instanceof transport.MaxError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'verify.token');
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(reads, 0);
});

test('attachment.not.ready produces exactly one send and no scheduled retry', async () => {
  let calls = 0;
  const transport = sdk(async () => {
    calls++;
    return jsonResponse({ code: 'attachment.not.ready', message: 'synthetic-provider-description' }, 400);
  });
  await assert.rejects(transport.messages.send({ chat_id: 'synthetic-chat', text: 'synthetic-text' }), error => {
    assert.ok(error instanceof transport.MaxError);
    assert.equal(error.code, 'attachment.not.ready');
    return true;
  });
  assert.equal(calls, 1);
  assert.ok(!sources[messagesFile].includes('this.send('));
  assert.ok(!sources[messagesFile].includes('setTimeout'));
});

test('JSON provider errors keep their existing MaxError contract', async () => {
  const transport = sdk(async () => jsonResponse({ code: 'chat.not.found', message: 'synthetic-error' }, 403));
  await assert.rejects(transport.messages.send({ chat_id: 'synthetic-chat', text: 'synthetic-text' }), error => {
    assert.ok(error instanceof transport.MaxError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'chat.not.found');
    return true;
  });
});

for (const status of [502, 307, 308]) for (const outputs of [1, 2]) {
  test(`actual contrib sender routes HTML to error only (${outputs} outputs, ${status})`, async () => {
    let attempts = 0;
    const transport = sdk(async () => { attempts++; return new Response('<html>synthetic-body-marker</html>', {
      status, headers: { 'content-type': 'text/html' },
    }); });
    const handlers = {}, errors = [], sent = [], statuses = [];
    let Sender, done = 0;
    const RED = { nodes: {
      createNode(node) {
        node.on = (event, fn) => { handlers[event] = fn; };
        node.status = value => statuses.push(value.text);
        node.error = error => errors.push(error);
        node.outputs = outputs;
      },
      getNode: () => ({ token: 'synthetic-auth-marker' }),
      registerType(_type, constructor) { Sender = constructor; },
    } };
    const { default: register } = load(fixture('maxbot-send'), {
      '@maxhub/max-bot-api': { Bot: class { constructor() {
        this.api = { sendMessageToChat: (chat_id, text) => transport.messages.send({ chat_id, text }) };
      } } },
    });
    register(RED);
    new Sender({ bot: 'synthetic-config', outputs });
    await handlers.input({ chatId: 'synthetic-chat', payload: 'synthetic-text' }, msg => sent.push(msg), () => done++);
    assert.equal(attempts, 1);
    assert.equal(done, 1);
    assert.ok(!statuses.includes('sent'));
    if (outputs === 1) {
      assert.equal(sent.length, 0); // No success output means no downstream success ACK.
      assert.equal(errors[0]?.name, 'MaxResponseFormatError');
    } else {
      assert.equal(errors.length, 0);
      assert.equal(sent[0][0], null);
      assert.equal(sent[0][1].error.name, 'MaxResponseFormatError');
    }
  });
}

function sourceTree(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-response-guard-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'sdk');
  fs.mkdirSync(path.join(root, path.dirname(messagesFile)), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@maxhub/max-bot-api', version: '0.2.2' }));
  fs.writeFileSync(path.join(root, clientFile), fixture('client'));
  fs.writeFileSync(path.join(root, messagesFile), fixture('messages-api'));
  return { parent, root, output: path.join(parent, 'candidate') };
}

test('constructor produces only three reviewed files and hashes; source stays intact', t => {
  const { root, output } = sourceTree(t);
  const manifest = prepareCandidate(root, output);
  assert.equal(manifest.installed, false);
  assert.equal(manifest.automaticSendRetries, false);
  assert.equal(manifest.files.length, 3);
  for (const entry of manifest.files) {
    assert.equal(sha(fs.readFileSync(path.join(output, entry.file))), entry.candidateSha256);
    if (entry.preimageSha256) assert.equal(sha(fs.readFileSync(path.join(root, entry.file))), entry.preimageSha256);
    execFileSync(process.execPath, ['--check', path.join(output, entry.file)]);
  }
  assert.ok(!fs.existsSync(path.join(root, helperFile)));
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  assert.throws(() => prepareCandidate(root, output), /MAX_OUTPUT_EXISTS/);
});

test('constructor rejects unknown version, source drift and already patched input', t => {
  const { root, output } = sourceTree(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@maxhub/max-bot-api', version: '0.2.3' }));
  assert.throws(() => prepareCandidate(root, output), /MAX_SDK_VERSION_MISMATCH/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@maxhub/max-bot-api', version: '0.2.2' }));
  fs.appendFileSync(path.join(root, clientFile), '\n');
  assert.throws(() => prepareCandidate(root, output), /MAX_SDK_SOURCE_DRIFT/);
  fs.writeFileSync(path.join(root, clientFile), sources[clientFile]);
  assert.throws(() => prepareCandidate(root, output), /MAX_SDK_SOURCE_DRIFT/);
  assert.ok(!fs.existsSync(output));
});

test('constructor rejects aliases, hardlinks, nested candidate, and linked output parent', t => {
  const { parent, root, output } = sourceTree(t);
  const alias = path.join(parent, 'alias');
  fs.symlinkSync(root, alias);
  assert.throws(() => prepareCandidate(alias, output), /MAX_PATH_ALIAS/);
  assert.throws(() => prepareCandidate(root, path.join(root, 'candidate')), /MAX_EXTERNAL_CANDIDATE_REQUIRED/);
  assert.throws(() => prepareCandidate(root, path.join(alias, 'candidate')), /MAX_PATH_ALIAS/);
  assert.throws(() => prepareCandidate('relative', output), /MAX_ABSOLUTE/);
  const client = path.join(root, clientFile), copy = path.join(parent, 'client-copy');
  fs.renameSync(client, copy);
  fs.symlinkSync(copy, client);
  assert.throws(() => prepareCandidate(root, output), /MAX_SDK_SOURCE_ALIAS/);
  fs.unlinkSync(client);
  fs.linkSync(copy, client);
  assert.throws(() => prepareCandidate(root, output), /MAX_SDK_SOURCE_NOT_REGULAR/);
  assert.ok(!fs.existsSync(output));
});


test('constructor refuses an existing helper instead of overwriting unknown source', t => {
  const { root, output } = sourceTree(t);
  fs.writeFileSync(path.join(root, helperFile), 'synthetic-foreign-source');
  assert.throws(() => prepareCandidate(root, output), /MAX_SDK_HELPER_ALREADY_EXISTS/);
  assert.ok(!fs.existsSync(output));
});

// Public Bot/Api/RawApi/Polling and actual contrib config/receive sources. Only
// unrelated update handlers, upload helpers, timers and fetch are substituted.
function receiverRuntime({ stage, response, patched = true }) {
  const requests = [], errors = [], pollingTimers = new Map(), receiverTimers = new Map();
  const statuses = [], hooks = {};
  let stops = 0, done = 0;
  const transport = sdk(async (url, init) => {
    const pathname = new URL(url).pathname;
    requests.push({ pathname, method: init.method, redirect: init.redirect });
    assert.equal(init.method, 'GET'); // Identity/poll recovery must never POST/send.
    if (stage === 'updates' && pathname === '/me') return jsonResponse({ username: 'synthetic-bot' });
    return response();
  }, patched);
  const { BaseApi, MaxError, createClient } = transport;
  const { BotsApi } = load(fixture('bots-api'), { '../../base-api': { BaseApi } });
  const { SubscriptionsApi } = load(fixture('subscriptions-api'), { '../../base-api': { BaseApi } });
  const { RawApi } = load(fixture('raw-api'), { './modules': { BaseApi, BotsApi, SubscriptionsApi } });
  const { Api } = load(fixture('public-api'), {
    './core/helpers/attachments': {}, './core/helpers/upload': { Upload: class {} },
    './core/network/api': { RawApi },
  });
  const noopDebug = { debug: () => () => {} };
  const schedule = timers => (fn, ms) => {
    const token = {};
    timers.set(token, { fn, ms });
    return token;
  };
  const { Polling } = load(fixture('polling'), { ...noopDebug, './api': { MaxError } }, {
    AbortController, setTimeout: schedule(pollingTimers),
  });
  const { Bot } = load(fixture('bot'), {
    ...noopDebug, './composer': { Composer: class { on() {} command() {} action() {} } },
    './context': { Context: class {} }, './core/network/api': { createClient },
    './core/network/polling': { Polling }, './api': { Api },
  });
  class TrackedBot extends Bot {
    constructor(...args) {
      super(...args);
      const originalStop = this.stop;
      this.stop = () => { stops++; originalStop(); };
    }
  }
  let Config, Receive;
  const configs = new Map();
  const RED = { nodes: {
    createNode(node) {
      node.credentials = { token: 'synthetic-auth-marker' };
      node.on = (name, callback) => { hooks[name] = callback; };
      node.error = message => errors.push(message);
      node.status = status => statuses.push(status.text);
      node.send = () => { throw new Error('UNEXPECTED_UPDATE_OUTPUT'); };
    },
    getNode: key => configs.get(key),
    registerType(type, constructor) {
      if (type === 'maxbot-config') Config = constructor;
      if (type === 'maxbot-receive') Receive = constructor;
    },
  } };
  load(fixture('maxbot-config'), { '@maxhub/max-bot-api': { Bot: TrackedBot } }).default(RED);
  configs.set('synthetic-config', new Config({}));
  assert.equal(requests.length, 0); // The actual config constructor does not start polling.
  load(fixture('maxbot-receive'), { '@maxhub/max-bot-api': { Bot: TrackedBot } }, {
    setTimeout: schedule(receiverTimers), clearTimeout: token => receiverTimers.delete(token),
  }).default(RED);
  new Receive({ bot: 'synthetic-config' });
  return { requests, errors, statuses, pollingTimers, receiverTimers,
    stops: () => stops, close: () => { hooks.close(() => done++); }, done: () => done };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const stage of ['identity', 'updates']) for (const [status, mime, type, body] of [
  [502, 'text/html', 'html', '<html>synthetic-body-marker</html>'],
  [503, 'text/plain; charset=synthetic-mime-marker', 'text', 'synthetic-server-body-marker'],
  [307, 'text/html', 'html', '<html>synthetic-body-marker</html>'],
]) {
  test(`actual Bot/Polling/receiver start.catch: ${stage} ${status}/${type}`, async () => {
    const response = () => new Response(body, { status, headers: { 'content-type': mime } });
    for (const patched of [false, true]) {
      const runtime = receiverRuntime({ stage, response, patched });
      await settle();
      const expectedPaths = stage === 'identity' ? ['/me'] : ['/me', '/updates'];
      assert.deepEqual(runtime.requests.map(x => x.pathname), expectedPaths);
      assert.equal(runtime.pollingTimers.size, 0); // Same classification as native SyntaxError, not SDK MaxError retry.
      assert.equal(runtime.receiverTimers.size, 1);
      assert.equal(runtime.stops(), 1);
      assert.equal(runtime.errors.length, 1);
      assert.ok(runtime.statuses.includes('disconnected'));
      const [timer] = runtime.receiverTimers.values();
      assert.equal(timer.ms, 5000);
      if (patched) {
        for (const request of runtime.requests) assert.equal(request.redirect, 'manual');
        assert.ok(runtime.errors[0].startsWith('MAX Bot error: '));
        const message = runtime.errors[0].slice('MAX Bot error: '.length);
        assert.deepEqual(JSON.parse(message), {
          event: 'max_response_format_failed', code: 'MAX_RESPONSE_FORMAT_INVALID',
          upstreamStatus: status, responseType: type, reason: 'invalid_json', delivery: 'unknown', retryable: false,
        });
        for (const marker of ['synthetic-body-marker', 'synthetic-server-body-marker', 'synthetic-auth-marker',
          'synthetic-mime-marker', 'SyntaxError', 'cause']) assert.ok(!message.includes(marker));
      }
      // Execute one pre-existing read-recovery callback without real waiting/network.
      runtime.receiverTimers.clear();
      timer.fn();
      await settle();
      assert.deepEqual(runtime.requests.map(x => x.pathname), [...expectedPaths, ...expectedPaths]);
      assert.ok(runtime.requests.every(x => x.method === 'GET'));
      assert.equal(runtime.receiverTimers.size, 1); // retryable:false does not disable outer read recovery.
      assert.equal(runtime.stops(), 2);
      runtime.close();
      assert.equal(runtime.receiverTimers.size, 0);
      assert.equal(runtime.done(), 1);
    }
  });
}

test('valid JSON 503 keeps actual Polling MaxError delay classification unchanged', async () => {
  for (const patched of [false, true]) {
    const runtime = receiverRuntime({ stage: 'updates', patched,
      response: () => jsonResponse({ code: 'synthetic-provider-code', message: 'synthetic-provider-description' }, 503),
    });
    await settle();
    assert.deepEqual(runtime.requests.map(x => x.pathname), ['/me', '/updates']);
    assert.equal(runtime.errors.length, 0);
    assert.equal(runtime.receiverTimers.size, 0);
    assert.equal(runtime.pollingTimers.size, 1);
    const [timer] = runtime.pollingTimers.values();
    assert.equal(timer.ms, 5000);
    runtime.pollingTimers.clear();
    timer.fn();
    await settle();
    assert.equal(runtime.requests.length, 2); // SDK source returns after its delay; no send or added recovery here.
    runtime.close();
    assert.equal(runtime.done(), 1);
  }
});
