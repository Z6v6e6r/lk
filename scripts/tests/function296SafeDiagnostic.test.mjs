import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { FUNCTION296_SAFE_DIAGNOSTIC, patchFunction296Flow, replaceFunction296Warning } from '../lib/function296_safe_diagnostic.mjs';
import { sha256 } from '../lib/function98_safe_diagnostic.mjs';
import { composeFunction296Candidate } from '../patch_live_function296_safe_diagnostic.mjs';

// Synthetic source only. The credential-bearing production function stays outside Git.
const source = `const endpoint = msg.inputUrl;
node.warn(endpoint);
msg.url = endpoint;
return msg;`;
function fixture() {
  return [
    { id: 'fixture-tab', type: 'tab', disabled: false },
    { id: 'fixture-trigger', type: 'inject', z: 'fixture-tab', crontab: '30 18 * * *',
      once: false, repeat: '', wires: [['fixture-target']] },
    { id: 'fixture-target', type: 'function', name: 'function 296', z: 'fixture-tab',
      func: source, outputs: 1, wires: [['fixture-http', 'fixture-debug']] },
    { id: 'fixture-http', type: 'http request', method: 'GET', ret: 'obj', url: '', wires: [[]] },
    { id: 'fixture-debug', type: 'debug', active: false, complete: 'true', console: false },
    { id: 'fixture-other', type: 'function', func: 'return msg;', wires: [] },
  ];
}
const options = { expectedFunctionSha256: sha256(source), expectedNodeSha256: sha256('fixture-target') };
function run(body, input) {
  const msg = structuredClone(input), warnings = [];
  const result = vm.runInNewContext(`(function(msg, node) { ${body}\n})(msg, node)`,
    { msg, node: { warn: value => warnings.push(value) } }, { timeout: 1000 });
  return { msg, result, warnings };
}

test('URL logging trigger is removed for normal, encoded and forged-log inputs without changing request', () => {
  const patched = replaceFunction296Warning(source);
  for (const inputUrl of [
    'https://example.invalid/rest/1/synthetic-secret/crm.deal.list?filter=synthetic-private',
    'https://example.invalid/rest/2/other-synthetic-secret/crm.deal.list?token=%250a&filter=%22private%22',
    'https://example.invalid/?next=synthetic\nforged-log-line',
    undefined,
  ]) {
    const input = { inputUrl, payload: { privateValue: 'synthetic-payload' }, headers: { private: 'synthetic-header' } };
    const before = run(source, input), after = run(patched, input);
    assert.equal(before.warnings[0], inputUrl);
    assert.deepEqual(after.warnings, [FUNCTION296_SAFE_DIAGNOSTIC]);
    assert.deepEqual(JSON.parse(after.warnings[0]), {
      event: 'bitrix_deal_list_request_prepared', provider: 'bitrix', operation: 'deal_list', phase: 'request_preparation',
    });
    assert.strictEqual(after.result, after.msg);
    assert.deepEqual(after.msg, before.msg);
    assert.equal(after.msg.url, inputUrl);
    assert.doesNotMatch(after.warnings[0], /https?:|synthetic|private|token|payload|header|forged/);
  }
});

test('exact one-field graph contract preserves inject, schedule, HTTP configuration and unrelated nodes', () => {
  const flow = fixture(), before = structuredClone(flow), bytes = Buffer.from(JSON.stringify(flow));
  assert.throws(() => patchFunction296Flow(flow), /preimage drift/);
  const built = composeFunction296Candidate(bytes, sha256(bytes), options);
  const after = JSON.parse(built.candidateBytes);
  assert.deepEqual(flow, before);
  assert.deepEqual(after[1], before[1]);
  assert.deepEqual(after[3], before[3]);
  assert.notEqual(after[2].func, before[2].func);
  after[2].func = before[2].func;
  assert.deepEqual(after, before);
  assert.equal(built.report.changedFieldCount, 1);
  assert.equal(built.report.scheduleUnchanged, true);
  assert.equal(built.report.httpConfigurationUnchanged, true);
  assert.throws(() => composeFunction296Candidate(bytes, '0'.repeat(64), options), /Flow preimage drift/);
  const invalid = Buffer.from('{synthetic-private-malformed');
  assert.throws(() => composeFunction296Candidate(invalid, sha256(invalid), options), /^Error: Invalid flow JSON$/);
});

test('drifted, ambiguous or unsafe input is refused without changing source flow', () => {
  for (const mutate of [
    f => { f[2].func += '\n// drift'; },
    f => { f[2].id = 'other-target'; },
    f => { f.push({ ...f[2], id: 'other-target' }); },
    f => { f.push({ ...f[0] }); },
    f => { f[2].name = 'other-name'; },
    f => { f[0].disabled = true; },
    f => { f[2].d = true; },
    f => { f[1].once = true; },
    f => { f[1].crontab = '0 1 * * *'; },
    f => { f[1].repeat = '60'; },
    f => { f[1].d = true; },
    f => { f[1].z = 'other-tab'; },
    f => { f[1].wires = [[]]; },
    f => { f[5].wires = [['fixture-target']]; },
    f => { f[3].method = 'POST'; },
    f => { f[3].ret = 'txt'; },
    f => { f[3].url = 'https://example.invalid/override'; },
    f => { f[3].d = true; },
    f => { f[4].active = true; },
    f => { delete f[4].active; },
    f => { f[2].wires[0].push('fixture-other'); },
  ]) {
    const flow = fixture(); mutate(flow); const before = structuredClone(flow);
    assert.throws(() => patchFunction296Flow(flow, options));
    assert.deepEqual(flow, before);
  }
  const once = patchFunction296Flow(fixture(), options).candidate;
  assert.throws(() => patchFunction296Flow(once, options), /preimage drift/);
});

test('warning-anchor drift and unsafe serialization fail closed with sanitized syntax errors', () => {
  for (const body of [source + '\nnode.warn(endpoint);',
    source.replace('node.warn(endpoint);', 'node.warn(msg);'),
    source.replace('node.warn(endpoint);', 'node.warn(JSON.stringify(msg));'),
    source.replace('msg.url = endpoint;', ''),
  ]) assert.throws(() => replaceFunction296Warning(body));
  assert.throws(() => replaceFunction296Warning(source + '\nconst syntheticPrivate = ;'),
    /^Error: Candidate function syntax invalid$/);
});

test('CLI does not echo untrusted paths or accept source-pin bypass arguments', () => {
  for (const args of [
    ['--workspace', '/synthetic-private-marker', '--expected-flow-sha256', '0'.repeat(64)],
    ['--expectedFunctionSha256', 'synthetic-private-marker'],
    ['--workspace', '/synthetic-private-marker', '--workspace', '/synthetic-other-marker'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/patch_live_function296_safe_diagnostic.mjs', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Function296 diagnostic patch refused; check source and workspace guards\n');
  }
});
