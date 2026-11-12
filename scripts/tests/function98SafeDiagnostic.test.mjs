import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { FUNCTION98_SAFE_DIAGNOSTIC, patchFunction98Flow, replaceFunction98Warning, sha256 } from '../lib/function98_safe_diagnostic.mjs';
import { composeFunction98Candidate, writePrivateCandidate } from '../patch_live_function98_safe_diagnostic.mjs';

// Reserved .invalid host and synthetic values only; never copy the live source.
const source = `const endpoint = msg.inputUrl;
node.warn(endpoint);
msg.url = endpoint;
return msg;`;
function run(body, inputUrl) {
  const warnings = [];
  const msg = { inputUrl, payload: { privateValue: 'synthetic-private-marker' } };
  const result = vm.runInNewContext(`(function(msg, node) { ${body}\n})(msg, node)`,
    { msg, node: { warn: value => warnings.push(value) } }, { timeout: 1000 });
  return { warnings, msg, result };
}
function fixture() {
  return [
    { id: 'fixture-tab', type: 'tab', disabled: false },
    { id: 'fixture-target', type: 'function', name: 'function 98', z: 'fixture-tab', func: source,
      outputs: 1, wires: [['fixture-http', 'fixture-debug']] },
    { id: 'fixture-http', type: 'http request', method: 'GET', url: '', wires: [[]] },
    { id: 'fixture-debug', type: 'debug', active: false, complete: 'true', console: false },
    { id: 'fixture-other', type: 'function', func: 'return msg;', wires: [] },
  ];
}
const options = { expectedFunctionSha256: sha256(source) };

test('original synthetic trigger logs the URL; fix emits constant diagnostic and preserves request/message', () => {
  const urls = [
    'https://example.invalid/rest/1/synthetic-webhook-marker/crm.deal.list?filter=synthetic-query-marker',
    'https://example.invalid/rest/2/other-synthetic-marker/crm.deal.list?token=%250a&filter=%22private%22',
    'https://example.invalid/?next=synthetic\nforged-log-line',
    undefined,
  ];
  const patched = replaceFunction98Warning(source);
  assert.equal(patched, source.replace('node.warn(endpoint);', `node.warn(${JSON.stringify(FUNCTION98_SAFE_DIAGNOSTIC)});`));
  for (const url of urls) {
    const before = run(source, url), after = run(patched, url);
    assert.equal(before.warnings[0], url);
    assert.deepEqual(after.warnings, [FUNCTION98_SAFE_DIAGNOSTIC]);
    assert.strictEqual(after.result, after.msg);
    assert.deepEqual(after.msg, before.msg);
    assert.equal(after.msg.url, url);
    assert.deepEqual(JSON.parse(after.warnings[0]), {
      event: 'bitrix_deal_list_request_prepared', provider: 'bitrix', operation: 'deal_list', phase: 'request_preparation',
    });
  }
});

test('one-field candidate preserves every other node, field and topology; production pin refuses fixture', () => {
  const flow = fixture(), before = structuredClone(flow);
  assert.throws(() => patchFunction98Flow(flow), /preimage drift/);
  const bytes = Buffer.from(JSON.stringify(flow));
  const built = composeFunction98Candidate(bytes, sha256(bytes), options);
  const after = JSON.parse(built.candidateBytes);
  assert.deepEqual(flow, before);
  assert.notEqual(after[1].func, before[1].func);
  after[1].func = before[1].func;
  assert.deepEqual(after, before);
  assert.equal(built.report.changedFieldCount, 1);
  assert.equal(built.report.topologyUnchanged, true);
  assert.throws(() => composeFunction98Candidate(bytes, '0'.repeat(64), options), /Flow preimage drift/);
  assert.throws(() => composeFunction98Candidate(Buffer.from('{invalid-private-marker'), sha256('{invalid-private-marker'), options), /Invalid flow JSON/);
});

test('unknown, repeated, ambiguous and unsafe-boundary preimages fail without mutating input', () => {
  for (const mutate of [
    flow => { flow[1].func += '\n// drift'; },
    flow => { flow.push({ ...flow[1], id: 'fixture-duplicate-name' }); },
    flow => { flow[3].active = true; },
    flow => { delete flow[3].active; },
    flow => { flow[2].method = 'POST'; },
    flow => { flow[0].disabled = true; },
    flow => { flow[1].d = true; },
    flow => { flow[1].wires[0].push('fixture-other'); },
    flow => { flow.push({ ...flow[0] }); },
  ]) {
    const flow = fixture(); mutate(flow); const before = structuredClone(flow);
    assert.throws(() => patchFunction98Flow(flow, options));
    assert.deepEqual(flow, before);
  }
  const once = patchFunction98Flow(fixture(), options).candidate;
  assert.throws(() => patchFunction98Flow(once, options), /preimage drift/);
  for (const body of [source + '\nnode.warn(endpoint);', source.replace('node.warn(endpoint);', 'node.warn(msg);'),
    source.replace('node.warn(endpoint);', 'node.warn(JSON.stringify(msg));'), source.replace('msg.url = endpoint;', '')]) {
    assert.throws(() => replaceFunction98Warning(body));
  }
});

test('private candidate output rejects aliases/overwrite/workspace/repository and preserves input', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'function98-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
  const output = path.join(root, 'candidate.json');
  writePrivateCandidate(output, Buffer.from('synthetic'), workspace);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.throws(() => writePrivateCandidate(output, Buffer.from('overwrite'), workspace));
  const alias = path.join(root, 'alias.json'); fs.symlinkSync(output, alias);
  assert.throws(() => writePrivateCandidate(alias, Buffer.from('alias'), workspace));
  assert.equal(fs.readFileSync(output, 'utf8'), 'synthetic');
  assert.throws(() => writePrivateCandidate(path.join(workspace, 'new.json'), Buffer.from('x'), workspace));
  const dirAlias = path.join(root, 'dir-alias'); fs.symlinkSync(root, dirAlias);
  assert.throws(() => writePrivateCandidate(path.join(dirAlias, 'new.json'), Buffer.from('x'), workspace));
  for (const kind of ['main-checkout', 'linked-checkout']) {
    const checkout = path.join(root, kind), parent = path.join(checkout, 'private-output');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
    if (kind === 'main-checkout') fs.mkdirSync(path.join(checkout, '.git'));
    else fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: /synthetic/common/worktrees/linked\n');
    const candidate = path.join(parent, 'candidate.json');
    assert.throws(() => writePrivateCandidate(candidate, Buffer.from('x'), workspace), /external output required/);
    assert.equal(fs.existsSync(candidate), false);
  }
});

test('CLI refuses invalid workspace with a constant error, no secret-bearing path in output', () => {
  const result = spawnSync(process.execPath, ['scripts/patch_live_function98_safe_diagnostic.mjs',
    '--workspace', '/synthetic-private-path-marker', '--expected-flow-sha256', '0'.repeat(64)], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Function98 diagnostic patch refused; check source and workspace guards\n');
});
