import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { composeLegacyStartupRetirement, retirementNodeHash } from '../prepare_legacy_startup_retirement.mjs';

const approved = JSON.parse(fs.readFileSync(new URL('../legacy_startup_retirement/bindings.json', import.meta.url), 'utf8'));
const sha = x => createHash('sha256').update(x).digest('hex');
function fixture() {
  const cohort = Object.entries(approved).map(([role, pin]) => ({ id: `fixture-${role}`, type: pin.type,
    ...(pin.type === 'inject' ? { once: true, crontab: '* * * * *' } : {}),
    ...(pin.type === 'function' ? { func: 'return msg;' } : {}), wires: [] }));
  const byRole = Object.fromEntries(cohort.map(n => [n.id.slice(8), n]));
  byRole.email_trigger.wires = [[byRole.email_send.id]];
  byRole.email_send.transport = byRole.email_transport.id;
  byRole.email_send.wires = [[byRole.email_debug.id]];
  const chain = ['counter_trigger', 'counter_builder', 'counter_read', 'counter_transform', 'counter_write', 'counter_debug'];
  chain.slice(0, -1).forEach((r, i) => { byRole[r].wires = [[byRole[chain[i + 1]].id]]; });
  const flow = [...cohort, { id: 'fixture-business-route', type: 'http in', url: '/synthetic', wires: [[]] },
    { id: 'fixture-working-bot', type: 'telegram bot' }, { id: 'fixture-working-sender', type: 'telegram sender', bot: 'fixture-working-bot' }];
  const bindings = Object.fromEntries(Object.entries(byRole).map(([r, n]) => [r, { type: n.type, identityHash: sha(n.id), nodeSha256: retirementNodeHash(n) }]));
  return { flow, bindings };
}
function run(flow, bindings, expectedSourceSha256) {
  const bytes = Buffer.from(JSON.stringify(flow));
  return composeLegacyStartupRetirement(bytes, { bindings, expectedSourceSha256: expectedSourceSha256 ?? sha(bytes) });
}
test('retires the complete 14-node cohort, preserving every unrelated value and input', () => {
  const { flow, bindings } = fixture(); const before = structuredClone(flow); const result = run(flow, bindings);
  assert.deepEqual(flow, before);
  assert.deepEqual(result.candidate, before.slice(14));
  assert.equal(result.receipt.removed.length, 14);
  assert.equal(result.receipt.deploymentAuthorized, false);
  assert.equal(result.candidate.some(n => ['inject', 'email-send', 'email-transport', 'http request'].includes(n.type)), false);
  assert.equal(/fixture-|\/synthetic/.test(JSON.stringify(result.receipt)), false);
});
for (const kind of ['wire', 'config', 'link', 'nested', 'source']) test(`rejects an outside ${kind} dependency without partial result`, () => {
  const { flow, bindings } = fixture(); const id = flow[0].id;
  const props = { wire: { wires: [[id]] }, config: { bot: id }, link: { links: [id] }, nested: { env: [{ value: id }] }, source: { func: `return global.get('${id}');` } };
  flow.push({ id: 'fixture-outside', type: 'function', ...props[kind] });
  assert.throws(() => run(flow, bindings), /RETIREMENT_EXTERNAL_REFERENCE/);
});
for (const field of ['func', 'initialize', 'finalize']) test(`holds for unresolved dynamic lookup in ${field}`, () => {
  const { flow, bindings } = fixture(); flow.push({ id: 'fixture-outside', type: 'function', [field]: 'RED.nodes.getNode(msg.target);' });
  assert.throws(() => run(flow, bindings), /RETIREMENT_DYNAMIC_LOOKUP_REVIEW_REQUIRED/);
});
for (const expression of ["RED['nodes'][msg.method](msg.target);", 'RED?.nodes?.[msg.method](msg.target);', "global.get('RED')[msg.method](msg.target);", "api['getNode'](msg.target);"]) test(`holds for bracket/optional/aliased runtime lookup: ${expression}`, () => {
  const { flow, bindings } = fixture(); flow.push({ id: 'fixture-outside', type: 'function', func: expression });
  assert.throws(() => run(flow, bindings), /DYNAMIC_LOOKUP_REVIEW_REQUIRED/);
});
test('comments and non-runtime color property names do not create a false lookup', () => {
  const { flow, bindings } = fixture(); flow.push({ id: 'fixture-colors', type: 'function', func: '// RED.nodes.getNode is deliberately unavailable\nconst colors = { RED: 1 }; msg.color = colors.RED; return msg;' });
  assert.equal(run(flow, bindings).candidate.length, 4);
});
test('a lexically resolved local const RED scalar is not the runtime API', () => {
  const { flow, bindings } = fixture(); flow.push({ id: 'fixture-colors', type: 'function', func: "const RED = 'synthetic-color'; msg.color = RED; return msg;" });
  assert.equal(run(flow, bindings).candidate.length, 4);
});
test('standard node constructor registration is distinct from node lookup', () => {
  const { flow, bindings } = fixture(); flow.push({ id: 'fixture-registration', type: 'function', func: "function register(RED) { RED.nodes.createNode(this, {}); RED.nodes.registerType('synthetic', function(){}); } return msg;" });
  assert.equal(run(flow, bindings).candidate.length, 4);
});
for (const expression of ['function f(RED){ return RED.nodes; }', 'function f(RED){ RED.nodes[msg.method](msg.target); }', 'function f(RED){ return RED; }']) test('registry API cannot escape or select a dynamic method', () => {
  const { flow, bindings } = fixture(); flow.push({ id: 'fixture-outside', type: 'function', func: expression });
  assert.throws(() => run(flow, bindings), /DYNAMIC_LOOKUP_REVIEW_REQUIRED/);
});
for (const field of ['func', 'initialize', 'finalize']) for (const expression of [
  'runtime[`getNode`](msg.target);', 'global.get(`RED`).nodes[msg.method](msg.target);',
  "const RED = 'color'; function inner(RED){ return RED[msg.method](msg.target); } inner(msg.runtime);",
  'const RED = msg.runtime; RED[msg.method](msg.target);',
]) test(`holds template members and shadowed/non-scalar RED in ${field}`, () => {
  const { flow, bindings } = fixture(); flow.push({ id: 'fixture-outside', type: 'function', [field]: expression });
  assert.throws(() => run(flow, bindings), /DYNAMIC_LOOKUP_REVIEW_REQUIRED/);
});
test('requires reviewed whole-source and exact target preimages', () => {
  const { flow, bindings } = fixture();
  assert.throws(() => run(flow, bindings, '0'.repeat(64)), /SOURCE_DRIFT/);
  flow[0].name = 'moved'; assert.throws(() => run(flow, bindings), /NODE_DRIFT/);
});
test('rejects missing/duplicate target IDs and incomplete or aliased bindings', () => {
  const { flow, bindings } = fixture();
  assert.throws(() => run(flow.slice(1), bindings), /NODE_DRIFT/);
  assert.throws(() => run([...flow, flow[0]], bindings), /INVALID_FLOW/);
  const incomplete = { ...bindings }; delete incomplete.telegram_a;
  assert.throws(() => run(flow, incomplete), /BINDING_SET/);
  assert.throws(() => run(flow, { ...bindings, telegram_b: bindings.telegram_a }), /BINDING_INVALID/);
});
test('an unrelated change is preserved when the caller reviews its new whole-source hash', () => {
  const { flow, bindings } = fixture(); flow.at(-2).setting = 'synthetic-new-value';
  assert.deepEqual(run(flow, bindings).candidate, flow.slice(14));
});
