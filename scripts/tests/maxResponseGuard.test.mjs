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
    URL, Buffer, SyntaxError, ...globals,
  });
  script(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

function sdk(fetchImpl) {
  const debug = [];
  const { createClient } = load(sources[clientFile], {
    debug: () => (...args) => debug.push(args),
    './max-response-guard.cjs': { parseMaxJsonResponse },
  }, { fetch: fetchImpl });
  const { MaxError } = load(fixture('error'));
  const { BaseApi } = load(fixture('base-api'), { './error': { MaxError } });
  const { MessagesApi } = load(sources[messagesFile], { '../../base-api': { BaseApi } });
  const client = createClient('synthetic-auth-marker');
  return { messages: new MessagesApi(client), client, debug, MaxError };
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
